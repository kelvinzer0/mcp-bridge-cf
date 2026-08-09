# Deploy Guide

## Prerequisites

- Node.js 18+
- Cloudflare account (free tier works)

## Deploy

```bash
npm install
npx wrangler login
npm run deploy
```

Output: `https://mcp-bridge.<subdomain>.workers.dev`

## Verify

```bash
curl https://mcp-bridge.<subdomain>.workers.dev/health
# → {"status":"ok","extensionConnected":false,"toolsRegistered":0,"tools":[]}
```

## Connect Tool Provider

Connect via WebSocket at `wss://mcp-bridge.<subdomain>.workers.dev/ws/extension`

See [README.md](./README.md) for protocol details and code examples.

## Connect MCP Client

Use `https://mcp-bridge.<subdomain>.workers.dev/mcp` as the MCP server URL.

## GitHub Actions (auto-deploy on push)

1. Push repo to GitHub
2. Settings → Secrets → Actions:
   - `CF_API_TOKEN` — from [API Tokens](https://dash.cloudflare.com/profile/api-tokens)
   - `CF_ACCOUNT_ID` — from dashboard URL
3. Push to `main` triggers deploy

## Troubleshooting

**Bridge not responding:**
- Check `/health` endpoint
- Verify worker is deployed

**Tools not appearing:**
- Tool provider must be connected via WebSocket
- Check `/health` for `extensionConnected: true`
- Verify tool provider sends `registerTools` message

**MCP client can't connect:**
- Verify URL format: `https://<worker>.workers.dev/mcp`
- Test with curl:
  ```bash
  curl -X POST https://<worker>/mcp \
    -H "Content-Type: application/json" \
    -H "Accept: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
  ```
