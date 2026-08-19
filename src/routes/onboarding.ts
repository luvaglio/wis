/**
 * Onboarding, "let's grab a coffee" (SPEC 3).
 *
 * A short conversational flow, not a form. The account fields (full name,
 * country, address, mobile) are captured at signup and are explicitly NOT
 * part of the personality conversation (SPEC 2.1).
 *
 * Output (SPEC 3.1):
 *   - a preferences row in D1
 *   - one or more embedded chunks in Vectorize from the free-text context
 *   - users.onboarded flips to true
 */

import { getAgentByName } from "agents";
import { json, badRequest, unauthorized } from "../lib/http";
import { proactivityEstimate, type PersonalityPreset } from "../agent/prompts";
import { shortCode, uuid } from "../lib/ids";
import { resolveSession } from "./auth";

const PRESETS: PersonalityPreset[] = ["butler", "warm", "no-nonsense", "formal", "custom"];

/** POST /api/account  Account fields, captured at signup (SPEC 2.1). */
export async function saveAccount(request: Request, env: Env): Promise<Response> {
  const userId = await resolveSession(request, env);
  if (!userId) return unauthorized();

  const body = (await request.json().catch(() => null)) as {
    name?: string;
    country?: string;
    address?: string;
    mobile_number?: string;
  } | null;

  const name = (body?.name ?? "").trim().slice(0, 120);
  if (!name) return badRequest("We need a name to address you by.");

  await env.DB.prepare(
    `UPDATE users SET name = ?, country = ?, address = ?, mobile_number = ? WHERE id = ?`
  )
    .bind(
      name,
      (body?.country ?? "").trim().slice(0, 60) || null,
      (body?.address ?? "").trim().slice(0, 500) || null,
      (body?.mobile_number ?? "").trim().slice(0, 32) || null,
      userId
    )
    .run();

  return json({ ok: true });
}

/**
 * POST /api/onboarding
 * The six steps from SPEC 3, submitted together once the conversation ends.
 */
export async function completeOnboarding(request: Request, env: Env): Promise<Response> {
  const userId = await resolveSession(request, env);
  if (!userId) return unauthorized();

  const body = (await request.json().catch(() => null)) as {
    assistant_name?: string;
    address_as?: string;
    personality?: string;
    personality_other?: string;
    language?: string;
    proactivity?: number;
    timezone?: string;
    context?: string;
    recording_key?: string;
    handle?: string;
  } | null;

  // Step 1. Free text, defaults to "Wis" if skipped.
  const assistantName = (body?.assistant_name ?? "").trim().slice(0, 40) || "Wis";

  // Step 2. Free text.
  const addressAs = (body?.address_as ?? "").trim().slice(0, 40) || null;

  // Step 3. A fixed set of presets so it maps cleanly to a system-prompt
  // variable. "Other" is normalised at storage time rather than stored raw.
  const { personality, note } = await normalisePersonality(
    env,
    body?.personality,
    body?.personality_other
  );

  // Step 4. Language, auto-suggested from country/locale, overridable.
  const language = (body?.language ?? "en").trim().slice(0, 12) || "en";

  // Step 5. Proactivity, 1 to 5.
  const proactivity = clamp(Number(body?.proactivity ?? 3), 1, 5);

  // The browser knows the user's timezone, so the assistant can be given a
  // correct clock without ever asking a question about it.
  const timezone = sanitiseTimezone(body?.timezone ?? "");

  await env.DB.prepare(
    `INSERT INTO preferences
       (user_id, assistant_name, address_as, personality, personality_note, language, proactivity, timezone)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET
       assistant_name   = excluded.assistant_name,
       address_as       = excluded.address_as,
       personality      = excluded.personality,
       personality_note = excluded.personality_note,
       language         = excluded.language,
       proactivity      = excluded.proactivity,
       timezone         = COALESCE(excluded.timezone, preferences.timezone),
       updated_at       = unixepoch()`
  )
    .bind(userId, assistantName, addressAs, personality, note, language, proactivity, timezone)
    .run();

  // The assistant's own address (SPEC 6.2). Default is generated with no user
  // action required; a chosen handle is checked for collisions.
  const handle = await assignHandle(env, userId, assistantName, body?.handle);

  const agent = await getAgentByName(env.USER_AGENT, userId);

  // Step 6. Free-form context becomes embedded chunks in Vectorize.
  // For a recording it is the transcript that gets stored and embedded. The
  // audio stays in R2 for the user's own reference and is never replayed back
  // into the assistant's reasoning.
  const context = (body?.context ?? "").trim();
  if (context) {
    for (const chunk of chunkText(context)) {
      await agent.remember(chunk, "onboarding");
    }
  }

  await env.DB.prepare(`UPDATE users SET onboarded = 1 WHERE id = ?`).bind(userId).run();
  await agent.markOnboarded();

  return json({
    ok: true,
    handle: `${handle}@${env.ASSISTANT_EMAIL_DOMAIN}`,
    estimate: proactivityEstimate(proactivity),
  });
}

