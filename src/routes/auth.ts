/**
 * Email-based authentication (SPEC 2.1, 2.2).
 *
 * Email plus a one-time code is the login mechanism. There is no SMS anywhere
 * in this flow, which is what keeps the regulated-telecom surface out of the
 * product entirely: no carrier registration, no per-country SMS pricing, no
 * TCPA consent language for login.
 *
 * The mobile number is captured as an attached contact field, never as an
 * auth factor, and is verified implicitly later by the act of linking
 * WhatsApp or Telegram (SPEC 4.3 step 6).
 */

import { bearerToken, hashToken, otpCode, timingSafeEqual, uuid } from "../lib/ids";
import { sendEmail } from "../lib/email";
import { json, badRequest } from "../lib/http";

const OTP_TTL_SECONDS = 10 * 60;
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_OTP_ATTEMPTS = 5;

/**
 * One code request per email per this many seconds.
 * KV's minimum expiration TTL is 60, so this cannot go lower.
 */
const REQUEST_COOLDOWN_SECONDS = 60;

type OtpRecord = { code: string; attempts: number; email: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normaliseEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  return EMAIL_RE.test(email) && email.length <= 254 ? email : null;
}

/**
 * POST /api/auth/request
 * Body: { email }
 *
 * Always responds the same way whether or not the address is already known,
 * so this endpoint cannot be used to enumerate accounts.
 */
export async function requestCode(request: Request, env: Env): Promise<Response> {
  const body = await request.json().catch(() => null) as { email?: string } | null;
  const email = normaliseEmail(body?.email ?? "");
  if (!email) return badRequest("Enter a valid email address.");

  const cooldownKey = `otp:cooldown:${email}`;
  if (await env.KV.get(cooldownKey)) {
    return json({ ok: true, cooldown: true });
  }

  const code = otpCode();
  await env.KV.put(
    `otp:${email}`,
    JSON.stringify({ code, attempts: 0, email } satisfies OtpRecord),
    { expirationTtl: OTP_TTL_SECONDS }
  );
  await env.KV.put(cooldownKey, "1", { expirationTtl: REQUEST_COOLDOWN_SECONDS });

  await sendCodeEmail(env, email, code);

  return json({ ok: true });
}

/**
 * POST /api/auth/verify
 * Body: { email, code }
 *
 * On success, creates the account if it does not exist and returns a session
 * cookie. `created` tells the client whether to continue into signup details.
 */
export async function verifyCode(request: Request, env: Env): Promise<Response> {
  const body = await request.json().catch(() => null) as
    | { email?: string; code?: string }
    | null;

  const email = normaliseEmail(body?.email ?? "");
  const submitted = (body?.code ?? "").trim();

  if (!email || !/^\d{6}$/.test(submitted)) {
    return badRequest("Enter the six digit code from your email.");
  }

  const key = `otp:${email}`;
  const stored = await env.KV.get<OtpRecord>(key, "json");
  if (!stored) return badRequest("That code has expired. Ask for a new one.");

  if (stored.attempts >= MAX_OTP_ATTEMPTS) {
    await env.KV.delete(key);
    return badRequest("Too many attempts. Ask for a new code.");
  }

  if (!timingSafeEqual(stored.code, submitted)) {
    await env.KV.put(key, JSON.stringify({ ...stored, attempts: stored.attempts + 1 }), {
      expirationTtl: OTP_TTL_SECONDS,
    });
    return badRequest("That code is not right.");
  }

  // Single use.
  await env.KV.delete(key);

  const existing = await env.DB.prepare(
    `SELECT id, onboarded FROM users WHERE email = ?`
  )
    .bind(email)
    .first<{ id: string; onboarded: number }>();

  let userId: string;
  let created = false;

  if (existing) {
    userId = existing.id;
    await env.DB.prepare(`UPDATE users SET last_seen_at = unixepoch() WHERE id = ?`)
      .bind(userId)
      .run();
  } else {
    userId = uuid();
    created = true;
    await env.DB.prepare(
      `INSERT INTO users (id, email, last_seen_at) VALUES (?, ?, unixepoch())`
    )
      .bind(userId, email)
      .run();
  }

  const { token, cookie } = await createSession(env, userId);
  void token;

  return json(
    { ok: true, created, onboarded: existing ? existing.onboarded === 1 : false },
    { headers: { "set-cookie": cookie } }
  );
}

