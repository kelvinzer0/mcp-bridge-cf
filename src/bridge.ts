import { DurableObject } from "cloudflare:workers"
import type {
  ExtensionMessage,
  WorkerMessage,
  ToolResult,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
} from "./types"

interface StoredTool {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

interface PendingCall {
  resolve: (r: ToolResult) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * MCP Bridge Durable Object — minimal WebSocket test
 */
export class MCPBridge extends DurableObject {
  private tools = new Map<string, StoredTool>()
  private extensionWs: WebSocket | null = null
  private pendingCalls = new Map<string, PendingCall>()
  private sseWriters = new Map<string, WritableStreamDefaultWriter>()
  private extensionConnected = false

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === "/ws/extension" || url.pathname.endsWith("/ws/extension")) {
      const upgrade = request.headers.get("Upgrade")
      if (upgrade !== "websocket") {
        return new Response("Expected websocket", { status: 426 })
      }

      // Exact pattern from CF docs
      const webSocketPair = new WebSocketPair()
      const [client, server] = Object.values(webSocketPair)

      this.ctx.acceptWebSocket(server)

      this.extensionWs = server
      this.extensionConnected = true

      return new Response(null, { status: 101, webSocket: client })
    }

    if (url.pathname === "/mcp" || url.pathname.endsWith("/mcp")) {
      return this.handleMcp(request)
    }

    if (url.pathname === "/health" || url.pathname.endsWith("/health")) {
      const room = url.searchParams.get("room") || "default"
      return Response.json({
        status: "ok",
        room,
        extensionConnected: this.extensionConnected,
        toolsRegistered: this.tools.size,
        tools: Array.from(this.tools.keys()),
      })
    }

    return new Response("Not Found", { status: 404 })
  }

  // Hibernation API callbacks
  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    try {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message)
      const msg = JSON.parse(text) as ExtensionMessage
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
      console.error("Bad message:", err)
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    this.extensionWs = null
    this.extensionConnected = false
    this.tools.clear()
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error("WS error:", error)
    this.extensionWs = null
    this.extensionConnected = false
  }

  // MCP protocol
  private handleMcp(request: Request): Response | Promise<Response> {
    if (request.method === "GET") return this.openSse()
    if (request.method === "POST") return this.handleJsonRpc(request)
    return new Response("Method Not Allowed", { status: 405 })
  }

  private openSse(): Response {
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

  private async handleJsonRpc(request: Request): Promise<Response> {
    let body: JsonRpcRequest
    try { body = await request.json() } catch {
      return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 })
    }
    if (body.id === undefined) return new Response(null, { status: 202 })

    const resp = await this.dispatch(body)
    return Response.json(resp)
  }

  private async dispatch(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    switch (req.method) {
      case "initialize":
        return { jsonrpc: "2.0", id: req.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "mcp-bridge", version: "0.1.0" } } }
      case "tools/list":
        return { jsonrpc: "2.0", id: req.id, result: { tools: Array.from(this.tools.values()).map(t => ({ name: t.name, description: t.description || "", inputSchema: t.inputSchema || { type: "object", properties: {} } })) } }
      case "tools/call": {
        const p = req.params as { name: string; arguments?: Record<string, unknown> } | undefined
        if (!p?.name || !this.tools.has(p.name)) return { jsonrpc: "2.0", id: req.id, error: { code: -32602, message: `Unknown tool: ${p?.name}` } }
        if (!this.extensionWs) return { jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: "Tool provider not connected" }], isError: true } }
        try {
          const result = await this.callTool(p.name, p.arguments || {})
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

  private callTool(name: string, params: Record<string, unknown>): Promise<ToolResult> {
    return new Promise((resolve, reject) => {
      const callId = crypto.randomUUID()
      const timer = setTimeout(() => { this.pendingCalls.delete(callId); reject(new Error(`Timeout: ${name}`)) }, 60000)
      this.pendingCalls.set(callId, { resolve, reject, timer })
      this.extensionWs!.send(JSON.stringify({ type: "callTool", callId, name, params }))
    })
  }
}