/**
 * POST /api/preferences
 *
 * Partial update of the personality layer, for the settings that stay
 * revisitable after onboarding (SPEC 3, step 5: "revisitable later from the
 * assistant's own settings").
 *
 * Deliberately separate from /api/onboarding. That endpoint completes the
 * onboarding conversation and writes the whole row, so a caller that sends
 * one field means "these are all my answers" and everything else falls back
 * to its default. Sending a single setting to it silently reset the rest,
 * which is how an assistant named Aria quietly became Wis again. Here, only
 * the fields actually supplied are touched.
 */
export async function updatePreferences(request: Request, env: Env): Promise<Response> {
  const userId = await resolveSession(request, env);
  if (!userId) return unauthorized();

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return badRequest("Nothing to update.");

  const sets: string[] = [];
  const values: unknown[] = [];

  if (typeof body.assistant_name === "string" && body.assistant_name.trim()) {
    sets.push("assistant_name = ?");
    values.push(body.assistant_name.trim().slice(0, 40));
  }

  if (typeof body.address_as === "string") {
    sets.push("address_as = ?");
    values.push(body.address_as.trim().slice(0, 40) || null);
  }

  if (typeof body.personality === "string" && PRESETS.includes(body.personality as PersonalityPreset)) {
    sets.push("personality = ?");
    values.push(body.personality);
  }

  if (typeof body.language === "string" && body.language.trim()) {
    sets.push("language = ?");
    values.push(body.language.trim().slice(0, 12));
  }

  if (body.proactivity !== undefined) {
    sets.push("proactivity = ?");
    values.push(clamp(Number(body.proactivity), 1, 5));
  }

  if (typeof body.timezone === "string") {
    const zone = sanitiseTimezone(body.timezone);
    if (zone) {
      sets.push("timezone = ?");
      values.push(zone);
    }
  }

  if (sets.length === 0) return badRequest("Nothing to update.");

  sets.push("updated_at = unixepoch()");
  values.push(userId);

  const result = await env.DB.prepare(
    `UPDATE preferences SET ${sets.join(", ")} WHERE user_id = ?`
  )
    .bind(...values)
    .run();

  // A user who has not finished onboarding has no preferences row to update.
  if (result.meta.changes === 0) {
    return badRequest("Finish setting up your assistant first.");
  }

  return json({ ok: true });
}

/**
 * POST /api/handle
 * Change the assistant's own email address (SPEC 6.2).
 *
 * The old address stops resolving, which is stated in the reply so it is not a
 * surprise. Collisions are rejected rather than silently suffixed.
 */
export async function changeHandle(request: Request, env: Env): Promise<Response> {
  const userId = await resolveSession(request, env);
  if (!userId) return unauthorized();

  const body = (await request.json().catch(() => null)) as { handle?: string } | null;
  const wanted = sanitiseHandle(body?.handle ?? "");
  if (!wanted) return badRequest("Letters and numbers, 3 to 24 characters.");

  const current = await env.DB.prepare(`SELECT handle FROM assistant_handles WHERE user_id = ?`)
    .bind(userId)
    .first<{ handle: string }>();

  if (current?.handle === wanted) {
    return json({ ok: true, handle: `${wanted}@${env.ASSISTANT_EMAIL_DOMAIN}`, unchanged: true });
  }

  const taken = await env.DB.prepare(`SELECT 1 FROM assistant_handles WHERE handle = ?`)
    .bind(wanted)
    .first();
  if (taken) return badRequest("That one is taken.");

  // handle is the primary key, so this is a delete and insert rather than an
  // update in place.
  const statements = [
    env.DB.prepare(`INSERT INTO assistant_handles (handle, user_id) VALUES (?, ?)`).bind(
      wanted,
      userId
    ),
  ];
  if (current) {
    statements.unshift(
      env.DB.prepare(`DELETE FROM assistant_handles WHERE user_id = ?`).bind(userId)
    );
  }
  await env.DB.batch(statements);

  return json({
    ok: true,
    handle: `${wanted}@${env.ASSISTANT_EMAIL_DOMAIN}`,
    previous: current ? `${current.handle}@${env.ASSISTANT_EMAIL_DOMAIN}` : null,
  });
}

