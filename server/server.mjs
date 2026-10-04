import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import { Wacli, WacliError } from "./wacli.mjs";
import { ConnectManager, QR_TTL_SECONDS } from "./connect.mjs";
import { OAuthProvider } from "./oauth.mjs";
import { SyncManager } from "./sync.mjs";
import { Provider, FIELDS, esc, substitute, missingForImprint } from "./provider.mjs";
import { PLANS, planFor, Usage } from "./plans.mjs";
import { Paddle, planChangeFrom } from "./paddle.mjs";
import { Retention } from "./retention.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const WACLI_BIN = process.env.WACLI_BIN || path.join(root, "bin", "wacli");
const TENANTS_FILE = process.env.WACLI_ME_TENANTS || path.join(root, "config", "tenants.json");
const WEB_DIR = path.join(root, "web");
const PROVIDER_FILE = process.env.WACLI_ME_PROVIDER || path.join(root, "config", "provider.json");
const USAGE_FILE = process.env.WACLI_ME_USAGE || path.join(root, "config", "usage.json");
const PADDLE_KEY_FILE = path.join(root, "config", "paddle-api-key.txt");
const PADDLE_WEBHOOK_FILE = path.join(root, "config", "paddle-webhook-secret.txt");
const PADDLE_CLIENT_TOKEN_FILE = path.join(root, "config", "paddle-client-token.txt");
const PADDLE_PRICES = {
  monthly: "pri_01m36y92k8s7z8ageg4c7pwyjm", // 7.99 EUR / month
  yearly: "pri_01m36y933sapcacex02v4s0gx0", // 79.00 EUR / year
};
const REGISTRY_AUTH_FILE = path.join(root, "config", "mcp-registry-auth.txt");
const STORES_DIR = process.env.WACLI_ME_STORES || path.join(root, "stores");
const ISSUER = process.env.WACLI_ME_ISSUER || "https://wacli.me";
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_INLINE_MEDIA_BYTES = 5 * 1024 * 1024;

const SERVER_NAME = "wacli-me";
const SERVER_VERSION = "0.1.0";

// ---------------------------------------------------------------- tenants ---

function loadTenants() {
  if (!fs.existsSync(TENANTS_FILE)) {
    console.warn(`[config] no tenant file at ${TENANTS_FILE} — every MCP request will be rejected`);
    return [];
  }
  const parsed = JSON.parse(fs.readFileSync(TENANTS_FILE, "utf8"));
  const tenants = Array.isArray(parsed) ? parsed : parsed.tenants || [];
  return tenants.map((t) => ({
    id: t.id,
    token: t.token,
    store: t.store,
    allowSend: t.allowSend === true,
    plan: PLANS[t.plan] ? t.plan : "free",
    planUntil: t.planUntil || null,
  }));
}

let tenants = loadTenants();
fs.watchFile(TENANTS_FILE, { interval: 5000 }, () => {
  try {
    tenants = loadTenants();
    console.log(`[config] reloaded ${tenants.length} tenant(s)`);
  } catch (err) {
    console.error(`[config] reload failed: ${err.message}`);
  }
});

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function tenantForRequest(req) {
  const header = req.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const presented = match[1].trim();
  return tenants.find((t) => t.token && timingSafeEqual(t.token, presented)) || null;
}

// ------------------------------------------------------------------ tools ---

