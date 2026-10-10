import express, { type Request, type Response } from "express";
import cors from "cors";
import { createHash, createHmac, randomUUID } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BUNDLED_ENDPOINTS, BUNDLED_AT } from "./endpoints.js";

const apiBaseUrl = (process.env.RAVEX_API_BASE_URL || "https://api.ravexapp.com/api/partner/v1").replace(/\/$/, "");
const port = Number(process.env.PORT || 8787);
const clientVersion = "ravex-mcp/1.2.0";

// The HMAC canonical string must use the FULL request path (including the
// /api/partner/v1 prefix), while HTTP calls stay relative to apiBaseUrl.
const canonicalPrefix = new URL(apiBaseUrl).pathname.replace(/\/+$/, "");

const keyId = process.env.RAVEX_API_KEY;
const apiSecret = process.env.RAVEX_API_SECRET;

// Bearer tokens expire after 60 minutes by default (see the API reference).
// When the server holds the HMAC credentials it exchanges and refreshes the
// token itself; when callers pass a pre-exchanged token via the Authorization
// header, expiry must be handled on the caller side.
let cachedToken: { token: string; expiresAt: number } | null = null;

const errorText = (error: unknown) => error instanceof Error ? error.message : "Ravex API request failed";

interface RavexErrorBody {
  error?: { code?: unknown; message?: unknown };
}

function apiError(body: unknown, fallback: string): string {
  const error = (body as RavexErrorBody | null)?.error;
  return typeof error?.message === "string" ? error.message : fallback;
}

function apiErrorCode(body: unknown): string | undefined {
  const code = (body as RavexErrorBody | null)?.error?.code;
  return typeof code === "string" ? code : undefined;
}

function signCanonical(method: string, path: string, query: string, timestamp: string, nonce: string, body: string): string {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const canonical = [method, path, query, timestamp, nonce, bodyHash].join("\n");
  return createHmac("sha256", apiSecret!).update(canonical).digest("hex");
}

async function exchangeToken(): Promise<{ token: string; expiresAt: number }> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomUUID().replace(/-/g, "");
  const body = "{}";
  const signature = signCanonical("POST", canonicalPrefix + "/auth/token", "", timestamp, nonce, body);

  const response = await fetch(`${apiBaseUrl}/auth/token`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Ravex-Key": keyId!,
      "X-Ravex-Signature": signature,
      "X-Ravex-Timestamp": timestamp,
      "X-Ravex-Nonce": nonce,
      "X-Ravex-Api-Version": clientVersion,
    },
    body,
    signal: AbortSignal.timeout(20_000),
  });

  const body_ = await response.json().catch(() => null);
  const token = (body_ as { data?: { token?: string; expires_at?: string } } | null)?.data?.token;

  if (!response.ok || !token) {
    throw new Error(`Ravex token exchange failed (${response.status}): ${apiError(body_, response.statusText)}`);
  }

  const expiresAtRaw = (body_ as { data?: { expires_at?: string } } | null)?.data?.expires_at;
  const expiresAt = expiresAtRaw ? Date.parse(expiresAtRaw) : Date.now() + 55 * 60_000;

  return { token, expiresAt };
}

async function getBearer(request?: Request): Promise<string> {
  // Per-request passthrough token (multi-user hosting). These are
  // short-lived (60 min default); we cannot refresh them server-side.
  const header = request?.header("authorization");
  if (header?.startsWith("Bearer ")) return header.slice(7).trim();

  if (!keyId || !apiSecret) {
    throw new Error(
      "Missing Ravex credentials. Either set RAVEX_API_KEY + RAVEX_API_SECRET (the server then exchanges and auto-refreshes bearer tokens itself) or send a pre-exchanged bearer token in the Authorization header.",
    );
  }

  if (!cachedToken || Date.now() >= cachedToken.expiresAt - 60_000) {
    cachedToken = await exchangeToken();
  }
  return cachedToken.token;
}

