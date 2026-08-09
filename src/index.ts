/**
 * MCP Bridge — Cloudflare Worker entry point
 *
 * Multi-room: setiap room = 1 Durable Object instance
 *
 * Routes:
 *   /ws/extension?room=<id>  — WebSocket for tool provider
 *   /mcp?room=<id>           — Streamable HTTP for MCP client
 *   /health                  — Health check
 *   /new                     — Generate new room URL
 */

export { MCPBridge } from "./bridge"

interface Env {
  MCP_BRIDGE: DurableObjectNamespace
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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

    // Generate new room (supports both /new and /mcp/new)
    if (url.pathname === "/new" || url.pathname === "/mcp/new") {
      const roomId = crypto.randomUUID().slice(0, 8)
      const base = url.origin
      return Response.json({
        room: roomId,
        extension_url: `${base}/ws/extension?room=${roomId}`,
        mcp_url: `${base}/mcp?room=${roomId}`,
        health_url: `${base}/health?room=${roomId}`,
      })
    }

    // Get room from query or path
    const room = url.searchParams.get("room") || extractRoomFromPath(url.pathname) || "default"

    // Route to Durable Object
    const id = env.MCP_BRIDGE.idFromName(room)
    const stub = env.MCP_BRIDGE.get(id)

    const response = await stub.fetch(request)

    // CORS headers
    const headers = new Headers(response.headers)
    headers.set("Access-Control-Allow-Origin", "*")

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  },
}

function extractRoomFromPath(pathname: string): string | null {
  // /room/<id>/... pattern
  const match = pathname.match(/^\/room\/([^/]+)/)
  return match ? match[1] : null
}
