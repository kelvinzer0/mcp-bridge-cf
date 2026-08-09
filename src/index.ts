/**
 * MCP Bridge — Cloudflare Worker
 * WebSocket handled at Worker level, MCP via Durable Object
 */

export { MCPBridge } from "./bridge"

// In-memory WS state (per-isolate, ephemeral)
const wsRooms = new Map<string, {
  tools: Map<string, any>
  ws: WebSocket | null
  pendingCalls: Map<string, { resolve: Function; reject: Function; timer: any }>
}>()

function getWsRoom(id: string) {
  if (!wsRooms.has(id)) {
    wsRooms.set(id, { tools: new Map(), ws: null, pendingCalls: new Map() })
  }
  return wsRooms.get(id)!
}

interface Env {
  MCP_BRIDGE: DurableObjectNamespace
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization" },
      })
    }

    // /new
    if (url.pathname === "/new" || url.pathname === "/mcp/new") {
      const roomId = crypto.randomUUID().slice(0, 8)
      const base = url.origin
      const wsBase = base.replace("https://", "wss://").replace("http://", "ws://")
      return Response.json({
        room: roomId,
        extension_url: `${wsBase}/ws/extension?room=${roomId}`,
        mcp_url: `${base}/mcp?room=${roomId}`,
        health_url: `${base}/health?room=${roomId}`,
      }, { headers: { "Access-Control-Allow-Origin": "*" } })
    }

    const room = url.searchParams.get("room") || "default"

    // WebSocket — handled directly in Worker
    if (url.pathname === "/ws/extension" || url.pathname.endsWith("/ws/extension")) {
      const upgrade = request.headers.get("Upgrade")
      if (upgrade !== "websocket") return new Response("Expected websocket", { status: 426 })

      const pair = new WebSocketPair()
      const client = pair[0]
      const server = pair[1]
      server.accept()

      const r = getWsRoom(room)
      if (r.ws) { try { r.ws.close(4000, "Replaced") } catch {} }
      r.ws = server

      server.addEventListener("message", (event: MessageEvent) => {
        try {
          const msg = JSON.parse(event.data as string)
          if (msg.type === "registerTools") {
            for (const tool of msg.tools) r.tools.set(tool.name, tool)
          } else if (msg.type === "unregisterTools") {
            for (const name of msg.names) r.tools.delete(name)
          } else if (msg.type === "toolResult") {
            const pending = r.pendingCalls.get(msg.callId)
            if (pending) { clearTimeout(pending.timer); r.pendingCalls.delete(msg.callId); pending.resolve(msg.result) }
          }
        } catch (err) { console.error("Bad msg:", err) }
      })

      server.addEventListener("close", () => {
        r.ws = null; r.tools.clear()
        for (const [, p] of r.pendingCalls) { clearTimeout(p.timer); p.reject(new Error("Disconnected")) }
        r.pendingCalls.clear()
      })

      return new Response(null, { status: 101, webSocket: client })
    }

    // Everything else → Durable Object
    try {
      const id = env.MCP_BRIDGE.idFromName(room)
      const stub = env.MCP_BRIDGE.get(id)

      // Inject WS room tools into DO via header
      const r = getWsRoom(room)
      const toolsJson = JSON.stringify(Array.from(r.tools.values()))
      const connected = !!r.ws

      const modifiedRequest = new Request(request, {
        headers: {
          ...Object.fromEntries(request.headers.entries()),
          "X-WS-Tools": toolsJson,
          "X-WS-Connected": String(connected),
        },
      })

      // For tool calls, handle at Worker level (forward to WS)
      if ((url.pathname === "/mcp" || url.pathname.endsWith("/mcp")) && request.method === "POST") {
        let body: any
        try { body = await request.clone().json() } catch {}

        if (body?.method === "tools/call" && r.ws) {
          const name = body.params?.name
          const args = body.params?.arguments || {}
          if (name && r.tools.has(name)) {
            try {
              const result = await new Promise((resolve, reject) => {
                const callId = crypto.randomUUID()
                const timer = setTimeout(() => { r.pendingCalls.delete(callId); reject(new Error(`Timeout: ${name}`)) }, 60000)
                r.pendingCalls.set(callId, { resolve, reject, timer })
                r.ws!.send(JSON.stringify({ type: "callTool", callId, name, params: args }))
              })
              return Response.json({ jsonrpc: "2.0", id: body.id, result }, { headers: { "Access-Control-Allow-Origin": "*" } })
            } catch (err) {
              return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true } }, { headers: { "Access-Control-Allow-Origin": "*" } })
            }
          }
        }
      }

      // Return DO response directly (don't rebuild — preserves status 101 if needed)
      return response
    } catch (err) {
      return Response.json({ error: String(err) }, { status: 500 })
    }
  },
}
