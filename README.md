# Ravex-mcp-server

Ravex-mcp-server exposes validated Partner API tools to MCP-compatible AI agents.

## Configuration

```bash
RAVEX_API_KEY=rk_test_...
RAVEX_API_BASE_URL=https://sandbox.api.ravexapp.com/api/partner/v1
PORT=8787
```

For remote HTTP clients, send the Ravex bearer token in the MCP request's `Authorization` header. The server never puts the token in tool descriptions or model context.

## Run

```bash
npm install
npm run build
RAVEX_API_KEY=rk_test_... npm start
```

The Streamable HTTP endpoint is `/mcp`. For local clients that support stdio:

```bash
RAVEX_API_KEY=rk_test_... node dist/server.js --stdio
```

## MCP client configuration

After deploying this service behind HTTPS, configure an MCP client with the deployed URL:

```json
{
  "mcpServers": {
    "ravex": {
      "url": "https://<your-mcp-host>/mcp",
      "headers": {
        "Authorization": "Bearer rk_test_..."
      }
    }
  }
}
```

Do not commit this configuration with a real key. For multi-user hosting, omit the server-side `RAVEX_API_KEY` and require each client to send its own bearer token. The service forwards that token only to the Ravex Partner API.

Write tools require a unique `idempotency_key`. Hosts should require user confirmation before invoking them. A successful request may still be `processing`; agents must reconcile through Ravex webhooks or a status lookup in the host application.
