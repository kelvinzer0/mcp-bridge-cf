import { DurableObject } from "cloudflare:workers"

export class MCPBridge extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env)
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === "/health" || url.pathname.endsWith("/health")) {
      return Response.json({ status: "ok" })
    }

    if (url.pathname === "/ws/extension" || url.pathname.endsWith("/ws/extension")) {
      const upgrade = request.headers.get("Upgrade")
      if (upgrade !== "websocket") {
        return new Response("Expected websocket", { status: 426 })
      }

      const pair = new WebSocketPair()
      const client = pair[0]
      const server = pair[1]

      this.ctx.acceptWebSocket(server)

      server.addEventListener("message", (e: MessageEvent) => {
        server.send(`echo: ${e.data}`)
      })

      return new Response(null, { status: 101, webSocket: client })
    }

    return new Response("Not Found", { status: 404 })
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    ws.send(`echo: ${message}`)
  }

  async webSocketClose(): Promise<void> {}

  async webSocketError(): Promise<void> {}
}
