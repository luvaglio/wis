/**
 * Outbound delivery (SPEC 4.2).
 *
 * A user may have both channels linked at once, but only one channel is
 * "active" for proactive, assistant-initiated outbound messages at any time,
 * so we never double-notify. Replies within an existing thread on either
 * channel always work regardless of which is active, which is why
 * `replyOn` exists alongside `deliver`.
 */

export type Channel = "whatsapp" | "telegram";

type ConnectionRow = {
  channel: Channel;
  channel_user_id: string;
  is_active_outbound: number;
};

/**
 * Assistant-initiated outbound. Goes to the active channel only.
 * Falls back to the sole linked channel if none has been marked active.
 */
export async function deliver(env: Env, userId: string, text: string): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT channel, channel_user_id, is_active_outbound
       FROM connections WHERE user_id = ?`
  )
    .bind(userId)
    .all<ConnectionRow>();

  const connections = rows.results ?? [];
  if (connections.length === 0) return;

  const target =
    connections.find((c) => c.is_active_outbound === 1) ??
    (connections.length === 1 ? connections[0] : undefined);

  if (!target) {
    console.warn(`user ${userId} has multiple channels and no active one set`);
    return;
  }

  await send(env, target.channel, target.channel_user_id, text);
}

/** Reply within an existing thread. Works on either channel, active or not. */
export async function replyOn(
  env: Env,
  channel: Channel,
  channelUserId: string,
  text: string
): Promise<void> {
  await send(env, channel, channelUserId, text);
}

async function send(
  env: Env,
  channel: Channel,
  channelUserId: string,
  text: string
): Promise<void> {
  // Last line of defence. Every channel rejects an empty body, so an empty
  // string here is always a bug upstream rather than something to deliver.
  // Log it where it can be traced instead of turning it into a 400.
  if (!text.trim()) {
    console.error(`refusing to send an empty message on ${channel}`);
    return;
  }

  try {
    if (channel === "telegram") return await sendTelegram(env, channelUserId, text);
    return await sendWhatsApp(env, channelUserId, text);
  } catch (err) {
    console.error(`delivery failed on ${channel}`, err);
  }
}

async function sendTelegram(env: Env, chatId: string, text: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) {
    console.warn("TELEGRAM_BOT_TOKEN unset, message not delivered");
    return;
  }
  const res = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    }
  );
  if (!res.ok) throw new Error(`telegram send failed: ${res.status} ${await res.text()}`);
}

async function sendWhatsApp(env: Env, to: string, text: string): Promise<void> {
  if (!env.WHATSAPP_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) {
    console.warn("WhatsApp credentials unset, message not delivered");
    return;
  }
  const res = await fetch(
    `https://graph.facebook.com/v21.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text },
      }),
    }
  );
  if (!res.ok) throw new Error(`whatsapp send failed: ${res.status} ${await res.text()}`);
}
