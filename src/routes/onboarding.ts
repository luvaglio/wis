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

  await env.DB.prepare(
    `INSERT INTO preferences
       (user_id, assistant_name, address_as, personality, personality_note, language, proactivity)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET
       assistant_name   = excluded.assistant_name,
       address_as       = excluded.address_as,
       personality      = excluded.personality,
       personality_note = excluded.personality_note,
       language         = excluded.language,
       proactivity      = excluded.proactivity,
       updated_at       = unixepoch()`
  )
    .bind(userId, assistantName, addressAs, personality, note, language, proactivity)
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
