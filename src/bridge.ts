import { DurableObject } from "cloudflare:workers"
import type {
  ExtensionMessage,
  WorkerMessage,
  ToolDefinition,
  ToolResult,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  SessionState,
} from "./types"

/**
 * MCP Bridge Durable Object
 *
 * Bridges browser extension (WebSocket) with MCP clients (Streamable HTTP).
 * Extension registers tools dynamically, MCP client discovers and calls them.
 */
export class MCPBridge extends DurableObject {
  private state: SessionState = {
    tools: new Map(),
    extensionConnected: false,
    initialized: false,
  }

  private extensionWs: WebSocket | null = null
  private pendingCalls: Map<
    string,
    { resolve: (r: ToolResult) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  > = new Map()

  // SSE streams for MCP clients waiting on long-lived connections
  private sseControllers: Map<string, ReadableStreamDefaultController> = new Map()

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env)
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    // --- WebSocket: Extension connection ---
    if (url.pathname === "/ws/extension" || url.pathname.endsWith("/ws/extension")) {
      const upgrade = request.headers.get("Upgrade")
      if (upgrade !== "websocket") {
        return new Response("Expected WebSocket upgrade", { status: 426 })
      }
      const pair = new WebSocketPair()
      this.handleExtension(pair[1])
      return new Response(null, { status: 101, webSocket: pair[0] })
    }

    // --- Streamable HTTP: MCP client ---
    if (url.pathname === "/mcp" || url.pathname.endsWith("/mcp")) {
      return this.handleMcp(request)
    }

    // --- Health ---
    if (url.pathname === "/health" || url.pathname.endsWith("/health")) {
      return Response.json({
        status: "ok",
        extensionConnected: this.state.extensionConnected,
        toolsRegistered: this.state.tools.size,
        tools: Array.from(this.state.tools.keys()),
      })
    }