async function ravexRequest(path: string, init: RequestInit = {}, request?: Request) {
  const token = await getBearer(request);

  const doFetch = (bearer: string) => fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${bearer}`,
      "X-Ravex-Api-Version": clientVersion,
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(20_000),
  });

  let response = await doFetch(token);
  let body = await response.json().catch(() => null);

  // Token expired mid-flight: if we manage the credential, exchange a fresh
  // token and retry exactly once (same headers/body, so idempotency keys are
  // preserved and writes cannot double-execute).
  if (response.status === 401 && apiErrorCode(body) === "TOKEN_INVALID") {
    if (keyId && apiSecret && (!request || !request.header("authorization"))) {
      cachedToken = await exchangeToken();
      response = await doFetch(cachedToken.token);
      body = await response.json().catch(() => null);
    } else {
      throw new Error("Ravex bearer token expired (60-minute TTL). Obtain a fresh token via POST /auth/token and retry.");
    }
  }

  if (!response.ok) {
    const code = apiErrorCode(body);
    const message = apiError(body, response.statusText);
    throw new Error(`Ravex API ${response.status}${code ? ` ${code}` : ""}: ${message}`);
  }
  return body;
}

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

// ─────────────────────────────────────────────────────────────
// API documentation & reference (public endpoints — no auth)
// Mirrors https://ravex.app/reference: the OpenAPI spec, Postman
// collection, auth guide, and error-code reference, so an agent
// that installs this MCP server has everything needed to build
// against the Ravex Partner API.
// ─────────────────────────────────────────────────────────────

const GETTING_STARTED = `# Ravex Partner API — Getting Started

Business-facing API for airtime, data, bills, betting, giftcards, and bank transfers in Nigeria.

- **Production base URL:** https://api.ravexapp.com/api/partner/v1 (live credentials)
- **Sandbox base URL:** https://sandbox.api.ravexapp.com/api/partner/v1 (test credentials)
- **Interactive reference:** https://ravex.app/reference
- Response envelope: \`{ status, data, meta }\` on success, \`{ status, error: { code, message }, meta }\` on failure.

## Authentication (two steps)

**(1) Exchange for a short-lived bearer token** — POST /auth/token, signed with your API secret:

    curl -X POST https://api.ravexapp.com/api/partner/v1/auth/token \\
      -H "Content-Type: application/json" -H "Accept: application/json" \\
      -H "X-Ravex-Key: rk_live_your_key" \\
      -H "X-Ravex-Timestamp: 1760000000" \\
      -H "X-Ravex-Nonce: 9f2c4e6a8b0d1f3a5c7e9b1d3f5a7c9e" \\
      -H "X-Ravex-Signature: <hmac-sha256-hex>" \\
      -H "X-Ravex-Api-Version: my-app/1.0.0" \\
      -d '{}'

Canonical string (six \\n-separated lines; note the FULL path including /api/partner/v1):

    POST\\n/api/partner/v1/auth/token\\n\\n<timestamp>\\n<nonce>\\n<sha256-hex-of-exact-body-bytes>

X-Ravex-Signature = HMAC-SHA256(canonical, API_SECRET), hex. Rules: timestamp within ±300 s of server time; nonce single-use for 10 minutes; body hash must match the bytes actually sent (no body = hash of empty string); X-Ravex-Api-Version must match client-name/X.Y.Z with major version 1.

**(2) Call business endpoints** with the token:

    curl https://api.ravexapp.com/api/partner/v1/balance \\
      -H "Accept: application/json" \\
      -H "Authorization: Bearer <token from step 1>" \\
      -H "X-Ravex-Api-Version: my-app/1.0.0"

Business routes authenticate bearer tokens ONLY — the HMAC headers are accepted exclusively at /auth/token. X-Ravex-Key is optional on bearer routes (recommended; rate limiting keys on it). Live credentials must use api.ravexapp.com, test credentials sandbox.api.ravexapp.com.

## Token expiry (critical)

Bearer tokens last **60 minutes by default** (response includes data.expires_at, ISO-8601 UTC). After expiry every request returns 401 TOKEN_INVALID — there is NO refresh endpoint; run Step 1 again. Clients must either proactively re-exchange before expires_at or retry once on 401 TOKEN_INVALID. The rk_live…/rk_test… value is the public key ID, NOT a bearer token — sending it as Authorization: Bearer returns 401 TOKEN_INVALID.

## Writing safely

- Send a unique X-Ravex-Idempotency-Key (UUID) on every POST purchase; reusing a key with a different payload returns 409.
- Transactions start \`pending\` and settle \`successful\`/\`failed\` (or \`reversed\` on refund) — never report success until confirmed; reconcile via GET /transactions/{reference} or webhooks.
- Verify recipients first: POST /electricity/verify, /cable/verify, /bet/validate, /bank/verify-name.
- Amounts: \`amount\` in NGN or \`amount_kobo\` (integer kobo); giftcard buy uses \`amount\` in USD.
- Wallets: NGN wallet powers all transactional services; USD wallet reserved for the Dollar Card service (GET /balance returns both).

## Webhooks

Register endpoints via POST /webhooks/endpoints. Verify the HMAC signature on the raw body before parsing; treat delivery as at-least-once and deduplicate by event id / transaction reference.

## Tools in this MCP server

Read tools (balance, catalogs, verifications), write tools (purchases, transfers — require explicit user confirmation and an idempotency_key), and lifecycle tools (requery, refund, sell-trade status). Documentation tools: ravex_get_started (this guide), ravex_list_endpoints, ravex_get_endpoint_docs, ravex_get_api_reference, ravex_get_postman_collection, ravex_get_error_codes.`;

const ERROR_CODES: Record<string, { http: number; meaning: string; fix: string }> = {
  MISSING_KEY: { http: 401, meaning: "Required auth headers missing, or no authentication provided.", fix: "For POST /auth/token send X-Ravex-Key, X-Ravex-Signature, X-Ravex-Timestamp, X-Ravex-Nonce. On business routes send Authorization: Bearer <token>." },
  TOKEN_INVALID: { http: 401, meaning: "Bearer token invalid or expired (60-minute default TTL).", fix: "Re-run POST /auth/token for a fresh token and retry. There is no refresh endpoint." },
  INVALID_SIGNATURE: { http: 401, meaning: "HMAC signature does not match the canonical string.", fix: "Sign METHOD\\nFULL-PATH\\nQUERY\\nTIMESTAMP\\nNONCE\\nSHA256(body) with your API secret; ensure the body hash matches the exact bytes sent." },
  TIMESTAMP_SKEW: { http: 401, meaning: "Request timestamp outside the ±300 s window.", fix: "Sync server clock; send current Unix epoch seconds in X-Ravex-Timestamp." },
  NONCE_REPLAY: { http: 401, meaning: "Nonce already used within the last 10 minutes.", fix: "Generate a fresh random nonce per request." },
  UNKNOWN_KEY: { http: 401, meaning: "API key ID not found.", fix: "Check the X-Ravex-Key value against the dashboard." },
  REVOKED_KEY: { http: 401, meaning: "Credential revoked or business not accessible.", fix: "Use the active credential; contact Ravex support." },
  VALIDATION_ERROR: { http: 422, meaning: "Request body failed validation.", fix: "Check the error.message details against the endpoint schema." },
  SIMULATE_STATUS_SANDBOX_ONLY: { http: 422, meaning: "simulate_status sent with live credentials.", fix: "Omit simulate_status on live requests." },
  NOT_FOUND: { http: 404, meaning: "Resource not found.", fix: "Check the reference/path (e.g. transaction reference)." },
  INSUFFICIENT_FUNDS: { http: 402, meaning: "Insufficient NGN wallet balance.", fix: "Fund the wallet or reduce the amount." },
  IDEMPOTENCY_CONFLICT: { http: 409, meaning: "Idempotency key reused with a different payload.", fix: "Use a new key for a new payload; reuse the same key only for safe retries." },
  HOST_MISMATCH: { http: 403, meaning: "Credential environment does not match the API host.", fix: "Live keys → api.ravexapp.com; test keys → sandbox.api.ravexapp.com." },
  IP_NOT_ALLOWED: { http: 403, meaning: "Request IP not in the credential allowlist.", fix: "Call from an allowlisted IP or update the allowlist." },
  LEGAL_NOT_ACCEPTED: { http: 403, meaning: "Legal documents not accepted.", fix: "Accept current documents via POST /legal/accept." },
};

const docsCache = new Map<string, { data: unknown; fetchedAt: number }>();
const DOCS_TTL_MS = 10 * 60_000;

async function fetchDocs(path: string): Promise<unknown> {
  const cached = docsCache.get(path);
  if (cached && Date.now() - cached.fetchedAt < DOCS_TTL_MS) return cached.data;

  const response = await fetch(`${apiBaseUrl}${path}`, {
    headers: { Accept: "application/json", "X-Ravex-Api-Version": clientVersion },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch Ravex docs (${path}): ${response.status} ${response.statusText}`);
  }
  const data = await response.json();
  docsCache.set(path, { data, fetchedAt: Date.now() });
  return data;
}

async function getOpenApiSpec(): Promise<{ paths: Record<string, Record<string, unknown>>; [key: string]: unknown }> {
  return (await fetchDocs("/openapi.json")) as { paths: Record<string, Record<string, unknown>>; [key: string]: unknown };
}

// True when the live spec actually describes endpoints (a spec serving an
// empty paths object is treated as unavailable and the bundled index is used).
async function liveSpecHasPaths(): Promise<boolean> {
  try {
    const spec = await getOpenApiSpec();
    return Object.keys(spec.paths ?? {}).length > 0;
  } catch {
    return false;
  }
}

function bundledEndpointList() {
  return {
    base_url: apiBaseUrl,
    source: `bundled index (bundled ${BUNDLED_AT}); the live OpenAPI spec at ${apiBaseUrl}/openapi.json is currently unavailable or empty`,
    count: BUNDLED_ENDPOINTS.length,
    endpoints: BUNDLED_ENDPOINTS,
  };
}

/**
 * Every tool below mirrors the public Ravex Partner API reference
 * (https://ravex.app/reference) — same endpoints, request bodies, and
 * response envelopes: { status, data, meta } on success and
 * { status, error: { code, message }, meta } on failure.
 */
function registerTools(server: McpServer, request?: Request) {
  // ─────────────────────────────────────────────────────────────
  // API documentation & reference (public — no credentials needed)
  // ─────────────────────────────────────────────────────────────
  server.registerTool("ravex_get_started", {
    description: "Getting-started guide for the Ravex Partner API: base URLs (sandbox/live), the two-step HMAC → bearer-token authentication flow with a full signing recipe, the 60-minute token-expiry rule (401 TOKEN_INVALID → re-exchange), idempotency, wallet model, and webhook basics. Read this FIRST when building an integration.",
    inputSchema: {},
  }, async () => textResult(GETTING_STARTED));

  server.registerTool("ravex_list_endpoints", {
    description: "Index of every Ravex Partner API endpoint (method, path, summary, auth scheme, tags, request bodies), from the live OpenAPI spec with a bundled fallback. Use it to discover which endpoint to call, then ravex_get_endpoint_docs for full details.",
    inputSchema: {},
  }, async () => {
    if (!(await liveSpecHasPaths())) return result(bundledEndpointList());
    const spec = await getOpenApiSpec();
    const endpoints: unknown[] = [];
    for (const [path, methods] of Object.entries(spec.paths ?? {})) {
      for (const [method, raw] of Object.entries(methods)) {
        if (!["get", "post", "put", "delete"].includes(method)) continue;
        const op = raw as { summary?: string; tags?: string[]; security?: { [scheme: string]: [] }[] };
        const scheme = op.security?.map((entry) => Object.keys(entry)[0]).join(" | ") ?? "public";
        endpoints.push({
          method: method.toUpperCase(),
          path,
          summary: op.summary,
          auth: scheme === "bearerAuth" ? "bearer token (POST /auth/token)" : scheme === "hmacAuth" ? "HMAC signature" : scheme,
          tags: op.tags,
        });
      }
    }
    return result({ base_url: apiBaseUrl, source: "live OpenAPI spec", count: endpoints.length, endpoints });
  });

  server.registerTool("ravex_get_endpoint_docs", {
    description: "Full documentation for one Ravex Partner API endpoint: description, parameters, request-body schema, and response schemas from the live OpenAPI spec (bundled fallback when the spec is unavailable). Call ravex_list_endpoints first to find valid method/path values.",
    inputSchema: {
      method: z.enum(["GET", "POST", "PUT", "DELETE"]).describe("HTTP method, e.g. POST"),
      path: z.string().min(1).describe("Endpoint path from ravex_list_endpoints, e.g. /airtime"),
    },
  }, async ({ method, path }) => {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;

    if (await liveSpecHasPaths()) {
      const spec = await getOpenApiSpec();
      const operation = (spec.paths?.[normalizedPath] as Record<string, unknown> | undefined)?.[method.toLowerCase()];
      if (operation) {
        return result({
          base_url: apiBaseUrl,
          method,
          path: normalizedPath,
          operation,
          securitySchemes: (spec.components as { securitySchemes?: unknown } | undefined)?.securitySchemes,
        });
      }
      const available = Object.entries(spec.paths ?? {})
        .flatMap(([p, methods]) => Object.keys(methods as object).filter((m) => ["get", "post", "put", "delete"].includes(m)).map((m) => `${m.toUpperCase()} ${p}`));
      throw new Error(`No documented operation for ${method} ${normalizedPath}. Available: ${available.join(", ")}`);
    }

    const bundled = BUNDLED_ENDPOINTS.find(
      (e) => e.method === method.toUpperCase() && (e.path === normalizedPath || e.aliases?.includes(normalizedPath)),
    );
    if (!bundled) {
      throw new Error(`No documented operation for ${method} ${normalizedPath}. Call ravex_list_endpoints for the available endpoints.`);
    }
    return result({
      base_url: apiBaseUrl,
      source: `bundled index (bundled ${BUNDLED_AT})`,
      ...bundled,
    });
  });

  server.registerTool("ravex_get_api_reference", {
    description: "The complete Ravex Partner API OpenAPI 3.1 specification (paths, schemas, security schemes) exactly as served at /partner/v1/openapi.json. Falls back to the bundled endpoint index when the live spec is unavailable. Large — prefer ravex_list_endpoints / ravex_get_endpoint_docs when you only need part of it.",
    inputSchema: {},
  }, async () => {
    if (await liveSpecHasPaths()) return result(await getOpenApiSpec());
    return result({
      note: `The live OpenAPI spec at ${apiBaseUrl}/openapi.json is currently unavailable or empty; returning the bundled endpoint index instead.`,
      bundled: BUNDLED_AT,
      endpoints: BUNDLED_ENDPOINTS,
    });
  });

  server.registerTool("ravex_get_postman_collection", {
    description: "Importable Postman collection for the Ravex Partner API (as served at /partner/v1/postman.json), with collection variables api_key, api_secret, and bearer_token.",
    inputSchema: {},
  }, async () => result(await fetchDocs("/postman.json")));

  server.registerTool("ravex_get_error_codes", {
    description: "Reference of Ravex Partner API error codes with HTTP status, meaning, and remediation (TOKEN_INVALID, INVALID_SIGNATURE, TIMESTAMP_SKEW, NONCE_REPLAY, VALIDATION_ERROR, and more).",
    inputSchema: {},
  }, async () => result(ERROR_CODES));

  // ─────────────────────────────────────────────────────────────
  // Account & balances (read-only)
  // ─────────────────────────────────────────────────────────────
  server.registerTool("ravex_get_status", {
    description: "Get the authenticated business's account status and mode (test/live). Read-only. Returns { data: { business: { ... } } }.",
    inputSchema: {},
  }, async () => result(await ravexRequest("/status", {}, request)));

  server.registerTool("ravex_get_balance", {
    description: "Read the authenticated partner wallet balance. Returns { data: { balance_kobo, amount_minor_converted, currency, mode } } — NGN wallet powers all transactional services; USD wallet is reserved for the Dollar Card service. Read-only.",
    inputSchema: {},
  }, async () => result(await ravexRequest("/balance", {}, request)));

  server.registerTool("ravex_get_pricing", {
    description: "Read the authenticated business partner's pricing tier, per-service fees, and platform dollar card settings. Read-only.",
    inputSchema: {},
  }, async () => result(await ravexRequest("/pricing", {}, request)));

  server.registerTool("ravex_list_services", {
    description: "List API services granted to this business (per environment), with api_active flags and sandbox availability. Read-only.",
    inputSchema: {},
  }, async () => result(await ravexRequest("/services", {}, request)));

  server.registerTool("ravex_list_transactions", {
    description: "List the business's transactions with pagination and filters (service, status, date range). Read-only.",
    inputSchema: {
      limit: z.number().int().min(1).max(100).optional().describe("Page size (default 50)"),
      service: z.string().optional().describe("Filter by service slug, e.g. airtime"),
      status: z.enum(["pending", "successful", "failed", "reversed"]).optional(),
      from: z.string().optional().describe("Start date (YYYY-MM-DD)"),
      to: z.string().optional().describe("End date (YYYY-MM-DD)"),
    },
  }, async (q) => result(await ravexRequest(`/transactions?${new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))}`, {}, request)));

  server.registerTool("ravex_get_transaction", {
    description: "Fetch a single transaction by reference, including status, amounts (kobo), and destination details. Read-only.",
    inputSchema: { reference: z.string().min(1) },
  }, async ({ reference }) => result(await ravexRequest(`/transactions/${encodeURIComponent(reference)}`, {}, request)));

  // ─────────────────────────────────────────────────────────────
  // Catalogs (read-only, grant-checked)
  // ─────────────────────────────────────────────────────────────
  server.registerTool("ravex_list_airtime_networks", {
    description: "List supported airtime networks with their service_id values. Read-only.",
    inputSchema: {},
  }, async () => result(await ravexRequest("/airtime/networks", {}, request)));

  server.registerTool("ravex_list_data_networks", {
    description: "List supported mobile data networks. Read-only.",
    inputSchema: {},
  }, async () => result(await ravexRequest("/data/networks", {}, request)));

  server.registerTool("ravex_list_data_plans", {
    description: "List mobile data plans with plan_id, size, validity, and price (NGN). Filter by network_id. Read-only.",
    inputSchema: { network_id: z.number().int().optional() },
  }, async ({ network_id }) => result(await ravexRequest(`/data/plans${network_id ? `?network_id=${network_id}` : ""}`, {}, request)));

  server.registerTool("ravex_list_electricity_distributors", {
    description: "List electricity distribution companies with their service_id values. Read-only.",
    inputSchema: {},
  }, async () => result(await ravexRequest("/electricity/distributors", {}, request)));

  server.registerTool("ravex_list_cable_providers", {
    description: "List cable TV providers with their service_id values. Read-only.",
    inputSchema: {},
  }, async () => result(await ravexRequest("/cable/providers", {}, request)));

  server.registerTool("ravex_list_cable_packages", {
    description: "List packages/variations for a cable provider, including variation_code and price. Read-only.",
    inputSchema: { service_id: z.string().min(1).describe("Cable service_id, e.g. dstv") },
  }, async ({ service_id }) => result(await ravexRequest(`/cable/packages?service_id=${encodeURIComponent(service_id)}`, {}, request)));

  server.registerTool("ravex_list_gift_card_buy_catalog", {
    description: "List purchasable gift card products (Reloadly catalog) with productId, denominations, and brand/country info. Read-only.",
    inputSchema: {},
  }, async () => result(await ravexRequest("/giftcards/catalog", {}, request)));

  server.registerTool("ravex_list_gift_card_sell_catalog", {
    description: "List sellable gift card brands, negotiated rates (per USD), min/max limits, and terms. Same catalog is served in sandbox and live. Read-only.",
    inputSchema: {},
  }, async () => result(await ravexRequest("/giftcards/sell/catalog", {}, request)));

  server.registerTool("ravex_list_bet_billers", {
    description: "List betting billers with type keys and validation requirements. Read-only.",
    inputSchema: {},
  }, async () => result(await ravexRequest("/bet/billers", {}, request)));

  server.registerTool("ravex_list_banks", {
    description: "List Nigerian banks with their bank_code values for transfers and name enquiry. Read-only.",
    inputSchema: {},
  }, async () => result(await ravexRequest("/banks", {}, request)));

  // ─────────────────────────────────────────────────────────────
  // Verifications (read-only lookups)
  // ─────────────────────────────────────────────────────────────
  server.registerTool("ravex_verify_electricity_meter", {
    description: "Verify an electricity meter and retrieve the customer name and minimum amount. Read-only.",
    inputSchema: { service_id: z.string().min(1), meter_no: z.string().min(1), is_prepaid: z.boolean() },
  }, async ({ service_id, meter_no, is_prepaid }) => result(await ravexRequest("/electricity/verify", { method: "POST", body: JSON.stringify({ service_id, meter_no, is_prepaid }) }, request)));

  server.registerTool("ravex_verify_cable_smartcard", {
    description: "Verify a cable TV smartcard and retrieve the customer name. Read-only.",
    inputSchema: { service_id: z.string().min(1), billers_code: z.string().min(1) },
  }, async ({ service_id, billers_code }) => result(await ravexRequest("/cable/verify", { method: "POST", body: JSON.stringify({ service_id, billers_code }) }, request)));

  server.registerTool("ravex_validate_betting_account", {
    description: "Validate a betting wallet/account ID and retrieve the account holder name. Read-only.",
    inputSchema: { type: z.string().min(1).describe("Biller type, e.g. bet9ja"), account_id: z.string().min(1) },
  }, async ({ type, account_id }) => result(await ravexRequest("/bet/validate", { method: "POST", body: JSON.stringify({ type, account_id }) }, request)));

  server.registerTool("ravex_verify_bank_name", {
    description: "Resolve an account holder's name from bank_code + account_number before initiating a transfer. Read-only.",
    inputSchema: { account_number: z.string().min(10).max(10), bank_code: z.string().min(3) },
  }, async ({ account_number, bank_code }) => result(await ravexRequest("/bank/verify-name", { method: "POST", body: JSON.stringify({ account_number, bank_code }) }, request)));

  // ─────────────────────────────────────────────────────────────
  // Purchases (require user confirmation; idempotent)
  // All return { data: { transaction: { reference, service_slug, status,
  // amount_kobo, fee_kobo, total_kobo, destination_details, ... } } }.
  // customer_ref is REQUIRED by the API on every write below.
  // ─────────────────────────────────────────────────────────────
  server.registerTool("ravex_purchase_airtime", {
    description: "Purchase Nigerian airtime (amount in NGN, or amount_kobo as alternative). Requires user confirmation before execution. Returns a transaction envelope.",
    inputSchema: {
      amount: z.number().int().min(50).max(100000).describe("Amount in NGN (either amount or amount_kobo)"),
      amount_kobo: z.number().int().min(10000).optional().describe("Alternative to amount: value in kobo"),
      phone: z.string().regex(/^0\d{10}$/).describe("Nigerian phone number"),
      service_id: z.enum(["mtn", "glo", "airtel", "9mobile"]),
      customer_ref: z.string().min(1).max(255).describe("Your unique reference for this customer/order (required)"),
      customer_phone: z.string().max(20).optional(),
      idempotency_key: z.string().uuid().describe("Unique key for safe retries"),
    },
  }, async (input) => { const { idempotency_key, ...body } = input; return result(await ravexRequest("/airtime", { method: "POST", body: JSON.stringify(body), headers: { "X-Ravex-Idempotency-Key": idempotency_key } }, request)); });

  server.registerTool("ravex_purchase_data", {
    description: "Purchase a Nigerian mobile data bundle using plan_id from ravex_list_data_plans. Smile plans require smile_account_id. Requires user confirmation before execution.",
    inputSchema: {
      network: z.string().min(1), plan_id: z.string().min(1), phone: z.string().regex(/^0\d{10}$/),
      smile_account_id: z.string().optional().describe("Required for Smile data plans"),
      customer_ref: z.string().min(1).max(255),
      idempotency_key: z.string().uuid(),
    },
  }, async (input) => { const { idempotency_key, ...body } = input; return result(await ravexRequest("/data", { method: "POST", body: JSON.stringify(body), headers: { "X-Ravex-Idempotency-Key": idempotency_key } }, request)); });

  server.registerTool("ravex_purchase_electricity", {
    description: "Purchase an electricity token or pay a postpaid bill. Verify the meter first with ravex_verify_electricity_meter. Requires user confirmation before execution.",
    inputSchema: {
      service_id: z.string().min(1), meter_no: z.string().min(1), amount: z.number().positive().describe("Amount in NGN (or use amount_kobo)"), amount_kobo: z.number().int().optional(), phone: z.string().regex(/^0\d{10}$/), is_prepaid: z.boolean(),
      customer_ref: z.string().min(1).max(255), customer_phone: z.string().max(20).optional(),
      idempotency_key: z.string().uuid(),
    },
  }, async (input) => { const { idempotency_key, ...body } = input; return result(await ravexRequest("/electricity", { method: "POST", body: JSON.stringify(body), headers: { "X-Ravex-Idempotency-Key": idempotency_key } }, request)); });

  server.registerTool("ravex_renew_cable", {
    description: "Renew a cable TV subscription using variation_code from ravex_list_cable_packages. Verify the smartcard first. Requires user confirmation before execution.",
    inputSchema: {
      service_id: z.string().min(1), variation_code: z.string().min(1), billers_code: z.string().min(1), phone: z.string().regex(/^0\d{10}$/),
      customer_ref: z.string().min(1).max(255), customer_phone: z.string().max(20).optional(),
      idempotency_key: z.string().uuid(),
    },
  }, async (input) => { const { idempotency_key, ...body } = input; return result(await ravexRequest("/cable", { method: "POST", body: JSON.stringify(body), headers: { "X-Ravex-Idempotency-Key": idempotency_key } }, request)); });

  server.registerTool("ravex_fund_betting_wallet", {
    description: "Fund a betting wallet. Validate the account first with ravex_validate_betting_account. Requires user confirmation before execution.",
    inputSchema: {
      type: z.string().min(1), account_id: z.string().min(1), name: z.string().min(1).describe("Verified account holder name"), amount: z.number().positive().describe("Amount in NGN (or use amount_kobo)"), amount_kobo: z.number().int().optional(),
      customer_ref: z.string().min(1).max(255),
      idempotency_key: z.string().uuid(),
    },
  }, async (input) => { const { idempotency_key, ...body } = input; return result(await ravexRequest("/bet/fund", { method: "POST", body: JSON.stringify(body), headers: { "X-Ravex-Idempotency-Key": idempotency_key } }, request)); });

  server.registerTool("ravex_buy_gift_card", {
    description: "Buy a digital gift card using product_id from ravex_list_gift_card_buy_catalog (amount = USD denomination). Requires user confirmation before execution.",
    inputSchema: {
      product_id: z.string().min(1), amount: z.number().positive().describe("USD denomination (or amount_kobo = NGN value)"), amount_kobo: z.number().int().optional(), quantity: z.number().int().positive(), recipient_email: z.string().email(),
      customer_ref: z.string().min(1).max(255),
      idempotency_key: z.string().uuid(),
    },
  }, async (input) => { const { idempotency_key, ...body } = input; return result(await ravexRequest("/giftcards", { method: "POST", body: JSON.stringify(body), headers: { "X-Ravex-Idempotency-Key": idempotency_key } }, request)); });

  // ─────────────────────────────────────────────────────────────
  // Sell gift cards (asynchronous: pending → successful/failed)
  // ─────────────────────────────────────────────────────────────
  server.registerTool("ravex_sell_gift_card_rate", {
    description: "Quote the payout for selling a gift card before submitting: returns rate (per USD) and amount_ngn for the value. Read-only.",
    inputSchema: { card_id: z.number().int().describe("Card ID from ravex_list_gift_card_sell_catalog"), value: z.number().positive().describe("Card face value in USD") },
  }, async ({ card_id, value }) => result(await ravexRequest("/giftcards/sell/rate", { method: "POST", body: JSON.stringify({ card_id, value }) }, request)));

  server.registerTool("ravex_sell_gift_card", {
    description: "Submit a gift card for liquidation. Async lifecycle: returns status 'pending', then settles to successful/failed (~60s in sandbox, manual approval in live). Check with ravex_get_sell_trade_status or the transaction.success/failed webhook. Requires user confirmation before execution.",
    inputSchema: {
      card_id: z.number().int().describe("Card ID from ravex_list_gift_card_sell_catalog"),
      value: z.number().positive().describe("Card face value in USD"),
      type: z.enum(["physical", "ecode"]),
      code: z.string().max(1000).optional().describe("E-code string (required when type=ecode)"),
      image_urls: z.array(z.string().url()).max(5).optional().describe("Card photo URLs (required when type=physical)"),
      customer_ref: z.string().min(1).max(255),
      simulate_status: z.enum(["successful", "failed", "pending"]).optional().describe("SANDBOX ONLY — simulates outcome. successful (default): pending→approved ~60s. failed: pending→declined. pending: never settles (timeout testing). Rejected 422 with live credentials."),
      idempotency_key: z.string().uuid(),
    },
  }, async (input) => { const { idempotency_key, ...body } = input; return result(await ravexRequest("/giftcards/sell", { method: "POST", body: JSON.stringify(body), headers: { "X-Ravex-Idempotency-Key": idempotency_key } }, request)); });

  server.registerTool("ravex_get_sell_trade_status", {
    description: "Check a sell-giftcard trade by reference: pending / successful / failed (failed includes rejection_reason). Read-only.",
    inputSchema: { reference: z.string().min(1) },
  }, async ({ reference }) => result(await ravexRequest(`/giftcards/sell/${encodeURIComponent(reference)}`, {}, request)));

  // ─────────────────────────────────────────────────────────────
  // Bank transfers (highest-risk — always confirm)
  // ─────────────────────────────────────────────────────────────
  server.registerTool("ravex_initiate_bank_transfer", {
    description: "Initiate a Nigerian bank payout. Verify the recipient with ravex_verify_bank_name first. Always require explicit user confirmation immediately before execution.",
    inputSchema: {
      account_number: z.string().regex(/^\d{10}$/), bank_code: z.string().min(3), amount: z.number().positive().describe("Amount in NGN (or use amount_kobo)"), amount_kobo: z.number().int().optional(), narration: z.string().max(255).optional(),
      customer_ref: z.string().min(1).max(255),
      idempotency_key: z.string().uuid(),
    },
  }, async (input) => { const { idempotency_key, ...body } = input; return result(await ravexRequest("/bank-transfer", { method: "POST", body: JSON.stringify(body), headers: { "X-Ravex-Idempotency-Key": idempotency_key } }, request)); });

  // ─────────────────────────────────────────────────────────────
  // Transaction lifecycle
  // ─────────────────────────────────────────────────────────────
  server.registerTool("ravex_requery_transaction", {
    description: "Re-check the provider status of a pending transaction and update the local record. Sandbox transactions return their recorded state without contacting a provider. Requires user confirmation before execution.",
    inputSchema: { reference: z.string().min(1) },
  }, async ({ reference }) => result(await ravexRequest(`/transactions/${encodeURIComponent(reference)}/requery`, { method: "POST" }, request)));

  server.registerTool("ravex_refund_transaction", {
    description: "Reverse a pending or failed transaction back to the NGN wallet. Successful transactions cannot be refunded via API. Requires user confirmation before execution.",
    inputSchema: { reference: z.string().min(1) },
  }, async ({ reference }) => result(await ravexRequest(`/transactions/${encodeURIComponent(reference)}/refund`, { method: "POST" }, request)));
}

function createServer(request?: Request) {
  const server = new McpServer({ name: "ravex", version: "1.3.0" });
  registerTools(server, request);
  registerResources(server);
  return server;
}

function registerResources(server: McpServer) {
  server.registerResource(
    "getting-started",
    "ravex://getting-started",
    { description: "Ravex Partner API getting-started guide: base URLs, two-step authentication (HMAC → bearer token), 60-minute token expiry, idempotency, wallets, webhooks.", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: GETTING_STARTED }] }),
  );

  server.registerResource(
    "error-codes",
    "ravex://error-codes",
    { description: "Ravex Partner API error-code reference (code, HTTP status, meaning, fix).", mimeType: "application/json" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(ERROR_CODES, null, 2) }] }),
  );

  server.registerResource(
    "openapi-spec",
    "ravex://openapi.json",
    { description: "The complete Ravex Partner API OpenAPI specification (fetched live from /partner/v1/openapi.json; bundled endpoint index when unavailable).", mimeType: "application/json" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify((await liveSpecHasPaths()) ? await getOpenApiSpec() : bundledEndpointList()) }] }),
  );

  server.registerResource(
    "postman-collection",
    "ravex://postman.json",
    { description: "Importable Postman collection for the Ravex Partner API (fetched live from /partner/v1/postman.json).", mimeType: "application/json" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await fetchDocs("/postman.json")) }] }),
  );
}

async function startStdio() {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

async function handleMcp(request: Request, response: Response) {
  const server = createServer(request);
  // Stateless mode keeps each request isolated and lets the bearer token come
  // from the current MCP request without retaining credentials in sessions.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  response.on("close", () => void transport.close());
  await server.connect(transport);
  await transport.handleRequest(request, response, request.body);
}

if (process.argv.includes("--stdio")) {
  await startStdio();
} else {
  const app = express();
  app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(",") || false }));
  app.use(express.json({ limit: "1mb" }));
  app.get("/health", (_request, response) => response.json({ status: "ok", service: "ravex-mcp" }));
  app.all("/mcp", (request, response) => handleMcp(request, response).catch((error) => {
    console.error("MCP request failed:", errorText(error));
    if (!response.headersSent) response.status(500).json({ error: "MCP request failed" });
  }));
  app.listen(port, "127.0.0.1", () => console.error(`Ravex-mcp-server listening on http://127.0.0.1:${port}/mcp`));
}
