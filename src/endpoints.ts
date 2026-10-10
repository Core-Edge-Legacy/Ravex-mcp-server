/**
 * Bundled endpoint index for the Ravex Partner API.
 *
 * Used as a fallback when the live OpenAPI spec (GET /partner/v1/openapi.json)
 * is unreachable or serves an empty path list, so agents ALWAYS get a usable
 * reference. Mirrors routes/api.php (partner/v1 group) + OpenApiSpecBuilder
 * summaries/request bodies. Backward-compat aliases are listed per endpoint.
 */

export interface BundledEndpoint {
  method: "GET" | "POST" | "DELETE";
  path: string;
  summary: string;
  auth: "bearer token (POST /auth/token)" | "HMAC signature" | "public";
  tags: string[];
  aliases?: string[];
  request_body?: Record<string, unknown>;
  notes?: string;
}

export const BUNDLED_ENDPOINTS: BundledEndpoint[] = [
  { method: "POST", path: "/auth/token", summary: "Issue a short-lived bearer token", auth: "HMAC signature", tags: ["Authentication"],
    request_body: { nonce: "string" },
    notes: "HMAC-SHA256 over METHOD\\nFULL-PATH\\nQUERY\\nTIMESTAMP\\nNONCE\\nSHA256(body). Token expires after 60 minutes by default (data.expires_at). No refresh endpoint — re-exchange on 401 TOKEN_INVALID." },

  { method: "GET", path: "/status", summary: "Get business status", auth: "bearer token (POST /auth/token)", tags: ["Account"] },
  { method: "GET", path: "/balance", summary: "Get wallet balance (NGN balance_kobo + USD usd_balance_cents)", auth: "bearer token (POST /auth/token)", tags: ["Account"], aliases: ["/wallet/balance"] },
  { method: "GET", path: "/pricing", summary: "Get pricing tier and per-service fees", auth: "bearer token (POST /auth/token)", tags: ["Account"] },
  { method: "GET", path: "/services", summary: "List granted services", auth: "bearer token (POST /auth/token)", tags: ["Account"] },
  { method: "GET", path: "/transactions", summary: "List transactions (filters: limit, after, service, status, from, to)", auth: "bearer token (POST /auth/token)", tags: ["Transactions"] },
  { method: "GET", path: "/transactions/{reference}", summary: "Get a single transaction", auth: "bearer token (POST /auth/token)", tags: ["Transactions"] },
  { method: "POST", path: "/transactions/{reference}/requery", summary: "Requery provider status of a pending transaction", auth: "bearer token (POST /auth/token)", tags: ["Transactions"] },
  { method: "POST", path: "/transactions/{reference}/refund", summary: "Refund a pending or failed transaction to the NGN wallet", auth: "bearer token (POST /auth/token)", tags: ["Transactions"], notes: "Successful transactions cannot be refunded via API." },

  { method: "GET", path: "/airtime/networks", summary: "List airtime networks (service_id values)", auth: "bearer token (POST /auth/token)", tags: ["Catalogs"] },
  { method: "GET", path: "/data/networks", summary: "List data networks", auth: "bearer token (POST /auth/token)", tags: ["Catalogs"] },
  { method: "GET", path: "/data/plans", summary: "List data plans (plan_id, size, validity, price)", auth: "bearer token (POST /auth/token)", tags: ["Catalogs"] },
  { method: "GET", path: "/electricity/distributors", summary: "List electricity distributors (service_id values)", auth: "bearer token (POST /auth/token)", tags: ["Catalogs"] },
  { method: "GET", path: "/cable/providers", summary: "List cable providers (service_id values)", auth: "bearer token (POST /auth/token)", tags: ["Catalogs"] },
  { method: "GET", path: "/cable/packages", summary: "List cable packages (variation_code, price)", auth: "bearer token (POST /auth/token)", tags: ["Catalogs"] },
  { method: "GET", path: "/giftcards/catalog", summary: "List purchasable gift card products", auth: "bearer token (POST /auth/token)", tags: ["Catalogs"] },
  { method: "GET", path: "/giftcards/sell/catalog", summary: "List sellable gift card brands and negotiated rates", auth: "bearer token (POST /auth/token)", tags: ["Catalogs"] },
  { method: "GET", path: "/bet/billers", summary: "List betting billers (type keys)", auth: "bearer token (POST /auth/token)", tags: ["Catalogs"] },
  { method: "GET", path: "/banks", summary: "List Nigerian banks (bank_code values)", auth: "bearer token (POST /auth/token)", tags: ["Catalogs"] },
  { method: "GET", path: "/legal/documents", summary: "List current legal documents", auth: "bearer token (POST /auth/token)", tags: ["Legal"] },

  { method: "POST", path: "/electricity/verify", summary: "Verify meter number (customer name, minimum amount)", auth: "bearer token (POST /auth/token)", tags: ["Verifications"], aliases: ["/electricity/verify-meter"],
    request_body: { service_id: "string", meter_no: "string" } },
  { method: "POST", path: "/cable/verify", summary: "Verify smart card number", auth: "bearer token (POST /auth/token)", tags: ["Verifications"], aliases: ["/cable/verify-smartcard"],
    request_body: { service_id: "string", billers_code: "string" } },
  { method: "POST", path: "/bet/validate", summary: "Validate betting account (holder name)", auth: "bearer token (POST /auth/token)", tags: ["Verifications"], aliases: ["/bet/verify-customer"],
    request_body: { type: "string", account_id: "string" } },
  { method: "POST", path: "/bank/verify-name", summary: "Resolve account holder name (bank_code + account_number)", auth: "bearer token (POST /auth/token)", tags: ["Verifications"],
    request_body: { account_number: "string", bank_code: "string" } },

  { method: "POST", path: "/airtime", summary: "Buy airtime", auth: "bearer token (POST /auth/token)", tags: ["Purchases"],
    request_body: { amount: "integer NGN (or amount_kobo)", amount_kobo: "integer kobo", phone: "string 0XXXXXXXXXX", service_id: "string e.g. mtn", customer_ref: "string (required)", customer_phone: "string", idempotency_key: "string UUID" },
    notes: "Send X-Ravex-Idempotency-Key header. Returns { data: { transaction: { reference, status, amount_kobo, ... } } }." },
  { method: "POST", path: "/data", summary: "Buy data plan", auth: "bearer token (POST /auth/token)", tags: ["Purchases"],
    request_body: { phone: "string", plan_id: "string from /data/plans", network: "string", smile_account_id: "string (Smile plans)", customer_ref: "string (required)", idempotency_key: "string UUID" } },
  { method: "POST", path: "/electricity", summary: "Buy electricity token / pay postpaid bill", auth: "bearer token (POST /auth/token)", tags: ["Purchases"],
    request_body: { service_id: "string", meter_no: "string", is_prepaid: "boolean", amount: "integer NGN (or amount_kobo)", amount_kobo: "integer kobo", phone: "string", customer_ref: "string (required)", idempotency_key: "string UUID" } },
  { method: "POST", path: "/cable", summary: "Buy cable subscription", auth: "bearer token (POST /auth/token)", tags: ["Purchases"],
    request_body: { service_id: "string", variation_code: "string from /cable/packages", billers_code: "string (smartcard)", phone: "string", customer_ref: "string (required)", idempotency_key: "string UUID" } },
  { method: "POST", path: "/bet/fund", summary: "Fund a betting wallet", auth: "bearer token (POST /auth/token)", tags: ["Purchases"],
    request_body: { type: "string e.g. bet9ja", account_id: "string", name: "string (verified holder name)", amount: "number NGN (or amount_kobo)", amount_kobo: "integer kobo", customer_ref: "string (required)", idempotency_key: "string UUID" } },
  { method: "POST", path: "/giftcards", summary: "Buy a gift card (amount = USD denomination)", auth: "bearer token (POST /auth/token)", tags: ["Purchases"], aliases: ["/giftcards/buy"],
    request_body: { product_id: "string from /giftcards/catalog", amount: "number USD (or amount_kobo NGN)", amount_kobo: "integer kobo", quantity: "integer", recipient_email: "string email", customer_ref: "string (required)", idempotency_key: "string UUID" } },
  { method: "POST", path: "/giftcards/sell/rate", summary: "Quote gift card sell payout (rate, amount_ngn)", auth: "bearer token (POST /auth/token)", tags: ["Purchases"],
    request_body: { card_id: "integer from /giftcards/sell/catalog", value: "number USD" } },
  { method: "POST", path: "/giftcards/sell", summary: "Submit gift card for liquidation (async: pending → successful/failed)", auth: "bearer token (POST /auth/token)", tags: ["Purchases"], aliases: ["/giftcards/sell-submit"],
    request_body: { card_id: "integer", value: "number USD", type: "physical | ecode", code: "string (ecode)", image_urls: ["string url (physical)"], customer_ref: "string (required)", simulate_status: "successful | failed | pending (SANDBOX ONLY — 422 SIMULATE_STATUS_SANDBOX_ONLY on live)", idempotency_key: "string UUID" },
    notes: "Sandbox auto-settles ~60s; live goes to manual approval. Poll /giftcards/sell/{reference} or listen for transaction.success/failed webhooks." },
  { method: "GET", path: "/giftcards/sell/{reference}", summary: "Check sell trade status (failed includes rejection_reason)", auth: "bearer token (POST /auth/token)", tags: ["Purchases"] },
  { method: "POST", path: "/bank-transfer", summary: "Send a Nigerian bank payout", auth: "bearer token (POST /auth/token)", tags: ["Purchases"], aliases: ["/bank/transfer"],
    request_body: { account_number: "string (10 digits)", bank_code: "string from /banks", amount: "number NGN (or amount_kobo)", amount_kobo: "integer kobo", narration: "string", customer_ref: "string (required)", idempotency_key: "string UUID" },
    notes: "Highest risk — verify with /bank/verify-name first and require explicit user confirmation." },

  { method: "GET", path: "/webhooks/endpoints", summary: "List webhook endpoints", auth: "bearer token (POST /auth/token)", tags: ["Webhooks"] },
  { method: "POST", path: "/webhooks/endpoints", summary: "Register a webhook endpoint", auth: "bearer token (POST /auth/token)", tags: ["Webhooks"],
    request_body: { url: "string uri", events: ["string e.g. transaction.success"], secret: "string (min 16 chars)" } },
  { method: "DELETE", path: "/webhooks/endpoints/{id}", summary: "Delete a webhook endpoint", auth: "bearer token (POST /auth/token)", tags: ["Webhooks"] },
  { method: "POST", path: "/webhooks/endpoints/{id}/test", summary: "Send a test event to a webhook endpoint", auth: "bearer token (POST /auth/token)", tags: ["Webhooks"] },
  { method: "POST", path: "/legal/accept", summary: "Accept current legal documents", auth: "bearer token (POST /auth/token)", tags: ["Legal"],
    request_body: { document_ids: ["integer"] } },

  { method: "POST", path: "/checkout/sessions", summary: "Create a hosted checkout session", auth: "bearer token (POST /auth/token)", tags: ["Checkout"],
    request_body: { service_slug: "string", amount: "integer", customer_phone: "string", success_url: "string uri" } },
  { method: "GET", path: "/checkout/sessions/{token}", summary: "Get a checkout session", auth: "bearer token (POST /auth/token)", tags: ["Checkout"] },
  { method: "GET", path: "/checkout/{token}", summary: "Get public checkout session (checkout widget)", auth: "public", tags: ["Checkout"] },
  { method: "POST", path: "/checkout/{token}/complete", summary: "Complete a checkout session (checkout widget)", auth: "public", tags: ["Checkout"] },

  { method: "GET", path: "/openapi.json", summary: "This API's OpenAPI specification", auth: "public", tags: ["Documentation"] },
  { method: "GET", path: "/postman.json", summary: "Importable Postman collection", auth: "public", tags: ["Documentation"] },
  { method: "GET", path: "/docs", summary: "Interactive Scalar documentation", auth: "public", tags: ["Documentation"] },
];

export const BUNDLED_AT = "2026-10-10";