function asToolResult(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function asToolError(message) {
  return { isError: true, content: [{ type: "text", text: message }] };
}

async function guard(fn) {
  try {
    return asToolResult(await fn());
  } catch (err) {
    if (err instanceof WacliError) return asToolError(`wacli: ${err.message}`);
    throw err;
  }
}

function buildServer(tenant) {
  const wacli = new Wacli({ bin: WACLI_BIN, store: tenant.store });
  const server = new McpServer(
    {
      name: SERVER_NAME,
      title: "WhatsApp",
      version: SERVER_VERSION,
      websiteUrl: ISSUER,
      // Clients that render a server icon pick these up; the SVG scales, the
      // PNG is there for clients that refuse SVG.
      icons: [
        { src: `${ISSUER}/logo.svg`, mimeType: "image/svg+xml", sizes: ["any"] },
        { src: `${ISSUER}/apple-touch-icon.png`, mimeType: "image/png", sizes: ["180x180"] },
      ],
    },
    {
      instructions:
        "Read and search the connected WhatsApp account. Chats are addressed by JID " +
        "(`...@s.whatsapp.net` for people, `...@lid` for linked ids, `...@g.us` for groups). " +
        "Resolve a name to a JID with list_chats or search_contacts before reading a conversation.",
    },
  );

  server.registerTool(
    "account_status",
    {
      title: "Account status",
      description:
        "Health of the linked WhatsApp account: authenticated, store size, last sync, " +
        "plus the current plan and how much of this month's request allowance is left.",
      inputSchema: {},
    },
    () =>
      guard(async () => {
        const plan = planFor(tenant);
        const seen = usage.peek(tenant.id);
        const limit = plan.requestsPerMonth;
        return {
          ...(await wacli.doctor()),
          plan: plan.id,
          // A client that can see the ceiling coming can pace itself; one that
          // only learns at the 429 cannot.
          requests: {
            used: seen.used,
            limit: limit === Infinity ? null : limit,
            remaining: limit === Infinity ? null : Math.max(0, limit - seen.used),
            resets: seen.month + " (UTC month)",
          },
          historyWindowDays: plan.historyDays,
          deletedAfterIdleDays: plan.idleDays,
          ...(plan.id === "free"
            ? {
                accountId: tenant.id,
                upgrade: {
                  monthly: `${ISSUER}/upgrade?t=${encodeURIComponent(tenant.id)}&cycle=monthly`,
                  yearly: `${ISSUER}/upgrade?t=${encodeURIComponent(tenant.id)}&cycle=yearly`,
                },
              }
            : {}),
        };
      }),
  );

  server.registerTool(
    "list_chats",
    {
      title: "List chats",
      description: "List chats of the linked account, newest activity first.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).default(25).describe("How many chats to return."),
        query: z.string().optional().describe("Filter chats by name."),
        unread: z.boolean().default(false).describe("Only chats with unread messages."),
      },
    },
    (args) => guard(() => wacli.listChats(args)),
  );

  server.registerTool(
    "list_messages",
    {
      title: "List messages",
      description: "Messages of one chat (or across all chats), newest first.",
      inputSchema: {
        chat: z.string().optional().describe("Chat JID. Omit to list across all chats."),
        limit: z.number().int().min(1).max(200).default(25),
        from_me: z.boolean().optional().describe("true = only own messages, false = only received."),
        after: z.string().optional().describe("Only after this time (YYYY-MM-DD or RFC3339)."),
        before: z.string().optional().describe("Only before this time (YYYY-MM-DD or RFC3339)."),
      },
    },
    (args) =>
      guard(() =>
        wacli.listMessages({
          chat: args.chat,
          limit: args.limit,
          fromMe: args.from_me,
          after: args.after,
          before: args.before,
        }),
      ),
  );

  server.registerTool(
    "search_messages",
    {
      title: "Search messages",
      description: "Full-text search across the synced message history.",
      inputSchema: {
        query: z.string().min(1).describe("Search terms."),
        limit: z.number().int().min(1).max(200).default(25),
        chat: z.string().optional().describe("Restrict to one chat JID."),
        after: z.string().optional(),
        before: z.string().optional(),
      },
    },
    (args) => guard(() => wacli.searchMessages(args)),
  );

  server.registerTool(
    "search_contacts",
    {
      title: "Search contacts",
      description: "Find a contact JID by name or number.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(200).default(25),
      },
    },
    (args) => guard(() => wacli.searchContacts(args)),
  );

  server.registerTool(
    "get_chat",
    {
      title: "Get one chat",
      description: "Details of a single chat: name, kind, unread count, mute and pin state.",
      inputSchema: { chat: z.string().min(1).describe("Chat JID.") },
    },
    (args) => guard(() => wacli.getChat(args)),
  );

  server.registerTool(
    "get_message_context",
    {
      title: "Message context",
      description:
        "The messages surrounding one message id — use it after search_messages to see what a hit was answering.",
      inputSchema: {
        chat: z.string().min(1).describe("Chat JID."),
        message_id: z.string().min(1).describe("Message id, as returned by search_messages."),
        before: z.number().int().min(0).max(50).default(5),
        after: z.number().int().min(0).max(50).default(5),
      },
    },
    (args) =>
      guard(() =>
        wacli.getMessageContext({
          chat: args.chat,
          id: args.message_id,
          before: args.before,
          after: args.after,
        }),
      ),
  );

  server.registerTool(
    "list_starred",
    {
      title: "List starred messages",
      description: "Messages the account owner starred — usually the things they wanted to keep.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).default(25),
        chat: z.string().optional().describe("Restrict to one chat JID."),
      },
    },
    (args) => guard(() => wacli.listStarred(args)),
  );

  server.registerTool(
    "list_calls",
    {
      title: "List calls",
      description: "Call events: who called, when, and whether it was answered or missed.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).default(25),
        chat: z.string().optional(),
        after: z.string().optional().describe("YYYY-MM-DD or RFC3339."),
        before: z.string().optional(),
      },
    },
    (args) => guard(() => wacli.listCalls(args)),
  );

  server.registerTool(
    "list_groups",
    {
      title: "List groups",
      description: "Groups the account belongs to.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).default(25),
        query: z.string().optional().describe("Filter by group name."),
      },
    },
    (args) => guard(() => wacli.listGroups(args)),
  );

  server.registerTool(
    "get_group",
    {
      title: "Group details",
      description: "Subject, description, participants and admins of one group.",
      inputSchema: { group: z.string().min(1).describe("Group JID, ending in @g.us.") },
    },
    (args) => guard(() => wacli.getGroup(args)),
  );

  server.registerTool(
    "history_coverage",
    {
      title: "History coverage",
      description:
        "How far back synced history reaches per chat. Answer 'do I even have that conversation' before searching it.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).default(25),
        query: z.string().optional().describe("Filter chats by name or JID."),
        chat: z.string().optional().describe("Inspect one chat JID."),
      },
    },
    (args) => guard(() => wacli.historyCoverage(args)),
  );

  server.registerTool(
    "get_media",
    {
      title: "Get media from a message",
      description:
        "Download the image attached to a message and return it. Images come back as an image; other media types report their metadata instead.",
      inputSchema: {
        chat: z.string().min(1).describe("Chat JID."),
        message_id: z.string().min(1).describe("Message id of the message holding the media."),
      },
    },
    async (args) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wacli-media-"));
      try {
        const result = await wacli.downloadMedia({ chat: args.chat, id: args.message_id, outputDir: dir });
        const file = fs.readdirSync(dir).map((name) => path.join(dir, name))[0];
        if (!file) return asToolError("wacli downloaded no file for that message id.");

        const mime = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
        const bytes = fs.statSync(file).size;
        if (!mime.startsWith("image/") || bytes > MAX_INLINE_MEDIA_BYTES) {
          return asToolResult({ ...result, media_type: mime, bytes, inline: false });
        }
        return {
          content: [
            { type: "image", mimeType: mime, data: fs.readFileSync(file).toString("base64") },
            { type: "text", text: JSON.stringify({ media_type: mime, bytes }, null, 2) },
          ],
        };
      } catch (err) {
        if (err instanceof WacliError) return asToolError(`wacli: ${err.message}`);
        throw err;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  if (tenant.allowSend) {
    server.registerTool(
      "send_message",
      {
        title: "Send a WhatsApp message",
        description:
          "Send a text message from the linked account, to an existing chat or to a phone number that has never been messaged before. This is irreversible — confirm recipient and wording with the user first.",
        inputSchema: {
          to: z
            .string()
            .min(1)
            .describe("Recipient JID, phone number in international format, or exact chat name."),
          message: z.string().min(1).describe("Message text."),
        },
        annotations: { destructiveHint: false, openWorldHint: true, readOnlyHint: false },
      },
      (args) => guard(() => wacli.sendText(args)),
    );

    server.registerTool(
      "check_numbers_on_whatsapp",
      {
        title: "Check whether numbers use WhatsApp",
        description:
          "Ask WhatsApp whether phone numbers are registered, before messaging someone new. This is a live lookup against WhatsApp — only check numbers the user actually intends to contact.",
        inputSchema: {
          numbers: z
            .array(z.string().min(5))
            .min(1)
            .max(20)
            .describe("Phone numbers in international format, e.g. +4917612345678."),
        },
        annotations: { destructiveHint: false, openWorldHint: true, readOnlyHint: false },
      },
      (args) => guard(() => wacli.checkNumbers(args)),
    );

    server.registerTool(
      "react_to_message",
      {
        title: "React to a message",
        description:
          "Put an emoji reaction on a message, or remove one by passing an empty reaction. Visible to everyone in the chat.",
        inputSchema: {
          to: z.string().min(1).describe("Chat JID, phone number, or exact chat name."),
          message_id: z.string().min(1).describe("Target message id."),
          reaction: z.string().default("👍").describe("Emoji; empty string removes the reaction."),
          sender: z.string().optional().describe("Sender JID of the target message — required in groups."),
        },
        annotations: { destructiveHint: false, openWorldHint: true, readOnlyHint: false },
      },
      (args) =>
        guard(() =>
          wacli.react({ to: args.to, id: args.message_id, reaction: args.reaction, sender: args.sender }),
        ),
    );

    server.registerTool(
      "mark_chat_read",
      {
        title: "Mark a chat as read",
        description:
          "Clear the unread badge on a chat. Sends read receipts, so the other side can see it — use it after actually reading the messages.",
        inputSchema: { chat: z.string().min(1).describe("Chat JID, phone number, or exact chat name.") },
        annotations: { destructiveHint: false, openWorldHint: true, readOnlyHint: false },
      },
      (args) => guard(() => wacli.markRead(args)),
    );
  }

  return server;
}

// ---------------------------------------------------------------- connect ---

const provider = new Provider(PROVIDER_FILE);
const usage = new Usage(USAGE_FILE);
const paddle = new Paddle({
  apiKeyFile: PADDLE_KEY_FILE,
  webhookSecretFile: PADDLE_WEBHOOK_FILE,
  clientTokenFile: PADDLE_CLIENT_TOKEN_FILE,
  prices: PADDLE_PRICES,
  checkoutUrl: `${ISSUER}/checkout`,
});

// The webhook and the admin form both edit the same file, so read-modify-write
// it in one go rather than holding a parsed copy around.
function patchTenant(tenantId, patch) {
  const parsed = JSON.parse(fs.readFileSync(TENANTS_FILE, "utf8"));
  const list = Array.isArray(parsed) ? parsed : parsed.tenants || [];
  const found = list.find((t) => t.id === tenantId);
  if (!found) return false;
  Object.assign(found, patch);
  fs.writeFileSync(TENANTS_FILE, JSON.stringify(parsed, null, 2), { mode: 0o600 });
  tenants = loadTenants();
  return true;
}

async function handleUpgrade(req, res, url) {
  const tenantId = url.searchParams.get("t") || "";
  const cycle = url.searchParams.get("cycle") === "yearly" ? "yearly" : "monthly";
  const known = tenants.find((t) => t.id === tenantId);
  if (!known) {
    sendHtmlMessage(res, 404, "Unknown account", "That account id does not exist. Open the endpoint your client uses and check account_status for the current one.");
    return;
  }
  if (!paddle.configured) {
    sendHtmlMessage(res, 503, "Checkout not available yet", "Paid plans are not switched on for this host. Nothing is charged and nothing is broken — try again later.");
    return;
  }
  try {
    const { url: checkout } = await paddle.createCheckout({ tenantId, cycle });
    res.writeHead(302, { location: checkout, "cache-control": "no-store" });
    res.end();
  } catch (err) {
    console.error(`[upgrade] ${err.message}`);
    sendHtmlMessage(res, 502, "Could not start the checkout", "Our payment provider did not answer. Nothing was charged. Please try again in a minute.");
  }
}

async function handlePaddleWebhook(req, res) {
  const raw = await readBody(req);
  const verdict = paddle.verify(raw, req.headers["paddle-signature"]);
  if (!verdict.ok) {
    // Anyone can POST here; say as little as possible about why it failed.
    console.warn(`[paddle] rejected notification: ${verdict.reason}`);
    sendJson(res, 401, { error: "invalid signature" });
    return;
  }

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: "invalid JSON" });
    return;
  }

  const change = planChangeFrom(event);
  // Always 200 for a verified notification, even one we ignore — a non-2xx
  // makes Paddle retry something that will never succeed.
  if (!change) {
    sendJson(res, 200, { ok: true, ignored: event.event_type });
    return;
  }

  const applied = patchTenant(change.tenant, {
    plan: change.plan,
    planUntil: change.planUntil,
    paddleSubscriptionId: change.subscriptionId,
  });
  console.log(
    applied
      ? `[paddle] ${change.tenant} -> ${change.plan} until ${change.planUntil || "n/a"} (${change.reason})`
      : `[paddle] notification for unknown tenant ${change.tenant} (${change.reason})`,
  );
  sendJson(res, 200, { ok: true });
}
const syncMode = process.env.WACLI_SYNC_MODE === "continuous" ? "continuous" : "on-request";
const configuredSyncIdleMs = Number.parseInt(process.env.WACLI_SYNC_IDLE_MS || "5000", 10);
const sync = new SyncManager({
  wacliBin: WACLI_BIN,
  logDir: path.join(root, "logs"),
  mode: syncMode,
  idleMs: configuredSyncIdleMs,
});

