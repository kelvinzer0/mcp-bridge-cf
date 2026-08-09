import { DurableObject } from "cloudflare:workers"

/**
 * MCP Bridge Durable Object
 * Handles MCP protocol (JSON-RPC, SSE)
 * Reads tool list from X-WS-Tools header (injected by Worker)
 */
export class MCPBridge extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === "/health" || url.pathname.endsWith("/health")) {
      const connected = request.headers.get("X-WS-Connected") === "true"
      let tools: any[] = []
      try { tools = JSON.parse(request.headers.get("X-WS-Tools") || "[]") } catch {}
      return Response.json({
        status: "ok",
        extensionConnected: connected,
        toolsRegistered: tools.length,
        tools: tools.map((t: any) => t.name),
      })
    }

    if (url.pathname === "/mcp" || url.pathname.endsWith("/mcp")) {
      // GET → SSE stream
      if (request.method === "GET") {
        const { readable, writable } = new TransformStream<Uint8Array>()
        const writer = writable.getWriter()
        const enc = new TextEncoder()
        const hb = setInterval(() => writer.write(enc.encode(":\n\n")).catch(() => clearInterval(hb)), 30000)
        const stream = new ReadableStream({
          start(c) {
            const r = readable.getReader()
            const pump = (): Promise<void> => r.read().then(({ done, value }) => {
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

      // POST → JSON-RPC
      let body: any
      try { body = await request.json() } catch {
        return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 })
      }

      if (body.id === undefined) return new Response(null, { status: 202 })

      // Read tools from header
      let tools: any[] = []
      try { tools = JSON.parse(request.headers.get("X-WS-Tools") || "[]") } catch {}

      let resp: any
      switch (body.method) {
        case "initialize":
          resp = { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "mcp-bridge", version: "0.1.0" } } }
          break
        case "tools/list":
          resp = { jsonrpc: "2.0", id: body.id, result: { tools: tools.map((t: any) => ({ name: t.name, description: t.description || "", inputSchema: t.inputSchema || { type: "object", properties: {} } })) } }
          break
        case "tools/call":
          // tools/call is handled by the Worker (forwarded to WS)
          // If we reach here, it means the Worker couldn't handle it
          resp = { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "Tool call failed" }], isError: true } }
          break
        case "ping":
          resp = { jsonrpc: "2.0", id: body.id, result: {} }
          break
        default:
          resp = { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: `Method not found: ${body.method}` } }
      }
      return Response.json(resp)
    }

    return new Response("Not Found", { status: 404 })
  }
}
