/**
 * The signed-in surface.
 *
 * Deliberately plain (SPEC 1: "the interface is deliberately plain, the
 * product is everything behind it"). It carries the onboarding conversation
 * from SPEC 3, then the settings that stay revisitable afterwards.
 *
 * Server-rendered, one stylesheet, shared with the marketing site. There is
 * one visual language, not one for marketing and another for the app
 * (DESIGN_SYSTEM.md). No eyebrow titles anywhere.
 */

import { esc, html } from "../lib/http";
import { resolveSession } from "./auth";
import { proactivityEstimate } from "../agent/prompts";

const PERSONALITIES = [
  { value: "butler", label: "British butler. Dry, precise, never fawning." },
  { value: "warm", label: "Warm. Friendly and human." },
  { value: "no-nonsense", label: "No-nonsense. Answers and moves on." },
  { value: "formal", label: "Formal. Professional register throughout." },
  { value: "custom", label: "Something else." },
] as const;

type Me = {
  id: string;
  email: string;
  name: string | null;
  country: string | null;
  mobile_number: string | null;
  mobile_verified: number;
  onboarded: number;
  assistant_name: string | null;
  address_as: string | null;
  personality: string | null;
  language: string | null;
  proactivity: number | null;
  timezone: string | null;
  handle: string | null;
};

export async function renderApp(request: Request, env: Env): Promise<Response> {
  const userId = await resolveSession(request, env);
  if (!userId) {
    return new Response(null, { status: 302, headers: { location: "/start" } });
  }

  const me = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.country, u.mobile_number, u.mobile_verified, u.onboarded,
            p.assistant_name, p.address_as, p.personality, p.language, p.proactivity,
            p.timezone, h.handle
       FROM users u
       LEFT JOIN preferences p ON p.user_id = u.id
       LEFT JOIN assistant_handles h ON h.user_id = u.id
      WHERE u.id = ?`
  )
    .bind(userId)
    .first<Me>();

  if (!me) {
    return new Response(null, { status: 302, headers: { location: "/start" } });
  }

  const connections = await env.DB.prepare(
    `SELECT channel, is_active_outbound FROM connections WHERE user_id = ?`
  )
    .bind(userId)
    .all<{ channel: string; is_active_outbound: number }>();

  const body = me.onboarded
    ? assistantPage(me, connections.results ?? [], env)
    : onboardingPage(me);

  return html(page(me.onboarded ? "Your assistant" : "Getting started", body));
}

function page(title: string, body: string): string {
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
  <div class="page">
    <header>
      <a class="mark" href="/">W<span class="caret"></span></a>
      <nav><a class="u soft-link" href="#" id="signout">Sign out</a></nav>
    </header>
    <main class="reveal">
${body}
    </main>
  </div>
  <script src="/assets/app.js?v=6"></script>
</body>
</html>`;
}

/**
 * The onboarding conversation (SPEC 3). Steps in order, one screen, no form
 * chrome and no step labels. Account fields come first because they are
 * account fields, not part of the personality conversation (SPEC 2.1).
 */
function onboardingPage(me: Me): string {
  return `<h1>Let's grab a coffee.</h1>
<p>A few things, then your assistant is yours.</p>

<form id="onboarding">
  <fieldset class="step">
    <label class="q" for="name">What should I put on the account?</label>
    <input class="field" id="name" name="name" autocomplete="name" placeholder="Full name" value="${esc(me.name)}" required>
    <div class="field-row">
      <input class="field" id="country" name="country" autocomplete="country-name" placeholder="Country" value="${esc(me.country)}">
      <input class="field" id="mobile" name="mobile_number" inputmode="tel" autocomplete="tel" placeholder="Mobile number" value="${esc(me.mobile_number)}">
    </div>
    <input class="field" id="address" name="address" autocomplete="street-address" placeholder="Address">
    <p class="disclaimer">Your number is a contact detail, not a login. It gets confirmed when you connect WhatsApp or Telegram.</p>
  </fieldset>

  <fieldset class="step">
    <label class="q" for="assistant_name">What would you like to call your assistant?</label>
    <input class="field" id="assistant_name" name="assistant_name" placeholder="Wis" maxlength="40">
  </fieldset>

  <fieldset class="step">
    <label class="q" for="address_as">And how should they address you?</label>
    <input class="field" id="address_as" name="address_as" placeholder="Sir, Madam, or your name" maxlength="40">
  </fieldset>

  <fieldset class="step">
    <label class="q">What sort of manner do you want?</label>
    <div class="choices">
      ${PERSONALITIES.map(
        (p) =>
          `<label class="choice"><input type="radio" name="personality" value="${p.value}"${
            p.value === "butler" ? " checked" : ""
          }> ${p.label}</label>`
      ).join("\n      ")}
    </div>
    <input class="field" id="personality_other" name="personality_other" placeholder="Describe it in your own words" hidden>
  </fieldset>

  <fieldset class="step">
    <label class="q" for="language">Which language?</label>
    <input class="field" id="language" name="language" placeholder="English" value="en">
  </fieldset>

  <fieldset class="step">
    <label class="q" for="proactivity">How proactive should <span id="assistant-label">your assistant</span> be?</label>
    <input class="slider" type="range" id="proactivity" name="proactivity" min="1" max="5" value="3" step="1">
    <div class="slider-ends"><span>Only when asked</span><span>Checks in and anticipates</span></div>
    <p class="gauge">About <span class="num" id="estimate">${esc(proactivityEstimate(3).replace("roughly ", ""))}</span></p>
  </fieldset>

  <fieldset class="step">
    <label class="q" for="context">Anything they should know about you?</label>
    <textarea class="field" id="context" name="context" rows="5" placeholder="How you like things done, who matters, what you care about"></textarea>
    <button type="button" class="ghost-btn" id="record">Hold to record instead</button>
    <p class="disclaimer">If you record, the transcript is what your assistant remembers. The audio stays yours, and you can delete it whenever you like.</p>
  </fieldset>

  <fieldset class="step">
    <label class="q" for="handle">Your assistant's email address.</label>
    <div class="field-row">
      <input class="field" id="handle" name="handle" placeholder="Leave blank and I'll pick one" maxlength="24">
      <span class="suffix">@me.wis.ai</span>
    </div>
    <p class="disclaimer" id="handle-status"></p>
  </fieldset>

  <button class="start-btn" type="submit">Done</button>
  <p class="disclaimer" id="onboarding-error"></p>
</form>`;
}

