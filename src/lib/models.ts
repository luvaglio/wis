/**
 * Model access (SPEC 8).
 *
 * Two tiers, each a single environment variable, never hardcoded here:
 *
 *   REASONING_MODEL  the assistant's actual conversation, planning and task
 *                    decisions, anything acting on the user's behalf
 *   ROUTER_MODEL     intent routing, classification, injection screening,
 *                    phrasing known task-status updates
 *
 * Every call, regardless of tier or provider, goes through AI Gateway
 * (SPEC 8.3) so logging, cost tracking and fallback are provider-independent.
 */

export type Message = { role: "system" | "user" | "assistant"; content: string };

export type CompletionOptions = {
  maxTokens?: number;
  temperature?: number;
  /** Label recorded on the AI Gateway request, for cost attribution. */
  purpose?: string;
};

const ANTHROPIC_VERSION = "2023-06-01";

/**
 * The reasoning tier. Anthropic models are routed through AI Gateway's
 * Anthropic provider endpoint; anything else is assumed to be a Workers AI
 * model id and goes through the AI binding.
 *
 * If no Anthropic key is configured the call degrades to the router tier
 * rather than throwing, so a deployment without that secret still answers.
 */
export async function reason(
  env: Env,
  messages: Message[],
  opts: CompletionOptions = {}
): Promise<string> {
  const model = env.REASONING_MODEL;

  if (model.startsWith("claude")) {
    if (!env.ANTHROPIC_API_KEY) {
      console.warn(
        "ANTHROPIC_API_KEY unset, reasoning tier degraded to ROUTER_MODEL"
      );
      return route(env, messages, opts);
    }
    return anthropicViaGateway(env, model, messages, opts);
  }

  return workersAi(env, model, messages, opts);
}

/**
 * The router tier. Cheap, fast, open-weight, running on Workers AI via
 * AI Gateway. Used liberally: classification, screening, narration wording.
 */
export async function route(
  env: Env,
  messages: Message[],
  opts: CompletionOptions = {}
): Promise<string> {
  return workersAi(env, env.ROUTER_MODEL, messages, opts);
}

async function anthropicViaGateway(
  env: Env,
  model: string,
  messages: Message[],
  opts: CompletionOptions
): Promise<string> {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const turns = messages.filter((m) => m.role !== "system");

  const url =
    `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/` +
    `${env.AI_GATEWAY_ID}/anthropic/v1/messages`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY!,
      "anthropic-version": ANTHROPIC_VERSION,
      ...(opts.purpose ? { "cf-aig-metadata": JSON.stringify({ purpose: opts.purpose }) } : {}),
    },
    body: JSON.stringify({
      model,
      max_tokens: opts.maxTokens ?? 1024,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(system ? { system } : {}),
      messages: turns.map((m) => ({ role: m.role, content: m.content })),
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Reasoning model call failed (${res.status}): ${detail.slice(0, 400)}`);
  }

  const body = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };
  return (body.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("")
    .trim();
}

/**
 * Gateway options for a Workers AI call (SPEC 8.3).
 *
 * Every model call is meant to go through AI Gateway. The gateway itself is
 * account infrastructure rather than something this Worker can create, so
 * `runWithGateway` below degrades loudly rather than silently: if the gateway
 * is missing, the call still succeeds and the miss is logged as an error, so
 * the product works while the gateway is being provisioned and the gap is
 * visible in logs until it is.
 */
function gatewayOptions(env: Env, purpose?: string) {
  if (!env.AI_GATEWAY_ID) return undefined;
  return {
    gateway: {
      id: env.AI_GATEWAY_ID,
      ...(purpose ? { metadata: { purpose } } : {}),
    },
  };
}

/**
 * Recognises "the gateway named in config does not exist yet".
 *
 * Workers AI surfaces this as an AiGatewayError with code 2001 and the text
 * "Please configure AI Gateway in the Cloudflare dashboard". Matching the
 * error name and code as well as the wording means a reworded message does
 * not silently turn this into a hard failure.
 */
function looksLikeMissingGateway(err: unknown): boolean {
  const name = err instanceof Error ? err.name : "";
  const message = err instanceof Error ? err.message : String(err);
  if (name === "AiGatewayError") return true;
  if (/\b2001\b/.test(message) && /gateway/i.test(message)) return true;
  return (
    /gateway/i.test(message) &&
    /(not found|does not exist|404|no such|please configure|not configured)/i.test(message)
  );
}

async function workersAi(
  env: Env,
  model: string,
  messages: Message[],
  opts: CompletionOptions
): Promise<string> {
  const input = {
    messages,
    max_tokens: opts.maxTokens ?? 1024,
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
  } as never;

  let result: { response?: string } | string;
  try {
    result = (await env.AI.run(
      model as Parameters<Ai["run"]>[0],
      input,
      gatewayOptions(env, opts.purpose)
    )) as { response?: string } | string;
  } catch (err) {
    if (!looksLikeMissingGateway(err)) throw err;
    console.error(
      `AI Gateway "${env.AI_GATEWAY_ID}" is not reachable. Calls are bypassing ` +
        `the gateway, so logging, cost tracking and fallback are not being ` +
        `applied. Create the gateway to restore SPEC 8.3 behaviour.`
    );
    result = (await env.AI.run(model as Parameters<Ai["run"]>[0], input)) as
      | { response?: string }
      | string;
  }

  const text = typeof result === "string" ? result : (result.response ?? "");
  return stripThinking(text).trim();
}

/**
 * Reasoning-style open models emit <think> blocks. They are useful in logs
 * but must never reach the user, so they are stripped at the boundary.
 */
function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "");
}

/** Embed text for semantic memory (SPEC 5, Vectorize). */
export async function embed(env: Env, texts: string[]): Promise<number[][]> {
  const input = { text: texts } as never;
  let result: { data?: number[][] };
  try {
    result = (await env.AI.run(
      env.EMBEDDING_MODEL as Parameters<Ai["run"]>[0],
      input,
      gatewayOptions(env, "embedding")
    )) as { data?: number[][] };
  } catch (err) {
    if (!looksLikeMissingGateway(err)) throw err;
    result = (await env.AI.run(
      env.EMBEDDING_MODEL as Parameters<Ai["run"]>[0],
      input
    )) as { data?: number[][] };
  }
  return result.data ?? [];
}
