import { DurableObject } from "cloudflare:workers"

export class MCPBridge extends DurableObject {
  private tools = new Map<string, any>()
  private extensionWs: WebSocket | null = null
  private extensionConnected = false
  private pendingCalls = new Map<string, { resolve: Function; reject: Function; timer: any }>()

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

      // Use server.accept() — NOT this.ctx.acceptWebSocket()
      server.accept()

      if (this.extensionWs) {
        try { this.extensionWs.close(4000, "Replaced") } catch {}
      }

      this.extensionWs = server
      this.extensionConnected = true

      server.addEventListener("message", (event: MessageEvent) => {
        try {
          const msg = JSON.parse(event.data as string)
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
          }
        } catch (err) {
          console.error("Bad msg:", err)
        }
      })

      server.addEventListener("close", () => {
        this.extensionWs = null
        this.extensionConnected = false
        this.tools.clear()
        for (const [, pending] of this.pendingCalls) {
          clearTimeout(pending.timer)
          pending.reject(new Error("Disconnected"))
        }
        this.pendingCalls.clear()
      })

      return new Response(null, { status: 101, webSocket: client })
    }

    if (url.pathname === "/mcp" || url.pathname.endsWith("/mcp")) {
      if (request.method === "GET") {
        const { readable, writable } = new TransformStream<Uint8Array>()
        const writer = writable.getWriter()
        const enc = new TextEncoder()
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
          if (!name || !this.tools.has(name)) {
            resp = { jsonrpc: "2.0", id: body.id, error: { code: -32602, message: `Unknown tool: ${name}` } }
          } else if (!this.extensionWs) {
            resp = { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "Not connected" }], isError: true } }
          } else {
            try {
              const result = await new Promise((resolve, reject) => {
                const callId = crypto.randomUUID()
                const timer = setTimeout(() => { this.pendingCalls.delete(callId); reject(new Error(`Timeout: ${name}`)) }, 60000)
                this.pendingCalls.set(callId, { resolve, reject, timer })
                this.extensionWs!.send(JSON.stringify({ type: "callTool", callId, name, params: body.params?.arguments || {} }))
              })
              resp = { jsonrpc: "2.0", id: body.id, result }
            } catch (err) {
              resp = { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true } }
            }
          }
          break
        }
        case "ping":
          resp = { jsonrpc: "2.0", id: body.id, result: {} }
          break
        default:
          resp = { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: `Method not found: ${body.method}` } }
      }
      return Response.json(resp)
    }

    return new Response("Not Found", { status: 404 })
  }
}