    return new Response("Not Found", { status: 404 })
  }

  // ============================================================
  //  EXTENSION WEBSOCKET HANDLING
  // ============================================================

  private handleExtension(ws: WebSocket) {
    // Kick previous connection if any
    if (this.extensionWs) {
      try { this.extensionWs.close(4000, "Replaced by new connection") } catch {}
    }

    this.extensionWs = ws
    this.state.extensionConnected = true
    this.ctx.acceptWebSocket(ws)

    ws.addEventListener("message", (event) => {
      try {
        const msg: ExtensionMessage = JSON.parse(event.data as string)
        this.onExtensionMessage(msg)
      } catch (err) {
        console.error("Bad message from extension:", err)
      }
    })

    ws.addEventListener("close", () => {
      this.extensionWs = null
      this.state.extensionConnected = false
      this.clearDynamicTools()
      this.rejectAllPending("Extension disconnected")
    })
  }

  private onExtensionMessage(msg: ExtensionMessage) {
    switch (msg.type) {
      case "registerTools":
        for (const tool of msg.tools) {
          this.state.tools.set(tool.name, tool)
        }
        this.notifyToolsChanged()
        break

      case "unregisterTools":
        for (const name of msg.names) {
          this.state.tools.delete(name)
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
    this.state.tools.clear()
    this.notifyToolsChanged()
  }

  // ============================================================
  //  MCP PROTOCOL (Streamable HTTP)
  // ============================================================

  private async handleMcp(request: Request): Response {
    const method = request.method

    // GET → open SSE stream for server-initiated messages
    if (method === "GET") {
      return this.openSseStream()
    }

    // POST → JSON-RPC message
    if (method === "POST") {
      return this.handleJsonRpc(request)
    }

    return new Response("Method Not Allowed", { status: 405 })
  }

  private openSseStream(): Response {
    const streamId = crypto.randomUUID()
    const { readable, writable } = new TransformStream()
    const writer = writable.getWriter()
    const encoder = new TextEncoder()

    this.sseControllers.set(streamId, {
      enqueue(chunk: string) {
        writer.write(encoder.encode(chunk))
      },
      close() {
        writer.close()
      },
      desiredSize: 0,
      cancel() {},
      error() {},
    } as unknown as ReadableStreamDefaultController)

    // Heartbeat every 30s
    const heartbeat = setInterval(() => {
      try {
        writer.write(encoder.encode(":\n\n"))
      } catch {
        clearInterval(heartbeat)
      }
    }, 30000)

    // Cleanup on close
    request.signal?.addEventListener?.("abort", () => {
      clearInterval(heartbeat)
      this.sseControllers.delete(streamId)
      try { writer.close() } catch {}
    })

    return new Response(readable, {
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
      body = await request.json()
    } catch {
      return Response.json(
        { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
        { status: 400 }
      )
    }

    // Notification (no id) → 202
    if (body.id === undefined) {
      this.handleNotification(body as JsonRpcNotification)
      return new Response(null, { status: 202 })
    }

    // Request → handle and respond
    const response = await this.handleRequest(body)

    // If client accepts SSE, stream the response
    if (accept.includes("text/event-stream")) {
      return this.streamResponse(response)
    }

    // Otherwise return JSON directly
    return Response.json(response)
  }

  private streamResponse(response: JsonRpcResponse): Response {
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder()
        controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(response)}\n\n`))
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
  //  JSON-RPC METHOD HANDLERS
  // ============================================================

  private async handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse> {
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
    // Client notifications — we mostly ignore
    switch (notif.method) {
      case "notifications/initialized":
        this.state.initialized = true
        break
    }
  }

  private handleInitialize(req: JsonRpcRequest): JsonRpcResponse {
    this.state.clientInfo = req.params?.clientInfo as { name: string; version: string }

    return {
      jsonrpc: "2.0",
      id: req.id,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: {
          tools: { listChanged: true },
        },
        serverInfo: {
          name: "mcp-bridge-cf",
          version: "0.1.0",
        },
      },
    }
  }

  private handleToolsList(req: JsonRpcRequest): JsonRpcResponse {
    const tools = Array.from(this.state.tools.values()).map((t) => ({
      name: t.name,
      description: t.description || "",
      inputSchema: t.inputSchema || { type: "object", properties: {} },
    }))

    return {
      jsonrpc: "2.0",
      id: req.id,
      result: { tools },
    }
  }

  private async handleToolsCall(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    const { name, arguments: args } = req.params as {
      name: string
      arguments: Record<string, unknown>
    }

    if (!this.state.tools.has(name)) {
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
          content: [{ type: "text", text: "Error: Browser extension not connected" }],
          isError: true,
        },
      }
    }

    try {
      const result = await this.callExtensionTool(name, args || {})
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
  //  EXTENSION TOOL CALLING
  // ============================================================

  private callExtensionTool(name: string, params: Record<string, unknown>): Promise<ToolResult> {
    return new Promise((resolve, reject) => {
      const callId = crypto.randomUUID()

      const timer = setTimeout(() => {
        this.pendingCalls.delete(callId)
        reject(new Error(`Tool call timeout: ${name}`))
      }, 60000)

      this.pendingCalls.set(callId, { resolve, reject, timer })

      const msg: WorkerMessage = {
        type: "callTool",
        callId,
        name,
        params,
      }

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
    for (const [callId, pending] of this.pendingCalls) {
      clearTimeout(pending.timer)
      pending.reject(new Error(reason))
    }
    this.pendingCalls.clear()
  }

  // ============================================================
  //  NOTIFICATIONS
  // ============================================================

  private notifyToolsChanged() {
    const notification: JsonRpcNotification = {
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
    }

    for (const controller of this.sseControllers.values()) {
      try {
        const data = JSON.stringify(notification)
        ;(controller as any).enqueue(`event: message\ndata: ${data}\n\n`)
      } catch {}
    }
  }
}