const connect = new ConnectManager({
  wacliBin: WACLI_BIN,
  storesDir: STORES_DIR,
  tenantsFile: TENANTS_FILE,
  onLinked: (session) => sync.ensure(session.store),
  followAfterLink: sync.mode === "continuous",
});

async function handleConnectStart(req, res) {
  const raw = await readBody(req);
  let body = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    sendJson(res, 400, { error: "invalid JSON" });
    return;
  }
  try {
    const session = connect.start({ allowSend: body.allowSend === true, dpa: body.dpa === true });
    sendJson(res, 200, { session: session.id, qrTtlSeconds: QR_TTL_SECONDS });
  } catch (err) {
    sendJson(res, err.code === "BUSY" ? 503 : 500, { error: err.message });
  }
}

async function handleConnectPermissions(req, res) {
  const raw = await readBody(req);
  let body = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    sendJson(res, 400, { error: "invalid JSON" });
    return;
  }
  const session = connect.get(body.session || "");
  if (!session) {
    sendJson(res, 404, { error: "unknown or expired session" });
    return;
  }
  // Only the keys actually sent are applied, so toggling one checkbox cannot
  // silently reset the other.
  const patch = {};
  if ("allowSend" in body) patch.allowSend = body.allowSend === true;
  if ("dpa" in body) patch.dpa = body.dpa === true;
  const changed = connect.setPermissions(session, patch);
  sendJson(
    res,
    changed ? 200 : 409,
    changed ? { allowSend: session.allowSend, dpa: session.dpa } : { error: "session already finished" },
  );
}

