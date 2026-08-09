import { DurableObject } from "cloudflare:workers"

/**
 * MCP Bridge Durable Object — absolute minimal test
 */
export class MCPBridge extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    // Health check
    if (url.pathname === "/health" || url.pathname.endsWith("/health")) {
      return Response.json({ status: "ok" })
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

      // Accept
      this.ctx.acceptWebSocket(server)

      // Handler
      server.addEventListener("message", (e) => {
        server.send(`echo: ${e.data}`)
      })

      return new Response(null, { status: 101, webSocket: client })
    }

    return new Response("Not Found", { status: 404 })
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    ws.send(`echo: ${message}`)
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    // cleanup
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    // cleanup
  }
}
