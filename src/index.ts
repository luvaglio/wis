/**
 * The Worker entry point (ARCHITECTURE.md, "Request flow").
 *
 * Compute and routing only. A WhatsApp/Telegram webhook or an inbound email
 * hits here, the sender is resolved to a user_id, and the request is routed to
 * that user's Durable Object. No model call is ever made at this layer:
 * context assembly, and therefore the untrusted-content boundary, lives inside
 * the Durable Object (SPEC 9.3).
 */

import { getAgentByName, routeAgentEmail } from "agents";

import { UserAgent } from "./agent/user-agent";
import { TaskWorkflow } from "./workflows/task";
import { requestCode, verifyCode, logout, resolveSession } from "./routes/auth";
import {
  saveAccount,
  completeOnboarding,
  updatePreferences,
  changeHandle,
  listMemory,
  addMemory,
  deleteMemory,
  checkHandle,
  proactivityGauge,
  uploadRecording,
} from "./routes/onboarding";
import { renderCard, submitCard, listCards } from "./routes/cards";
import { telegramWebhook, whatsappWebhook } from "./channels/webhooks";
import { createPairingToken, setActiveChannel } from "./channels/linking";
import { json, notFound, unauthorized, badRequest } from "./lib/http";
import { renderApp } from "./routes/app";

export { UserAgent, TaskWorkflow };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      // --- Secure cards (SPEC 7.3). Short path, read and tapped on a phone.
      const cardMatch = path.match(/^\/c\/([a-z0-9]{4,16})$/);
      if (cardMatch) {
        const code = cardMatch[1]!;
        if (method === "GET") return await renderCard(code, env);
        if (method === "POST") return await submitCard(code, request, env);
        return notFound();
      }

      // --- Channel webhooks (SPEC 4).
      if (path === "/webhooks/telegram" && method === "POST") {
        return await telegramWebhook(request, env);
      }
      if (path === "/webhooks/whatsapp") {
        return await whatsappWebhook(request, env);
      }

      // --- API.
      if (path.startsWith("/api/")) {
        return await handleApi(path, method, request, env, ctx);
      }

      // --- The signed-in app surface.
      if (path === "/app" || path.startsWith("/app/")) {
        return await renderApp(request, env);
      }
    } catch (err) {
      console.error(`unhandled error on ${method} ${path}`, err);
      return json({ ok: false, error: "Something went wrong at our end." }, { status: 500 });
    }

    // --- Everything else is the static site, served from ./site.
    return env.ASSETS.fetch(request);
  },

  /**
   * Inbound mail to {handle}@me.wis.ai (SPEC 6.3).
   *
   * One catch-all Email Routing rule forwards all mail here. We read the To
   * header, resolve the handle to a user_id, and hand the message to that
   * user's Durable Object, which treats it as untrusted content (SPEC 6.4).
   */
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const recipient = message.to.toLowerCase().trim();
    const [handle, domain] = recipient.split("@");

    if (!handle || !domain) {
      message.setReject("No such address.");
      return;
    }

    // Only the assistant subdomain carries handles. The catch-all rule covers
    // the whole zone, so anything addressed elsewhere on wis.ai is rejected
    // here rather than being looked up as if it were an assistant.
    if (domain !== env.ASSISTANT_EMAIL_DOMAIN) {
      message.setReject("No such address.");
      return;
    }

    const row = await env.DB.prepare(`SELECT user_id FROM assistant_handles WHERE handle = ?`)
      .bind(handle)
      .first<{ user_id: string }>();

    if (!row) {
      message.setReject("No such address.");
      return;
    }

    // routeAgentEmail hands the message to the named instance, which is the
    // user_id, so the agent's own onEmail handler runs with its full context.
    await routeAgentEmail(message, env, {
      resolver: async () => ({ agentName: "UserAgent", agentId: row.user_id }),
    });
  },
} satisfies ExportedHandler<Env>;