// Sent with navigator.sendBeacon when the tab goes away, so the body may be
// text/plain rather than JSON. Never fails loudly: it is best-effort cleanup.
async function handleConnectCancel(req, res) {
  const raw = await readBody(req);
  let id = "";
  try {
    id = (raw ? JSON.parse(raw) : {}).session || "";
  } catch {
    id = String(raw || "").trim();
  }
  const session = connect.get(id);
  if (session) connect.cancel(session);
  sendJson(res, 200, { ok: true });
}

function handleConnectStream(req, res, url) {
  const session = connect.get(url.searchParams.get("s") || "");
  if (!session) {
    sendJson(res, 404, { error: "unknown or expired session" });
    return;
  }
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const unsubscribe = connect.subscribe(session, (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    if (payload.status !== "waiting") res.end();
  });
  const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
  req.on("close", () => {
    clearInterval(ping);
    unsubscribe();
  });
}


// ------------------------------------------------------------------ admin ---
// One small form for the provider details on the legal pages. Guarded by a
// token that is generated on first start and lives in config/admin-token.txt;
// there is no password to guess and no session to steal.

function adminPage(token, saved) {
  const data = provider.read();
  const missing = missingForImprint(data);
  const rows = FIELDS.map(function (field) {
    const hint = field.hint ? '<span class="hint">' + esc(field.hint) + "</span>" : "";
    return (
      '<label><span class="lbl">' + esc(field.label) + "</span>" + hint +
      '<input name="' + esc(field.key) + '" value="' + esc(data[field.key] || "") +
      '" autocapitalize="off" autocomplete="off" spellcheck="false"></label>'
    );
  }).join("\n");

  return `<!doctype html>
<html lang="de"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Anbieterangaben — wacli.me</title>
<style>
  :root{color-scheme:dark;--bg:#070c0a;--soft:#0d1512;--line:#1e2b25;--ink:#e8f2ed;--dim:#9db3a9;--faint:#63756d;--accent:#00d17f}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:20px 16px 60px}
  .wrap{max-width:520px;margin:0 auto}
  h1{font-size:22px;margin:0 0 6px}
  p.sub{color:var(--dim);font-size:14px;margin:0 0 24px}
  label{display:block;margin:0 0 16px}
  .lbl{display:block;font-size:14px;font-weight:600;margin-bottom:4px}
  .hint{display:block;font-size:12.5px;color:var(--faint);margin-bottom:6px}
  input{width:100%;padding:12px 14px;border:1px solid var(--line);border-radius:10px;
        background:var(--soft);color:var(--ink);font:15px/1.4 inherit}
  input:focus{outline:none;border-color:var(--accent)}
  button{width:100%;padding:14px;border:0;border-radius:10px;background:var(--accent);
         color:#04150e;font:600 16px inherit;cursor:pointer;margin-top:8px}
  button:active{transform:scale(.99)}
  .ok{background:rgba(0,209,127,.1);border:1px solid rgba(0,209,127,.35);color:var(--accent);
      padding:12px 14px;border-radius:10px;margin:0 0 20px;font-size:14.5px}
  .todo{background:rgba(255,196,107,.07);border:1px solid rgba(255,196,107,.28);color:#e9c98d;
        padding:12px 14px;border-radius:10px;margin:0 0 20px;font-size:14.5px;line-height:1.45}
  .todo strong{color:#ffd79a}
  .links{margin-top:26px;font-size:14px;color:var(--faint)}
  .links a{color:var(--dim)}
</style></head><body><div class="wrap">
<h1>Anbieterangaben</h1>
<p class="sub">Wird sofort auf Impressum, Datenschutz, Nutzungsbedingungen und in der Fußzeile übernommen. Leere Felder werden weggelassen.</p>
${saved ? '<div class="ok">Gespeichert und live.</div>' : ""}
${
  missing.length
    ? '<div class="todo">Für ein vollständiges Impressum fehlt noch: <strong>' +
      missing.map(esc).join(", ") +
      "</strong>. Bis dahin bleibt der Alpha-Hinweis im Impressum stehen — was schon eingetragen ist, wird aber bereits angezeigt.</div>"
    : '<div class="ok">Impressum ist vollständig, der Alpha-Hinweis ist weg.</div>'
}
<form method="POST" action="/admin">
<input type="hidden" name="k" value="${esc(token || "")}">
${rows}
<button type="submit">Speichern</button>
</form>
<p class="links"><a href="/imprint">Impressum ansehen</a> · <a href="/privacy">Datenschutz</a> · <a href="/terms">Nutzungsbedingungen</a></p>
</div></body></html>`;
}

