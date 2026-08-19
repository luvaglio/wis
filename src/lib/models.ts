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
 * Token budget for short, structured router calls: classification, screening,
 * normalisation. It has to cover the model's own reasoning as well as the one
 * line we actually want back. Budgeting only for the answer produces a reply
 * that is entirely scratchpad and parses as nothing.
 */
export const ROUTER_STRUCTURED_TOKENS = 512;

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
 * account infrastructure rather than something this Worker can create, so a
 * missing one degrades loudly rather than silently: the call still succeeds,
 * and the miss is logged, so the product works while the gateway is being
 * provisioned and the gap stays visible until it is.
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
 * Throttle for the missing-gateway warning.
 *
 * Every model call hits it, so a single conversation turn produced several
 * identical lines and genuine errors got lost between them. Module scope is
 * safe for this: it holds no user data, and the worst case of an isolate
 * resetting it is that the warning is logged slightly more often.
 */
let lastGatewayWarningAt = 0;
const GATEWAY_WARNING_INTERVAL_MS = 60_000;

function warnMissingGateway(env: Env): void {
  const now = Date.now();
  if (now - lastGatewayWarningAt < GATEWAY_WARNING_INTERVAL_MS) return;
  lastGatewayWarningAt = now;
  console.error(
    `AI Gateway "${env.AI_GATEWAY_ID}" is not reachable. Calls are bypassing ` +
      `the gateway, so logging, cost tracking and fallback are not being ` +
      `applied. Create the gateway to restore SPEC 8.3 behaviour. ` +
      `(further occurrences suppressed for 60s)`
  );
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
  const budget = opts.maxTokens ?? 1024;

  const answer = await runOnce(env, model, messages, budget, opts);
  if (answer.text) return answer.text;

  // The entire budget went on reasoning and the model never reached an answer.
  // One retry with double the budget, which is cheap on this tier and the
  // difference between a reply and silence.
  if (answer.spentOnThinking) {
    console.warn(
      `${model} produced only reasoning within ${budget} tokens, retrying with ${budget * 2}`
    );
    const retry = await runOnce(env, model, messages, budget * 2, opts);
    return retry.text;
  }

  return "";
}

async function runOnce(
  env: Env,
  model: string,
  messages: Message[],
  maxTokens: number,
  opts: CompletionOptions
): Promise<{ text: string; spentOnThinking: boolean }> {
  const input = {
    messages,
    max_tokens: maxTokens,
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
    warnMissingGateway(env);
    result = (await env.AI.run(model as Parameters<Ai["run"]>[0], input)) as
      | { response?: string }
      | string;
  }

  const raw = typeof result === "string" ? result : (result.response ?? "");
  const text = stripThinking(raw).trim();
  return { text, spentOnThinking: !text && raw.includes("<think>") };
}

/**
 * Reasoning-style open models emit <think> blocks. They are useful in logs but
 * must never reach the user, so they are stripped at the boundary.
 *
 * The unterminated case matters as much as the closed one. If the token budget
 * runs out mid-thought there is no closing tag, and a naive strip leaves the
 * model's scratchpad as the entire "answer". That silently broke the task
 * classifier, which had a budget too small to think and answer: it always
 * returned reasoning text, never matched, and so no request was ever treated
 * as a task. Anything from an unclosed <think> to the end is discarded.
 */
function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<think>[\s\S]*$/, "");
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
    warnMissingGateway(env);
    result = (await env.AI.run(
      env.EMBEDDING_MODEL as Parameters<Ai["run"]>[0],
      input
    )) as { data?: number[][] };
  }
  return result.data ?? [];
}