async function handleApi(
  path: string,
  method: string,
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  // --- Auth (SPEC 2.1). Email plus one-time code. No SMS anywhere.
  if (path === "/api/auth/request" && method === "POST") return requestCode(request, env);
  if (path === "/api/auth/verify" && method === "POST") return verifyCode(request, env);
  if (path === "/api/auth/logout" && method === "POST") return logout(request, env);

  // --- Public helpers.
  if (path === "/api/proactivity" && method === "GET") return proactivityGauge(request);
  if (path === "/api/handle/check" && method === "GET") return checkHandle(request, env);

  // --- Everything below requires a session.
  const userId = await resolveSession(request, env);
  if (!userId) return unauthorized();

  if (path === "/api/me" && method === "GET") {
    const user = await env.DB.prepare(
      `SELECT u.id, u.email, u.name, u.country, u.mobile_number, u.mobile_verified, u.onboarded,
              p.assistant_name, p.personality, p.language, p.proactivity,
              h.handle
         FROM users u
         LEFT JOIN preferences p ON p.user_id = u.id
         LEFT JOIN assistant_handles h ON h.user_id = u.id
        WHERE u.id = ?`
    )
      .bind(userId)
      .first();

    const connections = await env.DB.prepare(
      `SELECT channel, is_active_outbound FROM connections WHERE user_id = ?`
    )
      .bind(userId)
      .all();

    return json({
      ok: true,
      user,
      assistant_email: (user as { handle?: string } | null)?.handle
        ? `${(user as { handle: string }).handle}@${env.ASSISTANT_EMAIL_DOMAIN}`
        : null,
      connections: connections.results ?? [],
    });
  }

  if (path === "/api/account" && method === "POST") return saveAccount(request, env);
  if (path === "/api/onboarding" && method === "POST") return completeOnboarding(request, env);
  if (path === "/api/preferences" && method === "POST") return updatePreferences(request, env);
  if (path === "/api/handle" && method === "POST") return changeHandle(request, env);
  if (path === "/api/memory" && method === "GET") return listMemory(request, env);
  if (path === "/api/memory" && method === "POST") return addMemory(request, env);
  if (path === "/api/memory" && method === "DELETE") return deleteMemory(request, env);
  if (path === "/api/recording" && method === "POST") return uploadRecording(request, env);
  if (path === "/api/cards" && method === "GET") return listCards(env, userId);

  // --- Channel linking (SPEC 4.3).
  if (path === "/api/channels/pair" && method === "POST") {
    return json({ ok: true, ...(await createPairingToken(env, userId)) });
  }

  if (path === "/api/channels/active" && method === "POST") {
    const body = (await request.json().catch(() => null)) as { channel?: string } | null;
    const channel = body?.channel;
    if (channel !== "whatsapp" && channel !== "telegram") {
      return badRequest("Pick whatsapp or telegram.");
    }
    await setActiveChannel(env, userId, channel);
    return json({ ok: true });
  }

  // --- Chat from the web surface. Same Durable Object path as any channel.
  if (path === "/api/chat" && method === "POST") {
    const body = (await request.json().catch(() => null)) as { message?: string } | null;
    const text = (body?.message ?? "").trim();
    if (!text) return badRequest("Say something first.");

    const agent = await getAgentByName(env.USER_AGENT, userId);
    const reply = await agent.handleInbound({ channel: "web", text });
    return json({ ok: true, reply });
  }

  // --- Data export and deletion. "Your data is yours" (site/values).
  if (path === "/api/data" && method === "GET") {
    return exportUserData(env, userId);
  }

  if (path === "/api/data" && method === "DELETE") {
    ctx.waitUntil(deleteUserData(env, userId));
    return json({ ok: true });
  }

  return notFound();
}

/** Everything we hold on this user, in one document. */
async function exportUserData(env: Env, userId: string): Promise<Response> {
  const [user, prefs, connections, tasks, cards, handle] = await Promise.all([
    env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(userId).first(),
    env.DB.prepare(`SELECT * FROM preferences WHERE user_id = ?`).bind(userId).first(),
    env.DB.prepare(`SELECT * FROM connections WHERE user_id = ?`).bind(userId).all(),
    env.DB.prepare(`SELECT * FROM tasks WHERE user_id = ?`).bind(userId).all(),
    env.DB.prepare(
      `SELECT shortcode, card_type, reason, status, created_at, used_at FROM cards WHERE user_id = ?`
    )
      .bind(userId)
      .all(),
    env.DB.prepare(`SELECT handle FROM assistant_handles WHERE user_id = ?`).bind(userId).first(),
  ]);

  const files = await env.FILES.list({ prefix: `users/${userId}/` });

  return json({
    ok: true,
    exported_at: new Date().toISOString(),
    user,
    preferences: prefs,
    assistant_handle: handle,
    connections: connections.results ?? [],
    tasks: tasks.results ?? [],
    cards: cards.results ?? [],
    files: files.objects.map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded })),
  });
}

/**
 * Delete everything we hold on this user.
 *
 * "Your data is yours. You can download or delete it at any time" is a
 * promise on the values page, so this clears all three stores rather than
 * just the relational one: R2 objects, Vectorize vectors, then D1 (which
 * cascades the rest). Vectorize goes before D1 because the vector ids live in
 * a D1 table that the cascade would otherwise remove first.
 */
async function deleteUserData(env: Env, userId: string): Promise<void> {
  const files = await env.FILES.list({ prefix: `users/${userId}/` });
  await Promise.all(files.objects.map((o) => env.FILES.delete(o.key)));

  try {
    // Vectorize has no delete-by-filter, so the ids come from our own record
    // of what we wrote.
    const chunks = await env.DB.prepare(
      `SELECT vector_id FROM memory_chunks WHERE user_id = ?`
    )
      .bind(userId)
      .all<{ vector_id: string }>();

    const ids = (chunks.results ?? []).map((c) => c.vector_id);
    if (ids.length) await env.MEMORY.deleteByIds(ids);
  } catch (err) {
    console.warn("vector cleanup incomplete", err);
  }

  await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(userId).run();
}
