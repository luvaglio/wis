/**
 * Channel linking (SPEC 4.3).
 *
 * Standard "click to chat", no custom bridging:
 *
 *   1. User taps "Connect WhatsApp" or "Connect Telegram" in the web app.
 *   2. Backend generates a short-lived, single-use pairing token.
 *   3. Rendered as a QR code and a deep link.
 *   4. Scanning opens the app pre-filled with a start message carrying the token.
 *   5. The bot validates the token and binds that channel identity to user_id.
 *   6. If the channel's phone number matches users.mobile_number,
 *      mobile_verified flips true. If it does not, the assistant asks once
 *      whether to update the stored number.
 */

import { shortCode, uuid } from "../lib/ids";
import type { Channel } from "./outbound";

/** Pairing tokens are short-lived by design. */
const PAIRING_TTL_SECONDS = 15 * 60;

export type PairingLinks = {
  token: string;
  expiresInSeconds: number;
  whatsappUrl: string;
  telegramUrl: string;
};

export async function createPairingToken(env: Env, userId: string): Promise<PairingLinks> {
  const token = shortCode(10);

  await env.KV.put(`pair:${token}`, userId, { expirationTtl: PAIRING_TTL_SECONDS });

  const startMessage = `link ${token}`;

  return {
    token,
    expiresInSeconds: PAIRING_TTL_SECONDS,
    whatsappUrl: env.WHATSAPP_NUMBER
      ? `https://wa.me/${env.WHATSAPP_NUMBER.replace(/\D/g, "")}?text=${encodeURIComponent(startMessage)}`
      : "",
    // A username pasted straight from BotFather often carries a leading "@",
    // which would produce https://t.me/@bot and never resolve.
    telegramUrl: env.TELEGRAM_BOT_USERNAME
      ? `https://t.me/${env.TELEGRAM_BOT_USERNAME.replace(/^@+/, "").trim()}?start=${token}`
      : "",
  };
}

export type LinkResult =
  | {
      ok: true;
      userId: string;
      numberMismatch: boolean;
      storedNumber: string | null;
      /** This channel identity was connected to a different account until now. */
      movedFromAnotherAccount: boolean;
    }
  | { ok: false; reason: string };

/**
 * Validate a pairing token and bind the channel identity to the user.
 * Single-use: the token is deleted the moment it is redeemed.
 */
export async function redeemPairingToken(
  env: Env,
  token: string,
  channel: Channel,
  channelUserId: string,
  channelPhone: string | null
): Promise<LinkResult> {
  const userId = await env.KV.get(`pair:${token}`);
  if (!userId) return { ok: false, reason: "That link has expired. Generate a new one and try again." };

  await env.KV.delete(`pair:${token}`);

  const user = await env.DB.prepare(
    `SELECT mobile_number FROM users WHERE id = ?`
  )
    .bind(userId)
    .first<{ mobile_number: string | null }>();

  if (!user) return { ok: false, reason: "That account no longer exists." };

  // If this is the user's first channel it becomes the active outbound one.
  const existing = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM connections WHERE user_id = ?`
  )
    .bind(userId)
    .first<{ n: number }>();

  const isFirst = (existing?.n ?? 0) === 0;

  // One shared bot serves every user, so a channel identity is the tenant key
  // and can only point at one account. If this identity is already bound
  // elsewhere the row must be moved, not inserted: the table has two unique
  // constraints and an upsert can only name one of them, so a second account
  // linking the same chat would otherwise fail on
  // UNIQUE (channel, channel_user_id) with no conflict clause to catch it.
  //
  // Moving it is the right resolution rather than a refusal. Redeeming the
  // token proves control of this account, and messaging from the chat proves
  // control of the channel identity, so the person is entitled to decide where
  // it points. Refusing would leave them at a dead end if they no longer have
  // access to the older account.
  const priorBinding = await env.DB.prepare(
    `SELECT user_id FROM connections WHERE channel = ? AND channel_user_id = ?`
  )
    .bind(channel, channelUserId)
    .first<{ user_id: string }>();

  const movedFromAnotherAccount = !!priorBinding && priorBinding.user_id !== userId;

  if (movedFromAnotherAccount) {
    await env.DB.prepare(
      `DELETE FROM connections WHERE channel = ? AND channel_user_id = ?`
    )
      .bind(channel, channelUserId)
      .run();
  }

  await env.DB.prepare(
    `INSERT INTO connections (id, user_id, channel, channel_user_id, channel_phone, is_active_outbound)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, channel) DO UPDATE SET
       channel_user_id = excluded.channel_user_id,
       channel_phone   = excluded.channel_phone,
       linked_at       = unixepoch()`
  )
    .bind(uuid(), userId, channel, channelUserId, channelPhone, isFirst ? 1 : 0)
    .run();

  // Implicit mobile verification (SPEC 2.3, 4.3 step 6). There is no separate
  // OTP step for the phone number anywhere in the product.
  const normalisedStored = normalisePhone(user.mobile_number);
  const normalisedChannel = normalisePhone(channelPhone);
  let numberMismatch = false;

  if (normalisedChannel) {
    if (!normalisedStored || normalisedStored === normalisedChannel) {
      await env.DB.prepare(
        `UPDATE users SET mobile_number = COALESCE(mobile_number, ?), mobile_verified = 1 WHERE id = ?`
      )
        .bind(channelPhone, userId)
        .run();
    } else {
      numberMismatch = true;
    }
  }

  return {
    ok: true,
    userId,
    numberMismatch,
    storedNumber: user.mobile_number,
    movedFromAnotherAccount,
  };
}

/** Switch which channel receives proactive outbound (SPEC 4.2). */
export async function setActiveChannel(
  env: Env,
  userId: string,
  channel: Channel
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`UPDATE connections SET is_active_outbound = 0 WHERE user_id = ?`).bind(userId),
    env.DB.prepare(
      `UPDATE connections SET is_active_outbound = 1 WHERE user_id = ? AND channel = ?`
    ).bind(userId, channel),
  ]);
}

function normalisePhone(value: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  return digits.length >= 7 ? digits.slice(-10) : null;
}