// One-time links, so the permanent token never has to travel through a chat or
// a messenger. A code is valid for fifteen minutes and dies on first use; what
// it leaves behind is a session cookie that lasts twelve hours. Both live in
// memory only — a restart simply asks for a new link.
const OTL_TTL_MS = 60 * 60_000;
const SESSION_TTL_MS = 12 * 60 * 60_000;
// A link may be opened a few times: messengers and browsers fetch URLs once on
// their own to build a preview, and burning the code on that fetch would hand
// the real visitor a 404.
const OTL_MAX_USES = 3;
const oneTimeCodes = new Map();

function mintOneTimeLink() {
  const code = crypto.randomBytes(18).toString("base64url");
  oneTimeCodes.set(code, { expires: Date.now() + OTL_TTL_MS, uses: 0 });
  for (const [key, entry] of oneTimeCodes) if (entry.expires < Date.now()) oneTimeCodes.delete(key);
  return `${ISSUER}/admin/link/${code}`;
}

// The cookie carries its own expiry plus a signature over it, so nothing has to
// be remembered here — a deploy restarts the server, and an in-memory session
// would log the editor out on every save.
function signSession(expires) {
  const mac = crypto.createHmac("sha256", provider.token()).update(String(expires)).digest("base64url");
  return `${expires}.${mac}`;
}

function sessionFrom(req) {
  const raw = req.headers.cookie || "";
  const match = /(?:^|;\s*)wm_admin=([0-9]+\.[A-Za-z0-9_-]+)/.exec(raw);
  if (!match) return null;
  const expires = Number(match[1].split(".")[0]);
  if (!Number.isFinite(expires) || expires < Date.now()) return null;
  const want = Buffer.from(signSession(expires));
  const got = Buffer.from(match[1]);
  return want.length === got.length && crypto.timingSafeEqual(want, got) ? match[1] : null;
}

function adminAllowed(req, candidate) {
  return provider.checkToken(candidate) || Boolean(sessionFrom(req));
}