export async function createSession(
  env: Env,
  userId: string
): Promise<{ token: string; cookie: string }> {
  const token = bearerToken();
  const tokenHash = await hashToken(token);
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;

  await env.DB.prepare(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)`
  )
    .bind(tokenHash, userId, expiresAt)
    .run();

  const cookie =
    `wis_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`;

  return { token, cookie };
}

export async function resolveSession(request: Request, env: Env): Promise<string | null> {
  const cookies = request.headers.get("cookie") ?? "";
  const match = cookies.match(/(?:^|;\s*)wis_session=([a-f0-9]{64})/);
  if (!match) return null;

  const tokenHash = await hashToken(match[1]!);
  const row = await env.DB.prepare(
    `SELECT user_id, expires_at FROM sessions WHERE token_hash = ?`
  )
    .bind(tokenHash)
    .first<{ user_id: string; expires_at: number }>();

  if (!row) return null;

  if (row.expires_at < Math.floor(Date.now() / 1000)) {
    await env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ?`).bind(tokenHash).run();
    return null;
  }

  return row.user_id;
}

export async function logout(request: Request, env: Env): Promise<Response> {
  const cookies = request.headers.get("cookie") ?? "";
  const match = cookies.match(/(?:^|;\s*)wis_session=([a-f0-9]{64})/);
  if (match) {
    const tokenHash = await hashToken(match[1]!);
    await env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ?`).bind(tokenHash).run();
  }
  return json(
    { ok: true },
    { headers: { "set-cookie": "wis_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0" } }
  );
}

/**
 * The OTP mail. Sent from verify@wis.ai, which is deliberately on the primary
 * domain and separate from the me.wis.ai subdomain each assistant's own inbox
 * runs on, so a spam complaint against one assistant can never damage
 * deliverability of account mail (SPEC 6.1).
 */
async function sendCodeEmail(env: Env, to: string, code: string): Promise<void> {
  const text = `${code} is your Wis.ai sign-in code. It expires in 10 minutes.

If you did not ask to sign in, ignore this message.`;

  // Never surface a failure to the caller: it would leak whether an address
  // exists and what our sending posture is. The failure is logged instead.
  const result = await sendEmail(env, {
    to,
    fromAddress: env.AUTH_FROM_ADDRESS,
    fromName: "Wis.ai",
    subject: `${code} is your Wis.ai code`,
    text,
    html: codeEmailHtml(code),
  });

  if (!result.ok) {
    console.error(`OTP send failed via ${result.via}: ${result.detail ?? "unknown"}`);
  }
}

/**
 * The email reuses the product's own visual language rather than a generic
 * transactional template (DESIGN_SYSTEM.md). Values are inlined from
 * design/tokens.json because email clients do not support custom properties.
 */
function codeEmailHtml(code: string): string {
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#fbfbf9">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fbfbf9;padding:48px 24px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:24rem">
<tr><td style="font-family:Baskerville,Palatino,Georgia,serif;font-style:italic;font-weight:600;font-size:1.55rem;color:#16160f;padding-bottom:32px">W</td></tr>
<tr><td style="font-family:'Instrument Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:17px;line-height:2;color:#16160f;padding-bottom:24px">Your sign-in code.</td></tr>
<tr><td style="font-family:'SF Mono','Roboto Mono',ui-monospace,Menlo,monospace;font-variant-numeric:tabular-nums;font-size:2rem;letter-spacing:0.2em;color:#16160f;border:1px solid #e4e4dc;border-radius:10px;background:#ffffff;padding:20px 24px;text-align:center">${code}</td></tr>
<tr><td style="font-family:'Instrument Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;line-height:1.9;color:#6b6b60;padding-top:24px">It expires in 10 minutes. If you did not ask to sign in, ignore this message.</td></tr>
</table>
</td></tr></table>
</body></html>`;
}
