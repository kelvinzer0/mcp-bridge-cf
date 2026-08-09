import { DurableObject } from "cloudflare:workers"

export class MCPBridge extends DurableObject {
  private tools = new Map<string, any>()
  private extensionWs: WebSocket | null = null
  private extensionConnected = false
  private pendingCalls = new Map<string, any>()
  private sseWriters = new Map<string, WritableStreamDefaultWriter>()

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === "/health" || url.pathname.endsWith("/health")) {
      return Response.json({
        status: "ok",
        extensionConnected: this.extensionConnected,
        toolsRegistered: this.tools.size,
        tools: Array.from(this.tools.keys()),
      })
    }

    if (url.pathname === "/ws/extension" || url.pathname.endsWith("/ws/extension")) {
      const upgrade = request.headers.get("Upgrade")
      if (upgrade !== "websocket") {
        return new Response("Expected websocket", { status: 426 })
      }

      const pair = new WebSocketPair()
      const client = pair[0]
      const server = pair[1]

      // Use ONLY acceptWebSocket — do NOT use addEventListener
      this.ctx.acceptWebSocket(server)

      this.extensionWs = server
      this.extensionConnected = true

      return new Response(null, { status: 101, webSocket: client })
    }

    if (url.pathname === "/mcp" || url.pathname.endsWith("/mcp")) {
      return this.handleMcp(request)
    }

    return new Response("Not Found", { status: 404 })
  }

  // ─── Hibernation API callbacks ONLY ───

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    try {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message)
      const msg = JSON.parse(text)

      if (msg.type === "registerTools") {
        for (const tool of msg.tools) this.tools.set(tool.name, tool)
      } else if (msg.type === "unregisterTools") {
        for (const name of msg.names) this.tools.delete(name)
      } else if (msg.type === "toolResult") {
        const pending = this.pendingCalls.get(msg.callId)
        if (pending) {
          clearTimeout(pending.timer)
          this.pendingCalls.delete(msg.callId)
          pending.resolve(msg.result)
        }
      } else if (msg.type === "pong") {
        // ignore
      }
    } catch (err) {
      console.error("Bad message:", err)
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    this.extensionWs = null
    this.extensionConnected = false
    this.tools.clear()
    for (const [, pending] of this.pendingCalls) {
      clearTimeout(pending.timer)
      pending.reject(new Error("Disconnected"))
    }
    this.pendingCalls.clear()
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    this.extensionWs = null
    this.extensionConnected = false
  }

  // ─── MCP Protocol ───

  private handleMcp(request: Request): Response | Promise<Response> {
    if (request.method === "GET") {
      const id = crypto.randomUUID()
      const { readable, writable } = new TransformStream<Uint8Array>()
      const writer = writable.getWriter()
      const enc = new TextEncoder()
      this.sseWriters.set(id, writer)
      const hb = setInterval(() => writer.write(enc.encode(":\n\n")).catch(() => clearInterval(hb)), 30000)
      const stream = new ReadableStream({
        start(c) {
          const r = readable.getReader()
          const pump = (): Promise<void> => r.read().then(({ done, value }) => {
            if (done) { c.close(); return }
            c.enqueue(value)
            return pump()
          })
          pump().catch(() => c.close())
        },
        cancel() { clearInterval(hb); writer.close().catch(() => {}) },
      })
      return new Response(stream, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" },
      })
    }

    if (request.method === "POST") {
      return this.handleJsonRpc(request)
    }

    return new Response("Method Not Allowed", { status: 405 })
  }

  private async handleJsonRpc(request: Request): Promise<Response> {
    let body: any
    try { body = await request.json() } catch {
      return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 })
    }

    if (body.id === undefined) return new Response(null, { status: 202 })

    const resp = await this.dispatch(body)
    return Response.json(resp)
  }

  private async dispatch(req: any): Promise<any> {
    switch (req.method) {
      case "initialize":
        return { jsonrpc: "2.0", id: req.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "mcp-bridge", version: "0.1.0" } } }
      case "tools/list":
        return { jsonrpc: "2.0", id: req.id, result: { tools: Array.from(this.tools.values()).map((t: any) => ({ name: t.name, description: t.description || "", inputSchema: t.inputSchema || { type: "object", properties: {} } })) } }
      case "tools/call": {
        const name = req.params?.name
        const args = req.params?.arguments || {}
        if (!name || !this.tools.has(name)) return { jsonrpc: "2.0", id: req.id, error: { code: -32602, message: `Unknown tool: ${name}` } }
        if (!this.extensionWs) return { jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: "Tool provider not connected" }], isError: true } }
        try {
          const result = await this.callTool(name, args)
          return { jsonrpc: "2.0", id: req.id, result }
        } catch (err) {
          return { jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true } }
        }
      }
      case "ping":
        return { jsonrpc: "2.0", id: req.id, result: {} }
      default:
        return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `Method not found: ${req.method}` } }
    }
  }

  private callTool(name: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const callId = crypto.randomUUID()
      const timer = setTimeout(() => { this.pendingCalls.delete(callId); reject(new Error(`Timeout: ${name}`)) }, 60000)
      this.pendingCalls.set(callId, { resolve, reject, timer })
      this.extensionWs!.send(JSON.stringify({ type: "callTool", callId, name, params }))
    })
  }
}
