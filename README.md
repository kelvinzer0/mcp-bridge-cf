# MCP Bridge — Dynamic Tool Gateway

A generic bridge between **any MCP client** and **any tool provider** via Cloudflare Workers Durable Objects. Each room gets an isolated Durable Object instance. Tool providers connect via WebSocket, MCP clients connect via Streamable HTTP. Tools are registered dynamically and discovered automatically.

## How It Works

```
┌─────────────────┐  WebSocket   ┌──────────────────────┐  HTTP/SSE   ┌──────────────┐
│  Tool Provider  │ ───────────→ │  Cloudflare Worker   │ ──────────→ │  MCP Client  │
│  (Extension,    │              │  (Durable Object)    │             │  (VS Code,   │
│   App, Script)  │  register    │                      │ tools/list  │   Claude,    │
│                 │  tools       │  dynamic registry    │ tools/call  │   Cursor)    │
│  execute        │─────────────→│  + bridge            │───────────→│              │
│  tools          │←─────────────│  forward calls       │←───────────│  AI agent    │
│                 │  callTool    │                      │             │              │
└─────────────────┘              └──────────────────────┘             └──────────────┘
```

## Quick Start

### 1. Deploy

```bash
git clone https://github.com/kelvinzer0/mcp-bridge-cf
cd mcp-bridge-cf
npm install
npx wrangler login
npm run deploy
```

### 2. Create a Room

```bash
curl https://mcp-bridge.<subdomain>.workers.dev/new
```

Response:
```json
{
  "room": "ab1fe4c7",
  "extension_url": "https://mcp-bridge.<subdomain>.workers.dev/ws/extension?room=ab1fe4c7",
  "mcp_url": "https://mcp-bridge.<subdomain>.workers.dev/mcp?room=ab1fe4c7",
  "health_url": "https://mcp-bridge.<subdomain>.workers.dev/health?room=ab1fe4c7"
}
```

### 3. Connect Tool Provider

```javascript
const { extension_url } = await fetch("https://mcp-bridge.<subdomain>.workers.dev/new").then(r => r.json())
const ws = new WebSocket(extension_url)

// Register tools
ws.send(JSON.stringify({
  type: "registerTools",
  tools: [{ name: "my_tool", description: "...", inputSchema: { ... } }]
}))

// Handle tool calls
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data)
  if (msg.type === "callTool") {
    const result = executeTool(msg.name, msg.params)
    ws.send(JSON.stringify({ type: "toolResult", callId: msg.callId, result }))
  }
}
```

### 4. Connect MCP Client

Use the `mcp_url` from step 2:

```json
{
  "mcp": {
    "servers": {
      "bridge": {
        "url": "https://mcp-bridge.<subdomain>.workers.dev/mcp?room=ab1fe4c7"
      }
    }
  }
}
```

## Protocol

### Tool Provider → Bridge (WebSocket)

| Message | Description |
|---------|-------------|
| `{ type: "registerTools", tools: [...] }` | Register tools |
| `{ type: "unregisterTools", names: [...] }` | Unregister tools |
| `{ type: "toolResult", callId, result }` | Return tool result |
| `{ type: "pong" }` | Ping response |

### Bridge → Tool Provider (WebSocket)

| Message | Description |
|---------|-------------|
| `{ type: "callTool", callId, name, params }` | Execute tool |
| `{ type: "ping" }` | Keepalive |

### MCP Client → Bridge (Streamable HTTP)

Standard MCP protocol on `/mcp?room=<id>`:
- `POST /mcp?room=<id>` — JSON-RPC (initialize, tools/list, tools/call)
- `GET /mcp?room=<id>` — SSE stream

## Endpoints

| Endpoint | Protocol | Description |
|----------|----------|-------------|
| `/new` | HTTP GET | Generate new room |
| `/ws/extension?room=<id>` | WebSocket | Tool provider connects here |
| `/mcp?room=<id>` | Streamable HTTP | MCP client connects here |
| `/health?room=<id>` | HTTP GET | Room status + tool list |

## Example: Browser Extension

See [`extension-example/`](./extension-example/) for a Chrome extension that:
- Connects to a room via WebSocket
- Detects page context (GitHub, Gmail, Notion, etc.)
- Registers context-specific tools dynamically
- Executes tools in the page DOM

## Development

```bash
npm run dev      # Local dev with wrangler
npm run typecheck
```

## Security

For production use, add OAuth:
```typescript
import OAuthProvider from "@cloudflare/workers-oauth-provider"

export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: ...,
})
```

## License

MIT