/**
 * GET /api/memory
 * What the assistant remembers about this user, so it can be reviewed and
 * removed. "Your data is yours" (site/values) is hard to act on if you cannot
 * see what is held.
 *
 * Rows written before the text column existed carry only a vector id. Those
 * are backfilled from Vectorize on first read rather than left blank, so the
 * list heals itself instead of needing a migration script.
 */
export async function listMemory(request: Request, env: Env): Promise<Response> {
  const userId = await resolveSession(request, env);
  if (!userId) return unauthorized();

  const rows = await env.DB.prepare(
    `SELECT vector_id, kind, text, created_at FROM memory_chunks
      WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`
  )
    .bind(userId)
    .all<{ vector_id: string; kind: string; text: string | null; created_at: number }>();

  const chunks = rows.results ?? [];
  const missing = chunks.filter((c) => !c.text).map((c) => c.vector_id);

  if (missing.length) {
    try {
      const vectors = await env.MEMORY.getByIds(missing);
      const recovered = new Map(
        vectors.map((v) => [v.id, String(v.metadata?.text ?? "")])
      );
      const updates = [...recovered.entries()]
        .filter(([, text]) => text)
        .map(([id, text]) =>
          env.DB.prepare(`UPDATE memory_chunks SET text = ? WHERE vector_id = ?`).bind(text, id)
        );
      if (updates.length) await env.DB.batch(updates);
      for (const chunk of chunks) {
        if (!chunk.text) chunk.text = recovered.get(chunk.vector_id) ?? null;
      }
    } catch (err) {
      console.warn("could not backfill memory text", err);
    }
  }

  return json({
    ok: true,
    memories: chunks.map((c) => ({
      id: c.vector_id,
      kind: c.kind,
      text: c.text ?? "",
      created_at: c.created_at,
    })),
  });
}

/** POST /api/memory  Add something the assistant should know. */
export async function addMemory(request: Request, env: Env): Promise<Response> {
  const userId = await resolveSession(request, env);
  if (!userId) return unauthorized();

  const body = (await request.json().catch(() => null)) as { text?: string } | null;
  const text = (body?.text ?? "").trim();
  if (!text) return badRequest("Nothing to remember.");
  if (text.length > 4000) return badRequest("That is too long. Break it into a few notes.");

  const agent = await getAgentByName(env.USER_AGENT, userId);
  for (const chunk of chunkText(text)) {
    await agent.remember(chunk, "settings");
  }

  return json({ ok: true });
}

/** DELETE /api/memory  Forget one chunk, in both stores. */
export async function deleteMemory(request: Request, env: Env): Promise<Response> {
  const userId = await resolveSession(request, env);
  if (!userId) return unauthorized();

  const body = (await request.json().catch(() => null)) as { id?: string } | null;
  const id = (body?.id ?? "").trim();
  if (!id) return badRequest("Which one?");

  // Scoped by user_id so an id belonging to someone else cannot be deleted.
  const owned = await env.DB.prepare(
    `SELECT 1 FROM memory_chunks WHERE vector_id = ? AND user_id = ?`
  )
    .bind(id, userId)
    .first();
  if (!owned) return badRequest("That note is not there.");

  try {
    await env.MEMORY.deleteByIds([id]);
  } catch (err) {
    // If the vector delete fails, leaving the D1 row would hide a chunk that
    // can still be recalled. Report rather than half-delete.
    console.error("vector delete failed", err);
    return json({ ok: false, error: "Could not forget that just now. Try again." }, { status: 500 });
  }

  await env.DB.prepare(`DELETE FROM memory_chunks WHERE vector_id = ? AND user_id = ?`)
    .bind(id, userId)
    .run();

  return json({ ok: true });
}

/**
 * GET /api/diagnostics
 *
 * Whether each channel is configured on our side, and what happened the last
 * time its webhook was called. Reports configuration state and call outcomes
 * only, never a secret value or any part of one.
 */
