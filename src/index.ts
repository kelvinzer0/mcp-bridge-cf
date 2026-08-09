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
        headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization" },
      })
    }

    // /new — generate room
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

    // Route everything else to DO
    const room = url.searchParams.get("room") || "default"
    const id = env.MCP_BRIDGE.idFromName(room)
    const stub = env.MCP_BRIDGE.get(id)

    // Forward request to DO — return response directly (preserves status 101)
    const response = await stub.fetch(request)

    // Add CORS headers (only for non-WebSocket responses)
    if (response.status !== 101) {
      const headers = new Headers(response.headers)
      headers.set("Access-Control-Allow-Origin", "*")
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
    }

    // WebSocket response — return as-is
    return response
  },
}
