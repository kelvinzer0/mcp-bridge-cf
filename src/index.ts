// Dummy DO class (not used, but required for migration)
export class MCPBridge {
  async fetch() { return new Response('Not used') }
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === "/health") {
      return Response.json({ status: "ok" })
    }

    if (url.pathname === "/ws") {
      const upgrade = request.headers.get("Upgrade")
      if (upgrade !== "websocket") {
        return new Response("Expected websocket", { status: 426 })
      }

      const pair = new WebSocketPair()
      const client = pair[0]
      const server = pair[1]

      server.accept()

      server.addEventListener("message", (e: MessageEvent) => {
        server.send(`echo: ${e.data}`)
      })

      return new Response(null, { status: 101, webSocket: client })
    }

    return new Response("Not Found", { status: 404 })
  },
}
