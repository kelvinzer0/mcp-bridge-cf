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

interface StoredSession {
  tools: Map<string, StoredTool>
  extensionConnected: boolean
  initialized: boolean
  clientInfo?: { name: string; version: string }
}

interface PendingCall {
  resolve: (r: ToolResult) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * MCP Bridge Durable Object
 */
export class MCPBridge extends DurableObject {
  private session: StoredSession = {
    tools: new Map(),
    extensionConnected: false,
    initialized: false,
  }

  private extensionWs: WebSocket | null = null
  private pendingCalls: Map<string, PendingCall> = new Map()
  private sseWriters: Map<string, WritableStreamDefaultWriter> = new Map()

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    // WebSocket upgrade for extension
    if (url.pathname === "/ws/extension" || url.pathname.endsWith("/ws/extension")) {
      const upgradeHeader = request.headers.get("Upgrade")
      if (!upgradeHeader || upgradeHeader !== "websocket") {
        return new Response("Expected websocket", { status: 426 })
      }

      // Create WebSocket pair
      const webSocketPair = new WebSocketPair()
      const [client, server] = [webSocketPair[0], webSocketPair[1]]

      // Accept the server side
      this.handleWebSocketConnection(server)

      // Return the client side
      return new Response(null, {
        status: 101,
        webSocket: client,
      })
    }

    if (url.pathname === "/mcp" || url.pathname.endsWith("/mcp")) {
      return this.handleMcp(request)
    }

    if (url.pathname === "/health" || url.pathname.endsWith("/health")) {
      const room = url.searchParams.get("room") || "default"
      return Response.json({
        status: "ok",
        room,
        extensionConnected: this.session.extensionConnected,
        toolsRegistered: this.session.tools.size,
        tools: Array.from(this.session.tools.keys()),
      })
    }

    return new Response("Not Found", { status: 404 })
  }

  // ============================================================
  //  WEBSOCKET HANDLING
  // ============================================================

