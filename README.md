# MCP Bridge — Dynamic Tool Gateway

A generic bridge between **any MCP client** and **any tool provider** via Cloudflare Workers Durable Objects. Tool providers connect via WebSocket, MCP clients connect via Streamable HTTP. Tools are registered dynamically and discovered automatically.

## How It Works

```
┌─────────────────┐  WebSocket   ┌──────────────────────┐  HTTP/SSE   ┌──────────────┐
│  Tool Provider  │ ───────────→ │  Cloudflare Worker   │ ──────────→ │  MCP Client  │
│  (Extension,    │              │  (Durable Object)    │             │  (VS Code,   │
│   App, Script)  │  register    │                      │ tools/list  │   Claude,    │
│                 │  tools       │  dynamic registry    │ tools/call  │   Cursor)    │
│  execute        │─────────────→│  + bridge            │───────────→│              │
│  tools          │←─────────────│  forward calls       │←───────────│  AI agent    │
│                 │  callTool    │                      │             │  discovers   │
└─────────────────┘              └──────────────────────┘             └──────────────┘
```

**Bridge** — stateless MCP proxy with dynamic tool registry (Cloudflare Durable Object)

**Tool Provider** — anything that connects via WebSocket and registers tools (browser extension, desktop app, script, etc.)

**MCP Client** — any standard MCP client (VS Code, Claude Desktop, Cursor, etc.)

## Quick Start

### 1. Deploy the Bridge

```bash
git clone <this-repo>
cd mcp-bridge-cf
npm install
npx wrangler login
npm run deploy
```

Output: `https://mcp-bridge.<your-subdomain>.workers.dev`

### 2. Connect a Tool Provider

Any application can register tools via WebSocket:

```javascript
const ws = new WebSocket("wss://mcp-bridge.<subdomain>.workers.dev/ws/extension")

// Register tools
ws.send(JSON.stringify({
  type: "registerTools",
  tools: [
    {
      name: "my_tool",
      description: "Does something useful",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Input query" }
        },
        required: ["query"]
      }
    }
  ]
}))

// Handle tool calls from MCP client
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data)
  if (msg.type === "callTool") {
    // Execute the tool
    const result = executeMyTool(msg.name, msg.params)

    // Send result back
    ws.send(JSON.stringify({
      type: "toolResult",
      callId: msg.callId,
      result: {
        content: [{ type: "text", text: JSON.stringify(result) }]
      }
    }))
  }
}
```

### 3. Connect an MCP Client

**VS Code** (`.vscode/settings.json`):
```json
{
  "mcp": {
    "servers": {
      "bridge": {
        "url": "https://mcp-bridge.<subdomain>.workers.dev/mcp"
      }
    }
  }
}
```

**Claude Desktop** (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "bridge": {
      "url": "https://mcp-bridge.<subdomain>.workers.dev/mcp"
    }
  }
}
```

## Protocol

### Tool Provider → Bridge (WebSocket)

**Register tools:**
```json
{
  "type": "registerTools",
  "tools": [
    {
      "name": "tool_name",
      "description": "What it does",
      "inputSchema": { "type": "object", "properties": { ... } }
    }
  ]
}
```

**Unregister tools:**
```json
{
  "type": "unregisterTools",
  "names": ["tool_name"]
}
```

**Respond to tool call:**
```json
{
  "type": "toolResult",
  "callId": "uuid-from-bridge",
  "result": {
    "content": [{ "type": "text", "text": "result data" }],
    "isError": false
  }
}
```

### Bridge → Tool Provider (WebSocket)

**Execute tool:**
```json
{
  "type": "callTool",
  "callId": "unique-id",
  "name": "tool_name",
  "params": { "query": "value" }
}
```

**Ping:**
```json
{ "type": "ping" }
```

### MCP Client → Bridge (Streamable HTTP)

Standard MCP protocol on `/mcp` endpoint:
- `POST /mcp` — JSON-RPC requests (initialize, tools/list, tools/call)
- `GET /mcp` — SSE stream for server-initiated messages

## Endpoints

| Endpoint | Protocol | Description |
|----------|----------|-------------|
| `/ws/extension` | WebSocket | Tool provider connects here |
| `/mcp` | Streamable HTTP | MCP client connects here |
| `/health` | HTTP GET | Status + registered tools |

## Example: Browser Extension

See [`extension-example/`](./extension-example/) for a Chrome extension that:
- Detects page context (GitHub, Gmail, Notion, etc.)
- Registers context-specific tools dynamically
- Executes tools in the page DOM
- Auto-upplements tools when navigating

This is just one example — you can build tool providers for anything:
- Desktop apps (Electron, Tauri)
- CLI tools
- Mobile apps
- IoT devices
- Other APIs

## Development

```bash
npm run dev      # Local dev with wrangler
npm run typecheck
```

## Security

For production use, add authentication:

```typescript
import OAuthProvider from "@cloudflare/workers-oauth-provider"

export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: createMcpHandler(createServer),
  // ... OAuth config
})
```

## License

MIT