function handleAdminLink(req, res, urlPath) {
  const code = urlPath.slice("/admin/link/".length);
  const entry = oneTimeCodes.get(code);
  if (!entry || entry.expires < Date.now()) {
    oneTimeCodes.delete(code);
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
    return;
  }
  entry.uses += 1;
  if (entry.uses >= OTL_MAX_USES) oneTimeCodes.delete(code);
  const expires = Date.now() + SESSION_TTL_MS;
  res.writeHead(303, {
    location: "/admin",
    "set-cookie": `wm_admin=${signSession(expires)}; HttpOnly; Secure; SameSite=Lax; Path=/admin; Max-Age=${SESSION_TTL_MS / 1000}`,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  res.end();
}

async function handleAdminMint(req, res) {
  // Only reachable with the permanent token, and only over the loopback: this
  // is the one place that hands out access.
  if (!provider.checkToken(req.headers["x-admin-token"])) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
    return;
  }
  sendJson(res, 200, { url: mintOneTimeLink(), expiresInMinutes: OTL_TTL_MS / 60_000 });
}

function handleAdminGet(req, res, url) {
  const token = url.searchParams.get("k") || "";
  if (!adminAllowed(req, token)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
    return;
  }
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-robots-tag": "noindex",
  });
  res.end(adminPage(token, url.searchParams.get("saved") === "1"));
}

async function handleAdminPost(req, res) {
  const raw = await readBody(req);
  const form = new URLSearchParams(raw);
  if (!adminAllowed(req, form.get("k"))) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
    return;
  }
  const values = {};
  for (const field of FIELDS) values[field.key] = form.get(field.key) || "";
  provider.write(values);
  const back = provider.checkToken(form.get("k"))
    ? "/admin?k=" + encodeURIComponent(form.get("k")) + "&saved=1"
    : "/admin?saved=1";
  res.writeHead(303, { location: back, "cache-control": "no-store" });
  res.end();
}

// ------------------------------------------------------------------ oauth ---

const oauth = new OAuthProvider({ issuer: ISSUER });

async function handleOAuthRegister(req, res) {
  const raw = await readBody(req);
  let body;
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    sendJson(res, 400, { error: "invalid_client_metadata", error_description: "body is not JSON" });
    return;
  }
  try {
    sendJson(res, 201, oauth.register(body));
  } catch (err) {
    sendJson(res, 400, { error: err.code || "invalid_client_metadata", error_description: err.message });
  }
}

