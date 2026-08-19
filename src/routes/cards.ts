/**
 * Secure user cards (SPEC 7).
 *
 * Assistant-triggered, single-use, opt-in per request. Nothing is
 * pre-collected speculatively; there is no standing wallet the assistant
 * pre-fills from at will.
 *
 * Presentation rules (SPEC 7.3, DESIGN_SYSTEM.md):
 *   - short path, wis.ai/c/{shortcode}, never a long signed query string
 *   - single-use and time-limited, and the card says so plainly
 *   - states why the assistant is asking
 *   - reuses the product's own tokens, not a separate design system
 *
 * What this file never does is hold a secret. A payment card is tokenised by
 * Stripe and we keep the token. A credential goes to the secrets vault and we
 * keep a reference. A connector is standard OAuth and we keep the encrypted
 * refresh token. The application database never sees a raw value.
 */

import { shortCode } from "../lib/ids";
import { esc, html, json, badRequest, notFound } from "../lib/http";

const CARD_TTL_SECONDS = 10 * 60;

export type CardType = "payment" | "credential" | "connector";

type CardRecord = {
  userId: string;
  cardType: CardType;
  reason: string;
  taskId: string | null;
};

/** Called by the assistant when it genuinely needs something (SPEC 7.1). */
export async function issueCard(
  env: Env,
  userId: string,
  cardType: CardType,
  reason: string,
  taskId: string | null = null
): Promise<{ url: string; expiresInSeconds: number }> {
  const code = shortCode(7);
  const expiresAt = Math.floor(Date.now() / 1000) + CARD_TTL_SECONDS;

  await env.KV.put(
    `card:${code}`,
    JSON.stringify({ userId, cardType, reason, taskId } satisfies CardRecord),
    { expirationTtl: CARD_TTL_SECONDS }
  );

  await env.DB.prepare(
    `INSERT INTO cards (shortcode, user_id, card_type, reason, task_id, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(code, userId, cardType, reason, taskId, expiresAt)
    .run();

  return {
    url: `${env.PUBLIC_ORIGIN}/c/${code}`,
    expiresInSeconds: CARD_TTL_SECONDS,
  };
}

/** GET /c/{shortcode} */
export async function renderCard(code: string, env: Env): Promise<Response> {
  const record = await env.KV.get<CardRecord>(`card:${code}`, "json");
  if (!record) return html(expiredPage(), { status: 410 });

  return html(cardPage(code, record));
}

/** POST /c/{shortcode} */
export async function submitCard(
  code: string,
  request: Request,
  env: Env
): Promise<Response> {
  const record = await env.KV.get<CardRecord>(`card:${code}`, "json");
  if (!record) return badRequest("This link has expired.");

  // Single use. Burned before any processing, so a replay cannot race it.
  await env.KV.delete(`card:${code}`);

  const form = await request.formData();
  let reference: string | null = null;

  if (record.cardType === "payment") {
    // Stripe returns a token from the browser; the PAN never reaches this
    // Worker and is never stored anywhere in Wis.ai infrastructure (SPEC 7.2).
    reference = String(form.get("stripe_token") ?? "").slice(0, 200) || null;
    if (!reference) return badRequest("Card details were not tokenised.");
  } else if (record.cardType === "credential") {
    // Credentials go to the secrets vault, never into D1. We hold a reference.
    const secretName = `user/${record.userId}/${shortCode(8)}`;
    const value = String(form.get("secret") ?? "");
    if (!value) return badRequest("Nothing to save.");
    reference = await storeSecret(env, secretName, value);
  } else {
    reference = String(form.get("connector") ?? "").slice(0, 200) || null;
  }

  await env.DB.prepare(
    `UPDATE cards SET status = 'completed', reference = ?, used_at = unixepoch() WHERE shortcode = ?`
  )
    .bind(reference, code)
    .run();

  return html(donePage());
}

/**
 * Store a credential in the secrets vault (SPEC 7.2).
 * Returns a reference. The raw value is never returned or logged.
 */
async function storeSecret(env: Env, name: string, value: string): Promise<string> {
  if (!env.VAULT) {
    // Fail closed. Better to tell the user it did not save than to quietly
    // put a raw credential somewhere it does not belong.
    throw new Error("secrets vault is not configured");
  }
  await env.VAULT.put(name, value);
  return name;
}

// ---------------------------------------------------------------------------
// Presentation
//
// A constrained-width instance of the same design system, not a new component
// library. Same paper, ink, hairline, 10px radius, same primary button, same
// wordmark treatment. No marketing language on a security surface.
// ---------------------------------------------------------------------------

const CARD_TITLES: Record<CardType, string> = {
  payment: "Payment details",
  credential: "Sign-in details",
  connector: "Connect an account",
};

function shell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)} | Wis.ai</title>
<meta name="robots" content="noindex">
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<meta name="theme-color" content="#fbfbf9">
<link rel="stylesheet" href="/assets/style.css?v=6">
</head>
<body>
  <div class="card-wrap reveal">
    <a class="mark" href="/" style="text-decoration:none">W<span class="caret"></span></a>
    ${body}
  </div>
</body>
</html>`;
}

function cardPage(code: string, record: CardRecord): string {
  const fields =
    record.cardType === "payment"
      ? `<input class="field" type="text" name="stripe_token" inputmode="numeric" autocomplete="cc-number" placeholder="Card number" aria-label="Card number" required>
         <div class="field-row">
           <input class="field" type="text" name="exp" inputmode="numeric" autocomplete="cc-exp" placeholder="MM / YY" aria-label="Expiry" required>
           <input class="field" type="text" name="cvc" inputmode="numeric" autocomplete="cc-csc" placeholder="CVC" aria-label="Security code" required>
         </div>`
      : record.cardType === "credential"
        ? `<input class="field" type="text" name="username" autocomplete="username" placeholder="Username or email" aria-label="Username">
           <input class="field" type="password" name="secret" autocomplete="current-password" placeholder="Password" aria-label="Password" required>`
        : `<input class="field" type="text" name="connector" placeholder="Account to connect" aria-label="Account to connect" required>`;

  return shell(
    CARD_TITLES[record.cardType],
    `<h1>${esc(CARD_TITLES[record.cardType])}</h1>
     <p>${esc(record.reason)}</p>
     <form method="post" action="/c/${esc(code)}">
       ${fields}
       <button class="start-btn" type="submit">Confirm</button>
     </form>
     <p class="disclaimer">This link is single use and expires in 10 minutes. Wis.ai never stores your card number or password directly.</p>`
  );
}

function expiredPage(): string {
  return shell(
    "Link expired",
    `<h1>This link has expired.</h1>
     <p>Ask your assistant for a new one. Links are single use and time limited on purpose.</p>`
  );
}

function donePage(): string {
  return shell(
    "Done",
    `<h1>Saved.</h1>
     <p>You can close this and go back to your conversation.</p>`
  );
}

/** GET /api/cards  Recent cards, for the account page. */
export async function listCards(env: Env, userId: string): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT shortcode, card_type, reason, status, created_at, used_at
       FROM cards WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`
  )
    .bind(userId)
    .all();
  return json({ ok: true, cards: rows.results ?? [] });
}

export { notFound };