/** After onboarding: what the assistant is, how to reach it, what to change. */
function assistantPage(
  me: Me,
  connections: Array<{ channel: string; is_active_outbound: number }>,
  env: Env
): string {
  const assistantEmail = me.handle ? `${me.handle}@${env.ASSISTANT_EMAIL_DOMAIN}` : null;
  const linked = new Set(connections.map((c) => c.channel));
  const active = connections.find((c) => c.is_active_outbound === 1)?.channel ?? null;

  return `<h1>${esc(me.assistant_name ?? "Wis")} is ready.</h1>

${assistantEmail ? `<p>Their email address is <strong>${esc(assistantEmail)}</strong>. Anything sent there reaches them.</p>` : ""}

<p>Talk to them wherever you already are.</p>

<div class="channels">
  <div class="channel">
    <span>WhatsApp</span>
    ${
      linked.has("whatsapp")
        ? `<button class="ghost-btn set-active" data-channel="whatsapp"${active === "whatsapp" ? " disabled" : ""}>${active === "whatsapp" ? "Active" : "Make active"}</button>`
        : `<button class="ghost-btn connect" data-channel="whatsapp">Connect</button>`
    }
  </div>
  <div class="channel">
    <span>Telegram</span>
    ${
      linked.has("telegram")
        ? `<button class="ghost-btn set-active" data-channel="telegram"${active === "telegram" ? " disabled" : ""}>${active === "telegram" ? "Active" : "Make active"}</button>`
        : `<button class="ghost-btn connect" data-channel="telegram">Connect</button>`
    }
  </div>
</div>

<p class="disclaimer" id="channel-warning" hidden></p>

<div id="pairing" hidden>
  <p id="pairing-copy"></p>
  <div id="qr"></div>
  <p class="disclaimer">This link works once and expires in 15 minutes.</p>
</div>

${connections.length > 1 ? `<p class="disclaimer">Both are connected. Only the active one gets messages your assistant starts, so you are never told the same thing twice. Replies work on either.</p>` : ""}

<hr class="rule">

<label class="q" for="handle">${esc(me.assistant_name ?? "Wis")}'s email address.</label>
<div class="field-row">
  <input class="field" id="handle" value="${esc(me.handle)}" maxlength="24">
  <span class="suffix">@${esc(env.ASSISTANT_EMAIL_DOMAIN)}</span>
</div>
<p class="disclaimer" id="handle-status">Changing this stops the old address working.</p>
<button class="ghost-btn" id="save-handle">Save address</button>

<hr class="rule">

<form id="settings">
  <label class="q" for="assistant_name">What ${esc(me.assistant_name ?? "Wis")} is called.</label>
  <input class="field" id="assistant_name" name="assistant_name" value="${esc(me.assistant_name)}" maxlength="40">

  <label class="q" for="address_as">How they address you.</label>
  <input class="field" id="address_as" name="address_as" value="${esc(me.address_as)}" placeholder="Sir, Madam, or your name" maxlength="40">

  <label class="q">Their manner.</label>
  <div class="choices">
    ${PERSONALITIES.map(
      (p) =>
        `<label class="choice"><input type="radio" name="personality" value="${p.value}"${
          (me.personality ?? "butler") === p.value ? " checked" : ""
        }> ${p.label}</label>`
    ).join("\n    ")}
  </div>

  <label class="q" for="language">Language.</label>
  <input class="field" id="language" name="language" value="${esc(me.language ?? "en")}" maxlength="12">

  <label class="q" for="proactivity">How proactive should ${esc(me.assistant_name ?? "Wis")} be?</label>
  <input class="slider" type="range" id="proactivity" name="proactivity" min="1" max="5" step="1" value="${esc(me.proactivity ?? 3)}">
  <div class="slider-ends"><span>Only when asked</span><span>Checks in and anticipates</span></div>
  <p class="gauge">About <span class="num" id="estimate">${esc(proactivityEstimate(me.proactivity ?? 3).replace("roughly ", ""))}</span></p>

  <button class="start-btn" type="submit">Save changes</button>
  <p class="disclaimer" id="settings-status"></p>
  <p class="disclaimer">Times are read in <span class="num">${esc(me.timezone ?? "UTC")}</span>, taken from this browser when you save.</p>
</form>

<hr class="rule">

<label class="q">What ${esc(me.assistant_name ?? "Wis")} knows about you.</label>
<div id="memory-list"><p class="disclaimer">Loading.</p></div>
<textarea class="field" id="memory-new" rows="3" placeholder="Anything else they should know"></textarea>
<button class="ghost-btn" id="add-memory">Add</button>

<hr class="rule">

<p>Your data is yours. <a class="u" href="/api/data" download="wis-data.json">Download everything</a>, or <a class="u" href="#" id="delete-all">delete it</a>.</p>`;
}
