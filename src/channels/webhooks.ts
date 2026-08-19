/**
 * Inbound channel webhooks (SPEC 4, ARCHITECTURE.md "Request flow").
 *
 * A message hits a Worker, the Worker resolves the sender to a user_id and
 * routes to that user's Durable Object. Nothing here calls a model directly;
 * that happens inside the Durable Object where context assembly lives.
 */

import { getAgentByName } from "agents";
import { redeemPairingToken } from "./linking";
import { replyOn, type Channel } from "./outbound";

/** Telegram sends the pairing token as "/start <token>". */
const TELEGRAM_START = /^\/start\s+([a-z0-9]+)/i;
/** WhatsApp click-to-chat prefills a plain "link <token>" message. */
const WHATSAPP_LINK = /^link\s+([a-z0-9]+)/i;

async function resolveUser(
  env: Env,
  channel: Channel,
  channelUserId: string
): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT user_id FROM connections WHERE channel = ? AND channel_user_id = ?`
  )
    .bind(channel, channelUserId)
    .first<{ user_id: string }>();
  return row?.user_id ?? null;
}

/**
 * Shared inbound path for both channels.
 * Linking is handled before anything reaches a model.
 */
async function handleInboundMessage(
  env: Env,
  channel: Channel,
  channelUserId: string,
  text: string,
  channelPhone: string | null
): Promise<void> {
  const linkMatch = text.match(channel === "telegram" ? TELEGRAM_START : WHATSAPP_LINK);

  if (linkMatch) {
    const result = await redeemPairingToken(env, linkMatch[1]!, channel, channelUserId, channelPhone);

    if (!result.ok) {
      await replyOn(env, channel, channelUserId, result.reason);
      return;
    }

    // The assistant asks once about a number mismatch, per SPEC 4.3 step 6.
    const greeting = result.numberMismatch
      ? `Connected. The number on this account is ${result.storedNumber}, but this ${channel} account uses a different one. Shall I update it to this one?`
      : "Connected. I am ready when you are.";

    await replyOn(env, channel, channelUserId, greeting);
    return;
  }

  const userId = await resolveUser(env, channel, channelUserId);
  if (!userId) {
    await replyOn(
      env,
      channel,
      channelUserId,
      "I do not recognise this number yet. Start at wis.ai and connect this channel from your account."
    );
    return;
  }

  const agent = await getAgentByName(env.USER_AGENT, userId);
  await agent.handleInbound({ channel, text });
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

type TelegramUpdate = {
  message?: {
    text?: string;
    chat?: { id: number };
    contact?: { phone_number?: string };
  };
};

export async function telegramWebhook(request: Request, env: Env): Promise<Response> {
  // Telegram authenticates webhooks with a secret header set at registration.
  if (env.TELEGRAM_WEBHOOK_SECRET) {
    const provided = request.headers.get("x-telegram-bot-api-secret-token");
    if (provided !== env.TELEGRAM_WEBHOOK_SECRET) {
      return new Response("forbidden", { status: 403 });
    }
  }

  const update = (await request.json().catch(() => null)) as TelegramUpdate | null;
  const chatId = update?.message?.chat?.id;
  const text = update?.message?.text;

  if (chatId && text) {
    await handleInboundMessage(
      env,
      "telegram",
      String(chatId),
      text,
      update?.message?.contact?.phone_number ?? null
    );
  }

  // Always 200: Telegram retries aggressively on anything else.
  return new Response("ok");
}

// ---------------------------------------------------------------------------
// WhatsApp (Meta Cloud API)
// ---------------------------------------------------------------------------

type WhatsAppPayload = {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: Array<{ from?: string; text?: { body?: string } }>;
      };
    }>;
  }>;
};

export async function whatsappWebhook(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  // Meta's subscription handshake.
  if (request.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    if (mode === "subscribe" && token && token === env.WHATSAPP_VERIFY_TOKEN) {
      return new Response(challenge ?? "");
    }
    return new Response("forbidden", { status: 403 });
  }

  const raw = await request.text();

  if (env.WHATSAPP_APP_SECRET) {
    const signature = request.headers.get("x-hub-signature-256");
    if (!(await verifyMetaSignature(env.WHATSAPP_APP_SECRET, raw, signature))) {
      return new Response("forbidden", { status: 403 });
    }
  }

  const payload = safeJson<WhatsAppPayload>(raw);
  const messages = payload?.entry?.[0]?.changes?.[0]?.value?.messages ?? [];

  for (const message of messages) {
    const from = message.from;
    const text = message.text?.body;
    if (from && text) {
      await handleInboundMessage(env, "whatsapp", from, text, from);
    }
  }

  return new Response("ok");
}

async function verifyMetaSignature(
  secret: string,
  body: string,
  header: string | null
): Promise<boolean> {
  if (!header?.startsWith("sha256=")) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const expected = [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const provided = header.slice("sha256=".length);
  if (provided.length !== expected.length) return false;

  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return diff === 0;
}

function safeJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
