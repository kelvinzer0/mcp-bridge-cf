/**
 * MCP Bridge — Cloudflare Worker entry point
 *
 * Routes:
 *   /ws/extension  — WebSocket for browser extension
 *   /mcp           — Streamable HTTP for MCP clients
 *   /health        — Health check
 *   /              — Landing page with connection info
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

    // Get or create the bridge Durable Object
    // Using a single instance per worker (can be extended to per-user)
    const id = env.MCP_BRIDGE.idFromName("global")
    const stub = env.MCP_BRIDGE.get(id)

    // Forward request to Durable Object
    const response = await stub.fetch(request)

    // Add CORS headers to response
    const headers = new Headers(response.headers)
    headers.set("Access-Control-Allow-Origin", "*")

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  },
}