export async function diagnostics(request: Request, env: Env): Promise<Response> {
  const userId = await resolveSession(request, env);
  if (!userId) return unauthorized();

  const [telegram, whatsapp] = await Promise.all([
    env.KV.get<{ at: string; outcome: string }>("diag:webhook:telegram", "json"),
    env.KV.get<{ at: string; outcome: string }>("diag:webhook:whatsapp", "json"),
  ]);

  return json({
    ok: true,
    telegram: {
      bot_token: !!env.TELEGRAM_BOT_TOKEN,
      bot_username: !!env.TELEGRAM_BOT_USERNAME,
      webhook_secret: !!env.TELEGRAM_WEBHOOK_SECRET,
      last_webhook: telegram ?? null,
      hint: hintFor(!!env.TELEGRAM_BOT_TOKEN, telegram?.outcome, "telegram"),
    },
    whatsapp: {
      token: !!env.WHATSAPP_TOKEN,
      phone_number_id: !!env.WHATSAPP_PHONE_NUMBER_ID,
      verify_token: !!env.WHATSAPP_VERIFY_TOKEN,
      app_secret: !!env.WHATSAPP_APP_SECRET,
      last_webhook: whatsapp ?? null,
      hint: hintFor(!!env.WHATSAPP_TOKEN, whatsapp?.outcome, "whatsapp"),
    },
  });
}

function hintFor(configured: boolean, outcome: string | undefined, channel: string): string {
  if (!configured) return `No credentials set for ${channel} yet.`;
  if (!outcome) {
    return `Credentials are set, but ${channel} has never called this Worker. The webhook is probably not registered, or points somewhere else.`;
  }
  if (outcome === "rejected_bad_secret") {
    return "Telegram is calling, and every update is being rejected: the secret registered with setWebhook does not match TELEGRAM_WEBHOOK_SECRET. Re-register with the value the Worker holds.";
  }
  if (outcome === "rejected_bad_signature") {
    return "WhatsApp is calling, and the payload signature does not verify against WHATSAPP_APP_SECRET.";
  }
  return "Calls are arriving and being accepted.";
}

/** GET /api/proactivity?level=3  Live usage gauge under the slider (SPEC 3, step 5). */
export function proactivityGauge(request: Request): Response {
  const level = clamp(Number(new URL(request.url).searchParams.get("level") ?? 3), 1, 5);
  return json({ ok: true, level, estimate: proactivityEstimate(level) });
}

/**
 * GET /api/handle/check?handle=aria
 * Live availability check offered at onboarding (SPEC 6.2).
 */
export async function checkHandle(request: Request, env: Env): Promise<Response> {
  const raw = new URL(request.url).searchParams.get("handle") ?? "";
  const handle = sanitiseHandle(raw);
  if (!handle) {
    return json({ ok: true, available: false, reason: "Letters and numbers, 3 to 24 characters." });
  }
  const taken = await env.DB.prepare(`SELECT 1 FROM assistant_handles WHERE handle = ?`)
    .bind(handle)
    .first();
  return json({
    ok: true,
    handle,
    available: !taken,
    address: `${handle}@${env.ASSISTANT_EMAIL_DOMAIN}`,
  });
}

/**
 * Default format is the assistant name, lowercased, plus a short random
 * suffix: aria.4f2k@me.wis.ai. Short by design, name plus a compact suffix,
 * never a long hash (SPEC 6.2).
 */
async function assignHandle(
  env: Env,
  userId: string,
  assistantName: string,
  requested?: string
): Promise<string> {
  const existing = await env.DB.prepare(`SELECT handle FROM assistant_handles WHERE user_id = ?`)
    .bind(userId)
    .first<{ handle: string }>();
  if (existing) return existing.handle;

  const wanted = requested ? sanitiseHandle(requested) : null;
  if (wanted) {
    const taken = await env.DB.prepare(`SELECT 1 FROM assistant_handles WHERE handle = ?`)
      .bind(wanted)
      .first();
    if (!taken) {
      await env.DB.prepare(`INSERT INTO assistant_handles (handle, user_id) VALUES (?, ?)`)
        .bind(wanted, userId)
        .run();
      return wanted;
    }
  }

  const base = sanitiseHandle(assistantName) ?? "wis";
  for (let attempt = 0; attempt < 6; attempt++) {
    const candidate = `${base}.${shortCode(4)}`;
    try {
      await env.DB.prepare(`INSERT INTO assistant_handles (handle, user_id) VALUES (?, ?)`)
        .bind(candidate, userId)
        .run();
      return candidate;
    } catch {
      // Collision on the unique index. Try another suffix.
    }
  }

  const fallback = `wis.${shortCode(6)}`;
  await env.DB.prepare(`INSERT INTO assistant_handles (handle, user_id) VALUES (?, ?)`)
    .bind(fallback, userId)
    .run();
  return fallback;
}