  private handleWebSocketConnection(ws: WebSocket) {
    // Accept the WebSocket using legacy API
    ws.accept()

    // Clean up previous connection
    if (this.extensionWs) {
      try {
        this.extensionWs.close(4000, "Replaced")
      } catch {
        // ignore
      }
    }

    this.extensionWs = ws
    this.session.extensionConnected = true

    ws.addEventListener("message", (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data as string) as ExtensionMessage
        this.onExtensionMessage(msg)
      } catch (err) {
        console.error("Bad extension message:", err)
      }
    })

    ws.addEventListener("close", () => {
      this.extensionWs = null
      this.session.extensionConnected = false
      this.clearDynamicTools()
      this.rejectAllPending("Extension disconnected")
    })

    ws.addEventListener("error", (event) => {
      console.error("WebSocket error:", event)
    })
  }

  // ============================================================
  //  EXTENSION MESSAGE HANDLING
  // ============================================================

  private onExtensionMessage(msg: ExtensionMessage) {
    switch (msg.type) {
      case "registerTools":
        for (const tool of msg.tools) {
          this.session.tools.set(tool.name, tool)
        }
        this.notifyToolsChanged()
        break

      case "unregisterTools":
        for (const name of msg.names) {
          this.session.tools.delete(name)
        }
        this.notifyToolsChanged()
        break

      case "toolResult":
        this.resolvePendingCall(msg.callId, msg.result)
        break

      case "pong":
        break
    }
  }

  private clearDynamicTools() {
    this.session.tools.clear()
    this.notifyToolsChanged()
  }

  // ============================================================
  //  MCP PROTOCOL
  // ============================================================

  private handleMcp(request: Request): Response | Promise<Response> {
    if (request.method === "GET") {
      return this.openSseStream()
    }

    if (request.method === "POST") {
      return this.handleJsonRpc(request)
    }

    return new Response("Method Not Allowed", { status: 405 })
  }

  private openSseStream(): Response {
    const streamId = crypto.randomUUID()
    const { readable, writable } = new TransformStream<Uint8Array>()
    const writer = writable.getWriter()
    const encoder = new TextEncoder()

    this.sseWriters.set(streamId, writer)

    const heartbeat = setInterval(() => {
      writer.write(encoder.encode(":\n\n")).catch(() => clearInterval(heartbeat))
    }, 30000)

    const cleanup = () => {
      clearInterval(heartbeat)
      this.sseWriters.delete(streamId)
      writer.close().catch(() => {})
    }

    const responseStream = new ReadableStream({
      start(controller) {
        const reader = readable.getReader()
        const pump = (): Promise<void> =>
          reader.read().then(({ done, value }) => {
            if (done) {
              controller.close()
              return
            }
            controller.enqueue(value)
            return pump()
          })
        pump().catch(() => controller.close())
      },
      cancel() {
        cleanup()
      },
    })

    return new Response(responseStream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    })
  }

  private async handleJsonRpc(request: Request): Promise<Response> {
    const accept = request.headers.get("Accept") || ""

    let body: JsonRpcRequest
    try {
      body = (await request.json()) as JsonRpcRequest
    } catch {
      return Response.json(
        { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } } satisfies JsonRpcResponse,
        { status: 400 }
      )
    }

    if (body.id === undefined) {
      this.handleNotification(body as JsonRpcNotification)
      return new Response(null, { status: 202 })
    }

    const response = await this.handleRequest(body)

    if (accept.includes("text/event-stream")) {
      return this.streamResponse(response)
    }

    return Response.json(response)
  }

  private streamResponse(response: JsonRpcResponse): Response {
    const encoder = new TextEncoder()
    const data = `event: message\ndata: ${JSON.stringify(response)}\n\n`

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(data))
        controller.close()
      },
    })

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    })
  }

  // ============================================================
  //  JSON-RPC HANDLERS
  // ============================================================

  private handleRequest(req: JsonRpcRequest): JsonRpcResponse | Promise<JsonRpcResponse> {
    switch (req.method) {
      case "initialize":
        return this.handleInitialize(req)
      case "tools/list":
        return this.handleToolsList(req)
      case "tools/call":
        return this.handleToolsCall(req)
      case "ping":
        return { jsonrpc: "2.0", id: req.id, result: {} }
      default:
        return {
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32601, message: `Method not found: ${req.method}` },
        }
    }
  }

  private handleNotification(notif: JsonRpcNotification) {
    if (notif.method === "notifications/initialized") {
      this.session.initialized = true
    }
  }

  private handleInitialize(req: JsonRpcRequest): JsonRpcResponse {
    this.session.clientInfo = req.params?.clientInfo as { name: string; version: string }

    return {
      jsonrpc: "2.0",
      id: req.id,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "mcp-bridge-cf", version: "0.1.0" },
      },
    }
  }

  private handleToolsList(req: JsonRpcRequest): JsonRpcResponse {
    const tools = Array.from(this.session.tools.values()).map((t) => ({
      name: t.name,
      description: t.description || "",
      inputSchema: t.inputSchema || { type: "object", properties: {} },
    }))

    return { jsonrpc: "2.0", id: req.id, result: { tools } }
  }

  private async handleToolsCall(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    const params = req.params as { name: string; arguments?: Record<string, unknown> } | undefined
    const name = params?.name
    const args = params?.arguments || {}

    if (!name || !this.session.tools.has(name)) {
      return {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32602, message: `Unknown tool: ${name}` },
      }
    }

    if (!this.extensionWs) {
      return {
        jsonrpc: "2.0",
        id: req.id,
        result: {
          content: [{ type: "text", text: "Error: Tool provider not connected" }],
          isError: true,
        },
      }
    }

    try {
      const result = await this.callExtensionTool(name, args)
      return { jsonrpc: "2.0", id: req.id, result }
    } catch (err) {
      return {
        jsonrpc: "2.0",
        id: req.id,
        result: {
          content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
          isError: true,
        },
      }
    }
  }

  // ============================================================
  //  TOOL CALL FORWARDING
  // ============================================================

  private callExtensionTool(name: string, params: Record<string, unknown>): Promise<ToolResult> {
    return new Promise((resolve, reject) => {
      const callId = crypto.randomUUID()

      const timer = setTimeout(() => {
        this.pendingCalls.delete(callId)
        reject(new Error(`Tool call timeout: ${name}`))
      }, 60000)

      this.pendingCalls.set(callId, { resolve, reject, timer })

      const msg: WorkerMessage = { type: "callTool", callId, name, params }
      this.extensionWs!.send(JSON.stringify(msg))
    })
  }

  private resolvePendingCall(callId: string, result: ToolResult) {
    const pending = this.pendingCalls.get(callId)
    if (pending) {
      clearTimeout(pending.timer)
      this.pendingCalls.delete(callId)
      pending.resolve(result)
    }
  }

  private rejectAllPending(reason: string) {
    for (const [, pending] of this.pendingCalls) {
      clearTimeout(pending.timer)
      pending.reject(new Error(reason))
    }
    this.pendingCalls.clear()
  }

  // ============================================================
  //  SSE NOTIFICATIONS
  // ============================================================

  private notifyToolsChanged() {
    const notification: JsonRpcNotification = {
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
    }

    const encoder = new TextEncoder()
    const data = encoder.encode(`event: message\ndata: ${JSON.stringify(notification)}\n\n`)

    for (const writer of this.sseWriters.values()) {
      writer.write(data).catch(() => {})
    }
  }
}
