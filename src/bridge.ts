import { DurableObject } from "cloudflare:workers"

export class MCPBridge extends DurableObject {
  // In-memory state (lost on DO cold start/hibernation)
  private tools = new Map<string, any>()
  private extensionWs: WebSocket | null = null
  private extensionConnected = false
  private pendingCalls = new Map<string, { resolve: Function; reject: Function; timer: any }>()
  private stateRestored = false

  // ── Restore persisted state on wake ──
  private async restoreState(): Promise<void> {
    if (this.stateRestored) return
    this.stateRestored = true
    try {
      const stored = await this.ctx.storage.get<Record<string, any>>("tools")
      if (stored) {
        for (const [k, v] of Object.entries(stored)) this.tools.set(k, v)
      }
      // Recheck actual WS state using hibernation API
      const sockets = this.ctx.getWebSockets()
      if (sockets.length > 0) {
        this.extensionWs = sockets[0]
        this.extensionConnected = true
      } else {
        this.extensionConnected = false
        this.extensionWs = null
      }
    } catch {}
  }

  async fetch(request: Request): Promise<Response> {
    await this.restoreState()
    const url = new URL(request.url)

    // Health
    if (url.pathname === "/health" || url.pathname.endsWith("/health")) {
      // Always check real WS count from hibernation API
      const sockets = this.ctx.getWebSockets()
      const isConnected = sockets.length > 0
      return Response.json({
        status: "ok",
        extensionConnected: isConnected,
        toolsRegistered: this.tools.size,
        tools: Array.from(this.tools.keys()),
      })
    }

    // WebSocket upgrade for extension
    if (url.pathname === "/ws/extension" || url.pathname.endsWith("/ws/extension")) {
      const upgrade = request.headers.get("Upgrade")
      if (upgrade !== "websocket") return new Response("Expected websocket", { status: 426 })

      const pair = new WebSocketPair()
      const client = pair[0]
      const server = pair[1]

      // Hibernation API — survives DO sleep cycles
      this.ctx.acceptWebSocket(server)

      this.extensionWs = server
      this.extensionConnected = true

      return new Response(null, { status: 101, webSocket: client })
    }

    // MCP endpoint
    if (url.pathname === "/mcp" || url.pathname.endsWith("/mcp")) {
      if (request.method === "GET") return this.sse()
      if (request.method === "POST") return await this.rpc(request)
      return new Response("Method Not Allowed", { status: 405 })
    }

    return new Response("Not Found", { status: 404 })
  }

  // Hibernation callbacks
  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    await this.restoreState()
    try {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message)
      const msg = JSON.parse(text)
      if (msg.type === "registerTools") {
        for (const t of msg.tools) this.tools.set(t.name, t)
        // Persist tools to storage so they survive DO hibernation
        await this.ctx.storage.put("tools", Object.fromEntries(this.tools))
      } else if (msg.type === "unregisterTools") {
        for (const n of msg.names) this.tools.delete(n)
        await this.ctx.storage.put("tools", Object.fromEntries(this.tools))
      } else if (msg.type === "toolResult") {
        const p = this.pendingCalls.get(msg.callId)
        if (p) { clearTimeout(p.timer); this.pendingCalls.delete(msg.callId); p.resolve(msg.result) }
      }
    } catch {}
  }

  async webSocketClose(): Promise<void> {
    this.extensionConnected = false
    this.extensionWs = null
    // Clear persisted tools — extension disconnected
    this.tools.clear()
    await this.ctx.storage.delete("tools")
    for (const [, p] of this.pendingCalls) { clearTimeout(p.timer); p.reject(new Error("Extension disconnected")) }
    this.pendingCalls.clear()
  }

  async webSocketError(): Promise<void> {
    await this.webSocketClose()
  }

  private sse(): Response {
    const { readable, writable } = new TransformStream<Uint8Array>()
    const w = writable.getWriter()
    const e = new TextEncoder()

    // MCP-over-SSE: send 'endpoint' event immediately so clients know where to POST
    w.write(e.encode(`event: endpoint\ndata: /mcp\n\n`)).catch(() => {})

    // Heartbeat every 30s to keep connection alive through proxies/CF
    const hb = setInterval(() => w.write(e.encode(":\n\n")).catch(() => clearInterval(hb)), 30000)
    return new Response(new ReadableStream({
      start(c) { const r = readable.getReader(); const p = (): Promise<void> => r.read().then(({ done, value }) => { if (done) { c.close(); return } c.enqueue(value); return p() }); p().catch(() => c.close()) },
      cancel() { clearInterval(hb); w.close().catch(() => {}) },
    }), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*", "X-Accel-Buffering": "no" } })
  }

  private async rpc(request: Request): Promise<Response> {
    await this.restoreState()
    let body: any
    try { body = await request.json() } catch {
      return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 })
    }
    if (body.id === undefined) return new Response(null, { status: 202 })

    // Get actual live WebSocket from hibernation API
    const sockets = this.ctx.getWebSockets()
    const activeWs = sockets.length > 0 ? sockets[0] : null

    let resp: any
    switch (body.method) {
      case "initialize":
        resp = { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "mcp-bridge", version: "0.1.0" } } }
        break
      case "tools/list":
        resp = { jsonrpc: "2.0", id: body.id, result: { tools: Array.from(this.tools.values()).map((t: any) => ({ name: t.name, description: t.description || "", inputSchema: t.inputSchema || { type: "object", properties: {} } })) } }
        break
      case "tools/call": {
        const name = body.params?.name
        const args = body.params?.arguments || {}
        if (!name || !this.tools.has(name)) { resp = { jsonrpc: "2.0", id: body.id, error: { code: -32602, message: `Unknown tool: ${name}` } }; break }
        if (!activeWs) { resp = { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "Extension not connected" }], isError: true } }; break }
        try {
          const result = await new Promise((resolve, reject) => {
            const callId = crypto.randomUUID()
            const timer = setTimeout(() => { this.pendingCalls.delete(callId); reject(new Error(`Timeout: ${name}`)) }, 60000)
            this.pendingCalls.set(callId, { resolve, reject, timer })
            activeWs.send(JSON.stringify({ type: "callTool", callId, name, params: args }))
          })
          resp = { jsonrpc: "2.0", id: body.id, result }
        } catch (err) {
          resp = { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true } }
        }
        break
      }
      case "ping": resp = { jsonrpc: "2.0", id: body.id, result: {} }; break
      default: resp = { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: `Method not found: ${body.method}` } }
    }
    return Response.json(resp)
  }
}
