# Ravex-mcp-server

Ravex-mcp-server exposes validated Partner API tools to MCP-compatible AI agents. It mirrors the public Ravex Partner API reference (`https://ravex.app/reference`) — the same endpoints, request bodies, and `{ status, data, meta }` / `{ status, error: { code, message }, meta }` response envelopes.

Installing this server gives an AI agent everything it needs to build against the API: the full documentation and reference (OpenAPI spec, Postman collection, getting-started guide, error-code reference) plus typed, safe tools for every endpoint.

## Tools

**Documentation (public — no credentials needed):** `ravex_get_started` (read first: base URLs, two-step auth with signing recipe, 60-minute token expiry, idempotency, wallets, webhooks), `ravex_list_endpoints` (index of every endpoint with auth requirements), `ravex_get_endpoint_docs` (full per-endpoint schema), `ravex_get_api_reference` (complete OpenAPI spec), `ravex_get_postman_collection`, `ravex_get_error_codes`

**Account (read-only):** `ravex_get_status`, `ravex_get_balance`, `ravex_get_pricing`, `ravex_list_services`, `ravex_list_transactions`, `ravex_get_transaction`

**Catalogs (read-only):** `ravex_list_airtime_networks`, `ravex_list_data_networks`, `ravex_list_data_plans`, `ravex_list_electricity_distributors`, `ravex_list_cable_providers`, `ravex_list_cable_packages`, `ravex_list_gift_card_buy_catalog`, `ravex_list_gift_card_sell_catalog`, `ravex_list_bet_billers`, `ravex_list_banks`

**Verifications (read-only):** `ravex_verify_electricity_meter`, `ravex_verify_cable_smartcard`, `ravex_validate_betting_account`, `ravex_verify_bank_name`

**Writes (confirm first):** `ravex_purchase_airtime`, `ravex_purchase_data`, `ravex_purchase_electricity`, `ravex_renew_cable`, `ravex_fund_betting_wallet`, `ravex_buy_gift_card`, `ravex_sell_gift_card`, `ravex_initiate_bank_transfer`

**Sell gift card lifecycle:** `ravex_sell_gift_card_rate` (quote), `ravex_sell_gift_card` (submit — async pending → successful/failed), `ravex_get_sell_trade_status` (poll). Sandbox-only `simulate_status` (`successful` | `failed` | `pending`) controls the simulated outcome and is rejected with `422 SIMULATE_STATUS_SANDBOX_ONLY` on live credentials.

**Transaction lifecycle:** `ravex_requery_transaction`, `ravex_refund_transaction`

All write tools require `customer_ref` (your per-order reference) and a unique `idempotency_key`.

## Resources

The server also exposes MCP resources readable by agents: `ravex://getting-started`, `ravex://error-codes`, `ravex://openapi.json`, `ravex://postman.json` (the latter two fetched live from the API's public docs endpoints and cached for 10 minutes).

## Configuration

Two authentication modes are supported. In both, the server sends the required `X-Ravex-Api-Version` header on every request.

**Mode 1 — HMAC credentials (recommended for single-tenant hosting).** Provide your API key ID and secret; the server performs the token exchange itself (`POST /auth/token` with an HMAC-SHA256 canonical signature), caches the bearer token, and automatically re-exchanges when it expires:

```bash
RAVEX_API_KEY=rk_test_...
RAVEX_API_SECRET=your_secret
RAVEX_API_BASE_URL=https://sandbox.api.ravexapp.com/api/partner/v1
PORT=8787
```

**Mode 2 — per-request bearer token (multi-tenant hosting).** Omit the env credentials and have each MCP client send a bearer token obtained from `POST /auth/token`:

```bash
RAVEX_API_BASE_URL=https://api.ravexapp.com/api/partner/v1
PORT=8787
```

```json
{
  "mcpServers": {
    "ravex": {
      "url": "https://<your-mcp-host>/mcp",
      "headers": {
        "Authorization": "Bearer <64-char token from POST /auth/token>"
      }
    }
  }
}
```

Bearer tokens are short-lived — **60 minutes by default**. In Mode 1 the server refreshes them transparently and retries once on `401 TOKEN_INVALID` (preserving idempotency keys, so writes cannot double-execute). In Mode 2 the server cannot refresh a caller's token; it surfaces `401 TOKEN_INVALID` as an explicit error telling the host to exchange a fresh token and retry.

Note: the `rk_live_…`/`rk_test_…` value is your public **key ID**, not a bearer token — sending it as `Authorization: Bearer …` returns `401 TOKEN_INVALID`. The key ID and secret are only used together for the HMAC signature on `POST /auth/token`.

The server never puts tokens or secrets in tool descriptions or model context.

## Run

```bash
npm install
npm run build
RAVEX_API_KEY=rk_test_... RAVEX_API_SECRET=... npm start
```

The Streamable HTTP endpoint is `/mcp`. For local clients that support stdio:

```bash
RAVEX_API_KEY=rk_test_... RAVEX_API_SECRET=... node dist/server.js --stdio
```

## MCP client configuration

After deploying this service behind HTTPS, configure an MCP client with the deployed URL (see Mode 2 above for the per-request bearer-token form).

Do not commit this configuration with a real key. For multi-user hosting, omit the server-side `RAVEX_API_KEY` and require each client to send its own bearer token. The service forwards that token only to the Ravex Partner API.

Write tools require a unique `idempotency_key`. Hosts should require user confirmation before invoking them. A successful request may still be `processing`; agents must reconcile through Ravex webhooks or a status lookup in the host application.