/**
 * Accept only a real IANA zone.
 *
 * The value arrives from the browser, so it is user-controlled input that ends
 * up in a formatter. Asking Intl whether it recognises the zone is both the
 * validation and the check that it will actually work later.
 */
function sanitiseTimezone(raw: string): string | null {
  const zone = raw.trim();
  if (!zone || zone.length > 64) return null;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone }).format(new Date());
    return zone;
  } catch {
    return null;
  }
}

function sanitiseHandle(raw: string): string | null {
  const handle = raw.trim().toLowerCase().replace(/[^a-z0-9.]/g, "");
  return handle.length >= 3 && handle.length <= 24 ? handle : null;
}

/**
 * "Other" is a free-text escape hatch that still gets normalised into one of
 * the presets at storage time, or stored as a labelled custom variant if it
 * clearly does not fit any of them (SPEC 3, step 3).
 */
async function normalisePersonality(
  env: Env,
  preset?: string,
  other?: string
): Promise<{ personality: PersonalityPreset; note: string | null }> {
  if (preset && PRESETS.includes(preset as PersonalityPreset) && preset !== "custom") {
    return { personality: preset as PersonalityPreset, note: null };
  }

  const description = (other ?? "").trim();
  if (!description) return { personality: "butler", note: null };

  try {
    const { route, ROUTER_STRUCTURED_TOKENS } = await import("../lib/models");
    const answer = await route(
      env,
      [
        {
          role: "system",
          content:
            "Map a description of an assistant's manner onto one of these labels: " +
            "butler, warm, no-nonsense, formal, none. Answer with the single label " +
            "and nothing else. Answer none only if it genuinely fits none of them.",
        },
        { role: "user", content: description.slice(0, 400) },
      ],
      { maxTokens: ROUTER_STRUCTURED_TOKENS, temperature: 0, purpose: "personality-normalisation" }
    );

    const label = answer.trim().toLowerCase().replace(/[^a-z-]/g, "");
    if (["butler", "warm", "no-nonsense", "formal"].includes(label)) {
      return { personality: label as PersonalityPreset, note: null };
    }
  } catch (err) {
    console.warn("personality normalisation failed, storing as custom", err);
  }

  return { personality: "custom", note: description.slice(0, 500) };
}

/**
 * Store an onboarding voice note (SPEC 3, step 6).
 * The audio is kept in R2 under users/{uuid}/ for the user's own reference
 * and deletion. Only the transcript is embedded and reasoned over.
 */
export async function uploadRecording(request: Request, env: Env): Promise<Response> {
  const userId = await resolveSession(request, env);
  if (!userId) return unauthorized();

  const audio = await request.arrayBuffer();
  if (audio.byteLength === 0) return badRequest("Empty recording.");
  if (audio.byteLength > 25 * 1024 * 1024) return badRequest("That recording is too long.");

  const key = `users/${userId}/recordings/${uuid()}.webm`;
  await env.FILES.put(key, audio, {
    httpMetadata: { contentType: request.headers.get("content-type") ?? "audio/webm" },
  });

  let transcript = "";
  try {
    const result = (await env.AI.run(
      "@cf/openai/whisper" as Parameters<Ai["run"]>[0],
      { audio: [...new Uint8Array(audio)] } as never,
      { gateway: { id: env.AI_GATEWAY_ID, metadata: { purpose: "transcription" } } }
    )) as { text?: string };
    transcript = (result.text ?? "").trim();
  } catch (err) {
    console.warn("transcription failed", err);
  }

  return json({ ok: true, key, transcript });
}

function chunkText(text: string, size = 800): string[] {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if ((current + sentence).length > size && current) {
      chunks.push(current.trim());
      current = "";
    }
    current += `${sentence} `;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length ? chunks : [text.slice(0, size)];
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}