function handleOAuthAuthorize(req, res, url) {
  const outcome = oauth.beginAuthorization(url.searchParams);

  if (outcome.error) {
    res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta charset="utf-8"><title>Authorization error</title>` +
      `<body style="font:16px/1.6 system-ui;background:#070c0a;color:#e8f2ed;padding:48px">` +
      `<h1 style="font-size:22px">Authorization error</h1><p>${outcome.error}</p>` +
      `<p><a style="color:#00d17f" href="/">wacli.me</a></p></body>`);
    return;
  }

  if (outcome.redirectError) {
    const target = new URL(outcome.redirectUri);
    target.searchParams.set("error", outcome.redirectError);
    if (outcome.state) target.searchParams.set("state", outcome.state);
    res.writeHead(302, { location: target.toString() }).end();
    return;
  }

  // The linking page doubles as the authorization screen; it posts back to
  // /api/connect/finish once WhatsApp confirms and then follows the redirect.
  const target = new URL("/connect", ISSUER);
  target.searchParams.set("auth", outcome.pendingId);
  target.searchParams.set("client", outcome.clientName);
  res.writeHead(302, { location: target.pathname + target.search }).end();
}

async function handleOAuthToken(req, res) {
  const raw = await readBody(req);
  const contentType = req.headers["content-type"] || "";
  let body = {};
  try {
    body = contentType.includes("application/json")
      ? JSON.parse(raw || "{}")
      : Object.fromEntries(new URLSearchParams(raw));
  } catch {
    sendJson(res, 400, { error: "invalid_request" });
    return;
  }

  const result = oauth.exchange(body);
  if (result.error) {
    sendJson(res, 400, { error: result.error });
    return;
  }
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(result.token));
}

async function handleConnectFinish(req, res) {
  const raw = await readBody(req);
  let body = {};
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    sendJson(res, 400, { error: "invalid JSON" });
    return;
  }

  const session = connect.get(body.session || "");
  if (!session || session.status !== "linked" || !session.token) {
    sendJson(res, 409, { error: "session is not linked" });
    return;
  }
  const redirect = oauth.completeAuthorization(body.auth || "", session.token);
  if (!redirect) {
    sendJson(res, 410, { error: "this authorization request expired — start again from your client" });
    return;
  }
  sendJson(res, 200, { redirect });
}

// ------------------------------------------------------------------- http ---

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// A plain page for the few moments a visitor lands on an error instead of a
// checkout. Deliberately not the site layout: this must render even if the
// build output is missing.
function sendHtmlMessage(res, status, heading, detail) {
  const body =
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex"><title>${esc(heading)} — wacli.me</title>` +
    `<body style="margin:0;background:#070c0a;color:#e8f2ed;font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh">` +
    `<main style="max-width:44ch;padding:24px;text-align:center">` +
    `<h1 style="font-size:21px;margin:0 0 12px">${esc(heading)}</h1>` +
    `<p style="color:#93a79e;line-height:1.6;margin:0 0 20px">${esc(detail)}</p>` +
    `<p><a href="/pricing" style="color:#00d17f">Back to pricing</a></p></main>`;
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function rpcError(res, status, code, message) {
  sendJson(res, status, { jsonrpc: "2.0", id: null, error: { code, message } });
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function readFirst(candidates) {
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return { file: candidate, data: fs.readFileSync(candidate) };
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function serveStatic(req, res, urlPath) {
  let decoded;
  try {
    // A path like /%  is not valid percent-encoding. Without this guard the
    // URIError escapes the request handler and takes the whole process down.
    decoded = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath);
  } catch {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end("bad request");
    return;
  }
  const rel = decoded.replace(/^\/+|\/+$/g, "");
  const base = path.resolve(WEB_DIR, rel);
  if (base !== WEB_DIR && !base.startsWith(WEB_DIR + path.sep)) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end("forbidden");
    return;
  }

  // Clean URLs: /privacy also serves web/privacy.html.
  const hit = readFirst(path.extname(base) ? [base] : [base, `${base}.html`, path.join(base, "index.html")]);
  if (!hit) {
    const notFound = readFirst([path.join(WEB_DIR, "404.html")]);
    res.writeHead(404, { "content-type": notFound ? MIME[".html"] : "text/plain; charset=utf-8" });
    res.end(notFound ? notFound.data : "not found");
    return;
  }

  const ext = path.extname(hit.file);
  // The legal pages and the footer carry {{provider_*}} placeholders. They are
  // filled here rather than at build time, so a deploy from the laptop cannot
  // overwrite details maintained on this host.
  let body = hit.data;
  if (ext === ".html") {
    const filled = substitute(body.toString("utf8"), provider.read());
    body = Buffer.from(filled, "utf8");
  }
  res.writeHead(200, {
    "content-type": MIME[ext] || "application/octet-stream",
    // HTML must not sit in an edge cache while the content still changes daily.
    "cache-control": ext === ".html" ? "no-cache" : "public, max-age=300",
    "referrer-policy": "strict-origin-when-cross-origin",
    "x-content-type-options": "nosniff",
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

async function handleMcp(req, res) {
  const tenant = tenantForRequest(req);
  if (!tenant) {
    res.setHeader(
      "WWW-Authenticate",
      `Bearer realm="wacli", error="invalid_token", resource_metadata="${ISSUER}/.well-known/oauth-protected-resource"`,
    );
    rpcError(res, 401, -32001, "Missing or invalid bearer token.");
    return;
  }

  let parsedBody;
  if (req.method === "POST") {
    const raw = await readBody(req);
    try {
      parsedBody = raw ? JSON.parse(raw) : undefined;
    } catch {
      rpcError(res, 400, -32700, "Parse error: body is not valid JSON.");
      return;
    }
  }

  // Only tools/call counts against the quota. initialize, tools/list and the
  // rest are protocol chatter a client makes on every connection; billing them
  // would mean a client that merely connects burns someone's month.
  const plan = planFor(tenant);
  const isToolCall = parsedBody && parsedBody.method === "tools/call";
  if (isToolCall) {
    const verdict = usage.consume(tenant.id, plan);
    if (!verdict.ok) {
      rpcError(
        res,
        429,
        -32003,
        `Monthly request limit reached (${verdict.limit} on the ${plan.label} plan). ` +
          `It resets on the 1st. To lift it: ${ISSUER}/pricing`,
      );
      return;
    }
  } else {
    usage.touch(tenant.id);
  }

  let releaseSync = () => {};
  if (isToolCall) {
    try {
      releaseSync = await sync.acquireForRequest(tenant.store);
    } catch (err) {
      console.error(`[sync] request startup failed for ${tenant.id}: ${err.message}`);
      rpcError(res, 503, -32002, "WhatsApp could not be reached. Please retry the request.");
      return;
    }
  }

  // Stateless: a fresh server + transport per request, so tenants never share state.
  const server = buildServer(tenant);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  } finally {
    releaseSync();
  }
}

function route(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "wacli.me"}`);
  const urlPath = url.pathname;

  if (urlPath === "/healthz") {
    const syncs = sync.status();
    sendJson(res, 200, {
      ok: true,
      tenants: tenants.length,
      syncs: syncs.filter((s) => s.alive).length,
      version: SERVER_VERSION,
    });
    return;
  }

  if (urlPath === "/.well-known/oauth-protected-resource" ||
      urlPath === "/.well-known/oauth-protected-resource/mcp") {
    sendJson(res, 200, oauth.protectedResourceMetadata());
    return;
  }

  if (urlPath === "/.well-known/oauth-authorization-server" ||
      urlPath === "/.well-known/openid-configuration") {
    sendJson(res, 200, oauth.authorizationServerMetadata());
    return;
  }

  if (urlPath === "/oauth/register" && req.method === "POST") {
    handleOAuthRegister(req, res).catch(() => sendJson(res, 500, { error: "server_error" }));
    return;
  }

  if (urlPath === "/oauth/authorize") {
    handleOAuthAuthorize(req, res, url);
    return;
  }

  if (urlPath === "/oauth/token" && req.method === "POST") {
    handleOAuthToken(req, res).catch(() => sendJson(res, 500, { error: "server_error" }));
    return;
  }

  if (urlPath === "/api/connect/finish" && req.method === "POST") {
    handleConnectFinish(req, res).catch(() => sendJson(res, 500, { error: "internal error" }));
    return;
  }

  if (urlPath === "/api/connect/start" && req.method === "POST") {
    handleConnectStart(req, res).catch(() => sendJson(res, 500, { error: "internal error" }));
    return;
  }

  // Domain proof for the official MCP registry: it fetches this path and checks
  // that the public key here signed the publish request. The file holds only a
  // public key, the private half never leaves the laptop.
  if (urlPath === "/.well-known/mcp-registry-auth") {
    let proof = "";
    try {
      proof = fs.readFileSync(REGISTRY_AUTH_FILE, "utf8").trim();
    } catch {
      /* not set up */
    }
    if (!proof) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache" });
    res.end(proof + "\n");
    return;
  }

  if (urlPath.startsWith("/admin/link/")) {
    handleAdminLink(req, res, urlPath);
    return;
  }

  if (urlPath === "/admin/mint" && req.method === "POST") {
    handleAdminMint(req, res).catch(() => sendJson(res, 500, { error: "internal error" }));
    return;
  }

  // Paddle sends the buyer here with ?_ptxn=<transaction>. Paddle.js reads that
  // parameter itself and opens the overlay; the page only has to exist, load
  // the script and say something while it does.
  if (urlPath === "/checkout") {
    const token = paddle.clientToken;
    const body = token
      ? `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<meta name="robots" content="noindex"><title>Checkout — wacli.me</title>` +
        `<script src="https://cdn.paddle.com/paddle/v2/paddle.js"></script>` +
        `<body style="margin:0;background:#070c0a;color:#e8f2ed;font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh">` +
        `<main style="max-width:40ch;padding:24px;text-align:center">` +
        `<h1 style="font-size:20px;margin:0 0 10px">Opening the checkout…</h1>` +
        `<p style="color:#93a79e;line-height:1.6">Paddle handles the payment and the VAT. If nothing appears, your browser may be blocking it — ` +
        `<a href="/pricing" style="color:#00d17f">go back</a> and try again.</p></main>` +
        `<script>Paddle.Initialize({token:${JSON.stringify(token)}});</script>`
      : null;
    if (!body) {
      sendHtmlMessage(res, 503, "Checkout not available yet", "Paid plans are not switched on for this host. Nothing was charged.");
      return;
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store",
    });
    res.end(body);
    return;
  }

  if (urlPath === "/upgrade") {
    handleUpgrade(req, res, url).catch(() => {
      sendHtmlMessage(res, 500, "Something went wrong", "Nothing was charged. Please try again.");
    });
    return;
  }

  if (urlPath === "/api/paddle/webhook" && req.method === "POST") {
    handlePaddleWebhook(req, res).catch((err) => {
      console.error(`[paddle] handler failed: ${err.message}`);
      sendJson(res, 500, { error: "internal error" });
    });
    return;
  }

  if (urlPath === "/admin") {
    if (req.method === "POST") {
      handleAdminPost(req, res).catch(() => sendJson(res, 500, { error: "internal error" }));
    } else {
      handleAdminGet(req, res, url);
    }
    return;
  }

  if (urlPath === "/api/connect/permissions" && req.method === "POST") {
    handleConnectPermissions(req, res).catch(() => sendJson(res, 500, { error: "internal error" }));
    return;
  }

  if (urlPath === "/api/connect/cancel" && req.method === "POST") {
    handleConnectCancel(req, res).catch(() => sendJson(res, 200, { ok: true }));
    return;
  }

  if (urlPath === "/api/connect/stream") {
    handleConnectStream(req, res, url);
    return;
  }

  if (urlPath === "/mcp") {
    handleMcp(req, res).catch((err) => {
      console.error("[mcp]", err);
      if (!res.headersSent) rpcError(res, 500, -32603, "Internal server error.");
      else res.end();
    });
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    serveStatic(req, res, urlPath);
    return;
  }

  res.writeHead(405, { "content-type": "text/plain; charset=utf-8" }).end("method not allowed");
}

// A throw inside the request listener would otherwise be an uncaught exception,
// and one malformed request would end the process for everybody.
const httpServer = http.createServer((req, res) => {
  try {
    route(req, res);
  } catch (err) {
    console.error("[http]", err);
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("internal server error");
  }
});

// Every linked account needs its sync daemon back after a restart.
fs.mkdirSync(path.join(root, "logs"), { recursive: true });
sync.ensureAll(tenants);

const retention = new Retention({
  wacliBin: WACLI_BIN,
  tenantsFile: TENANTS_FILE,
  usage,
  sync,
  planFor,
});
retention.start();

httpServer.listen(PORT, HOST, () => {
  console.log(`[wacli-me] http://${HOST}:${PORT} — MCP at /mcp — ${tenants.length} tenant(s)`);
  console.log(`[wacli-me] binary: ${WACLI_BIN}`);
  console.log(`[wacli-me] retention: free stores pruned at ${PLANS.free.historyDays}d, removed after ${PLANS.free.idleDays}d idle`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    // Counts live in memory between flushes; losing a restart's worth of them
    // would hand people free requests every deploy.
    usage.flush();
    retention.stop();
    sync.stopAll();
    httpServer.close(() => process.exit(0));
  });
}
