import { DurableObject } from "cloudflare:workers"

export class MCPBridge extends DurableObject {
  private tools = new Map<string, any>()
  private extensionWs: WebSocket | null = null
  private extensionConnected = false
  private pendingCalls = new Map<string, { resolve: Function; reject: Function; timer: any }>()

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    // Health
    if (url.pathname === "/health" || url.pathname.endsWith("/health")) {
      return Response.json({
        status: "ok",
        extensionConnected: this.extensionConnected,
        toolsRegistered: this.tools.size,
        tools: Array.from(this.tools.keys()),
      })
    }

    // WebSocket
    if (url.pathname === "/ws/extension" || url.pathname.endsWith("/ws/extension")) {
      const upgrade = request.headers.get("Upgrade")
      if (upgrade !== "websocket") return new Response("Expected websocket", { status: 426 })

      const pair = new WebSocketPair()
      const client = pair[0]
      const server = pair[1]

      // Hibernation API
      this.ctx.acceptWebSocket(server)

      this.extensionWs = server
      this.extensionConnected = true

      return new Response(null, { status: 101, webSocket: client })
    }

    // MCP
    if (url.pathname === "/mcp" || url.pathname.endsWith("/mcp")) {
      if (request.method === "GET") return this.sse()
      if (request.method === "POST") return await this.rpc(request)
      return new Response("Method Not Allowed", { status: 405 })
    }

    return new Response("Not Found", { status: 404 })
  }

  // Hibernation callbacks
  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    try {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message)
      const msg = JSON.parse(text)
      if (msg.type === "registerTools") {
        for (const t of msg.tools) this.tools.set(t.name, t)
      } else if (msg.type === "unregisterTools") {
        for (const n of msg.names) this.tools.delete(n)
      } else if (msg.type === "toolResult") {
        const p = this.pendingCalls.get(msg.callId)
        if (p) { clearTimeout(p.timer); this.pendingCalls.delete(msg.callId); p.resolve(msg.result) }
      }
    } catch {}
  }

  async webSocketClose(): Promise<void> {
    this.extensionWs = null
    this.extensionConnected = false
    this.tools.clear()
    for (const [, p] of this.pendingCalls) { clearTimeout(p.timer); p.reject(new Error("Disconnected")) }
    this.pendingCalls.clear()
  }

  async webSocketError(): Promise<void> {
    await this.webSocketClose()
  }

  private sse(): Response {
    const { readable, writable } = new TransformStream<Uint8Array>()
    const w = writable.getWriter()
    const e = new TextEncoder()
    const hb = setInterval(() => w.write(e.encode(":\n\n")).catch(() => clearInterval(hb)), 30000)
    return new Response(new ReadableStream({
      start(c) { const r = readable.getReader(); const p = (): Promise<void> => r.read().then(({ done, value }) => { if (done) { c.close(); return } c.enqueue(value); return p() }); p().catch(() => c.close()) },
      cancel() { clearInterval(hb); w.close().catch(() => {}) },
    }), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" } })
  }

  private async rpc(request: Request): Promise<Response> {
    let body: any
    try { body = await request.json() } catch {
      return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 })
    }
    if (body.id === undefined) return new Response(null, { status: 202 })

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
        if (!this.extensionWs) { resp = { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "Not connected" }], isError: true } }; break }
        try {
          const result = await new Promise((resolve, reject) => {
            const callId = crypto.randomUUID()
            const timer = setTimeout(() => { this.pendingCalls.delete(callId); reject(new Error(`Timeout: ${name}`)) }, 60000)
            this.pendingCalls.set(callId, { resolve, reject, timer })
            this.extensionWs!.send(JSON.stringify({ type: "callTool", callId, name, params: args }))
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
