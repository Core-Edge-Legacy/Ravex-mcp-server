import express, { type Request, type Response } from "express";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const apiBaseUrl = (process.env.RAVEX_API_BASE_URL || "https://api.ravexapp.com/api/partner/v1").replace(/\/$/, "");
const port = Number(process.env.PORT || 8787);

const errorText = (error: unknown) => error instanceof Error ? error.message : "Ravex API request failed";

function authToken(request?: Request): string | undefined {
  const header = request?.header("authorization");
  if (header?.startsWith("Bearer ")) return header.slice(7).trim();
  return process.env.RAVEX_API_KEY;
}

async function ravexRequest(path: string, init: RequestInit = {}, request?: Request) {
  const token = authToken(request);
  if (!token) throw new Error("Missing Ravex bearer token. Configure RAVEX_API_KEY or send an Authorization header.");

  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body && typeof body === "object" && "message" in body ? String(body.message) : response.statusText;
    throw new Error(`Ravex API ${response.status}: ${message}`);
  }
  return body;
}

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function registerTools(server: McpServer, request?: Request) {
  server.registerTool("ravex_get_balance", {
    description: "Read the authenticated Ravex partner wallet balance. Read-only.",
    inputSchema: {},
  }, async () => result(await ravexRequest("/balance", {}, request)));

  server.registerTool("ravex_list_gift_card_catalog", {
    description: "List current Ravex gift card sell brands, rates, and supported denominations. Read-only.",
    inputSchema: {},
  }, async () => result(await ravexRequest("/giftcards/sell/catalog", {}, request)));

  server.registerTool("ravex_purchase_airtime", {
    description: "Purchase Nigerian airtime. Requires user confirmation before execution.",
    inputSchema: {
      amount: z.number().int().min(50).max(100000).describe("Amount in NGN"),
      phone: z.string().regex(/^0\d{10}$/).describe("Nigerian phone number"),
      service_id: z.enum(["mtn", "glo", "airtel", "9mobile"]),
      idempotency_key: z.string().uuid().describe("Unique key for safe retries"),
    },
  }, async ({ amount, phone, service_id, idempotency_key }) => result(await ravexRequest("/airtime", { method: "POST", body: JSON.stringify({ amount, phone, service_id }), headers: { "X-Ravex-Idempotency-Key": idempotency_key } }, request)));

  server.registerTool("ravex_purchase_data", {
    description: "Purchase a Nigerian mobile data bundle. Requires user confirmation before execution.",
    inputSchema: {
      network: z.string().min(1), plan_id: z.string().min(1), phone: z.string().regex(/^0\d{10}$/),
      idempotency_key: z.string().uuid(),
    },
  }, async ({ network, plan_id, phone, idempotency_key }) => result(await ravexRequest("/data", { method: "POST", body: JSON.stringify({ network, plan_id, phone }), headers: { "X-Ravex-Idempotency-Key": idempotency_key } }, request)));

  server.registerTool("ravex_verify_electricity_meter", {
    description: "Verify an electricity meter and retrieve the customer name and minimum amount. Read-only.",
    inputSchema: { service_id: z.string().min(1), meter_no: z.string().min(1), is_prepaid: z.boolean() },
  }, async ({ service_id, meter_no, is_prepaid }) => result(await ravexRequest("/electricity/verify", { method: "POST", body: JSON.stringify({ service_id, meter_no, is_prepaid }) }, request)));

  server.registerTool("ravex_purchase_electricity", {
    description: "Purchase an electricity token or pay a bill. Requires user confirmation before execution.",
    inputSchema: {
      service_id: z.string().min(1), meter_no: z.string().min(1), amount: z.number().positive(), phone: z.string().regex(/^0\d{10}$/), is_prepaid: z.boolean(), idempotency_key: z.string().uuid(),
    },
  }, async (input) => { const { idempotency_key, ...body } = input; return result(await ravexRequest("/electricity", { method: "POST", body: JSON.stringify(body), headers: { "X-Ravex-Idempotency-Key": idempotency_key } }, request)); });

  server.registerTool("ravex_renew_cable", {
    description: "Renew a cable TV subscription. Requires user confirmation before execution.",
    inputSchema: { service_id: z.string().min(1), variation_code: z.string().min(1), billers_code: z.string().min(1), phone: z.string().regex(/^0\d{10}$/), idempotency_key: z.string().uuid() },
  }, async (input) => { const { idempotency_key, ...body } = input; return result(await ravexRequest("/cable", { method: "POST", body: JSON.stringify(body), headers: { "X-Ravex-Idempotency-Key": idempotency_key } }, request)); });

  server.registerTool("ravex_fund_betting_wallet", {
    description: "Fund a betting wallet. Requires user confirmation before execution.",
    inputSchema: { type: z.string().min(1), account_id: z.string().min(1), name: z.string().min(1), amount: z.number().positive(), idempotency_key: z.string().uuid() },
  }, async (input) => { const { idempotency_key, ...body } = input; return result(await ravexRequest("/bet/fund", { method: "POST", body: JSON.stringify(body), headers: { "X-Ravex-Idempotency-Key": idempotency_key } }, request)); });

  server.registerTool("ravex_buy_gift_card", {
    description: "Buy a digital gift card. Requires user confirmation before execution.",
    inputSchema: { product_id: z.string().min(1), amount: z.number().positive(), quantity: z.number().int().positive(), recipient_email: z.string().email(), idempotency_key: z.string().uuid() },
  }, async (input) => { const { idempotency_key, ...body } = input; return result(await ravexRequest("/giftcards", { method: "POST", body: JSON.stringify(body), headers: { "X-Ravex-Idempotency-Key": idempotency_key } }, request)); });

  server.registerTool("ravex_sell_gift_card", {
    description: "Submit a gift card for liquidation. Requires user confirmation before execution.",
    inputSchema: { brand_id: z.string().min(1), amount: z.number().positive(), card_type: z.string().min(1), card_codes: z.array(z.string()).optional(), card_images: z.array(z.string().url()).optional(), idempotency_key: z.string().uuid() },
  }, async (input) => { const { idempotency_key, ...body } = input; return result(await ravexRequest("/giftcards/sell", { method: "POST", body: JSON.stringify(body), headers: { "X-Ravex-Idempotency-Key": idempotency_key } }, request)); });

  server.registerTool("ravex_initiate_bank_transfer", {
    description: "Initiate a Nigerian bank payout. Always require explicit user confirmation immediately before execution.",
    inputSchema: { account_number: z.string().regex(/^\d{10}$/), bank_code: z.string().min(3), amount: z.number().positive(), narration: z.string().max(140).optional(), idempotency_key: z.string().uuid() },
  }, async (input) => { const { idempotency_key, ...body } = input; return result(await ravexRequest("/bank-transfer", { method: "POST", body: JSON.stringify(body), headers: { "X-Ravex-Idempotency-Key": idempotency_key } }, request)); });

  server.registerTool("ravex_create_crypto_charge", {
    description: "Create a crypto deposit charge. Requires user confirmation before execution.",
    inputSchema: { amount_fiat: z.number().positive(), currency_fiat: z.string().length(3), crypto_asset: z.enum(["USDT", "USDC", "BTC", "ETH"]), network: z.enum(["TRC20", "ERC20", "BEP20", "SOL"]), customer_email: z.string().email(), idempotency_key: z.string().uuid() },
  }, async (input) => { const { idempotency_key, ...body } = input; return result(await ravexRequest("/crypto/charge", { method: "POST", body: JSON.stringify(body), headers: { "X-Ravex-Idempotency-Key": idempotency_key } }, request)); });

  server.registerTool("ravex_create_virtual_account", {
    description: "Create a dedicated virtual account. Requires user confirmation and appropriate KYC consent.",
    inputSchema: { account_name: z.string().min(2), customer_email: z.string().email(), bvn_or_nin: z.string().optional(), provider: z.enum(["palmpay", "safehaven"]).optional(), idempotency_key: z.string().uuid() },
  }, async (input) => { const { idempotency_key, ...body } = input; return result(await ravexRequest("/funding/virtual-account", { method: "POST", body: JSON.stringify(body), headers: { "X-Ravex-Idempotency-Key": idempotency_key } }, request)); });
}

function createServer(request?: Request) {
  const server = new McpServer({ name: "ravex", version: "1.0.0" });
  registerTools(server, request);
  return server;
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
