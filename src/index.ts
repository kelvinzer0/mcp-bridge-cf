/**
 * MCP Bridge — Pure Worker (no Durable Objects)
 * WebSocket + in-memory state per room
 */

// In-memory room state (ephemeral - resets on worker restart)
const rooms = new Map<string, {
  tools: Map<string, any>
  extensionWs: WebSocket | null
  pendingCalls: Map<string, any>
}>()

function getRoom(id: string) {
  if (!rooms.has(id)) {
    rooms.set(id, {
      tools: new Map(),
      extensionWs: null,
      pendingCalls: new Map(),
    })
  }
  return rooms.get(id)!
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization",
        },
      })
    }

    // Generate new room
    if (url.pathname === "/new" || url.pathname === "/mcp/new") {
      const roomId = crypto.randomUUID().slice(0, 8)
      const base = url.origin
      const wsBase = base.replace("https://", "wss://").replace("http://", "ws://")
      return Response.json({
        room: roomId,
        extension_url: `${wsBase}/ws/extension?room=${roomId}`,
        mcp_url: `${base}/mcp?room=${roomId}`,
        health_url: `${base}/health?room=${roomId}`,
      })
    }

    const room = url.searchParams.get("room") || "default"

    // Health
    if (url.pathname === "/health" || url.pathname.endsWith("/health")) {
      const r = getRoom(room)
      return Response.json({
        status: "ok",
        room,
        extensionConnected: !!r.extensionWs,
        toolsRegistered: r.tools.size,
        tools: Array.from(r.tools.keys()),
      })
    }

    // WebSocket
    if (url.pathname === "/ws/extension" || url.pathname.endsWith("/ws/extension")) {
      const upgrade = request.headers.get("Upgrade")
      if (upgrade !== "websocket") {
        return new Response("Expected websocket", { status: 426 })
      }

      const pair = new WebSocketPair()
      const client = pair[0]
      const server = pair[1]

      server.accept()

      const r = getRoom(room)
      r.extensionWs = server

      server.addEventListener("message", (event: MessageEvent) => {
        try {
          const msg = JSON.parse(event.data as string)
          if (msg.type === "registerTools") {
            for (const tool of msg.tools) r.tools.set(tool.name, tool)
          } else if (msg.type === "unregisterTools") {
            for (const name of msg.names) r.tools.delete(name)
          } else if (msg.type === "toolResult") {
            const pending = r.pendingCalls.get(msg.callId)
            if (pending) {
              clearTimeout(pending.timer)
              r.pendingCalls.delete(msg.callId)
              pending.resolve(msg.result)
            }
          }
        } catch (err) {
          console.error("Bad message:", err)
        }
      })

      server.addEventListener("close", () => {
        r.extensionWs = null
        r.tools.clear()
        for (const [, pending] of r.pendingCalls) {
          clearTimeout(pending.timer)
          pending.reject(new Error("Disconnected"))
        }
        r.pendingCalls.clear()
      })

      return new Response(null, { status: 101, webSocket: client })
    }

    // MCP
    if (url.pathname === "/mcp" || url.pathname.endsWith("/mcp")) {
      const r = getRoom(room)

      // SSE stream
      if (request.method === "GET") {
        const { readable, writable } = new TransformStream<Uint8Array>()
        const writer = writable.getWriter()
        const enc = new TextEncoder()
        const hb = setInterval(() => writer.write(enc.encode(":\n\n")).catch(() => clearInterval(hb)), 30000)
        const stream = new ReadableStream({
          start(c) {
            const reader = readable.getReader()
            const pump = (): Promise<void> => reader.read().then(({ done, value }) => {
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

      // JSON-RPC
      let body: any
      try { body = await request.json() } catch {
        return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 })
      }

      if (body.id === undefined) return new Response(null, { status: 202 })

      switch (body.method) {
        case "initialize":
          return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "mcp-bridge", version: "0.1.0" } } })
        case "tools/list":
          return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: Array.from(r.tools.values()).map((t: any) => ({ name: t.name, description: t.description || "", inputSchema: t.inputSchema || { type: "object", properties: {} } })) } })
        case "tools/call": {
          const name = body.params?.name
          if (!name || !r.tools.has(name)) return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32602, message: `Unknown tool: ${name}` } })
          if (!r.extensionWs) return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "Not connected" }], isError: true } })
          try {
            const result = await new Promise((resolve, reject) => {
              const callId = crypto.randomUUID()
              const timer = setTimeout(() => { r.pendingCalls.delete(callId); reject(new Error(`Timeout: ${name}`)) }, 60000)
              r.pendingCalls.set(callId, { resolve, reject, timer })
              r.extensionWs!.send(JSON.stringify({ type: "callTool", callId, name, params: body.params?.arguments || {} }))
            })
            return Response.json({ jsonrpc: "2.0", id: body.id, result })
          } catch (err) {
            return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true } })
          }
        }
        case "ping":
          return Response.json({ jsonrpc: "2.0", id: body.id, result: {} })
        default:
          return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: `Method not found: ${body.method}` } })
      }
    }

    return new Response("Not Found", { status: 404 })
  },
}
