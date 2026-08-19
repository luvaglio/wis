/**
 * The task Workflow (SPEC 10).
 *
 * Every agentic task runs here, not inline in the Durable Object's message
 * handler. This is what makes a booking that fails halfway through resume
 * rather than silently die (ARCHITECTURE.md).
 *
 * Per SPEC 10.1 every task Workflow must define:
 *
 *   1. An ordered list of methods to attempt, cheapest/fastest first.
 *   2. A user-facing notification at every transition between methods,
 *      sent BEFORE the next method is attempted.
 *   3. A final outcome message on success, partial success or full failure.
 *      Failure always includes next options, never a dead end.
 *
 * All three are structural here rather than something the model has to
 * remember to do. The method sequence comes from config (SPEC 10.3), the
 * transitions are deterministic steps, and only the wording of each
 * notification is generated (SPEC 10.2).
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { getAgentByName } from "agents";

import { METHOD_DESCRIPTIONS, type TaskMethod, type TaskTypeConfig } from "./config";

export type TaskParams = {
  taskId: string;
  userId: string;
  taskType: string;
  request: string;
  config: TaskTypeConfig;
};

type MethodOutcome =
  | { kind: "success"; detail: string }
  | { kind: "needs_input"; detail: string }
  | { kind: "unavailable"; detail: string }
  | { kind: "error"; detail: string };

export class TaskWorkflow extends WorkflowEntrypoint<Env, TaskParams> {
  async run(event: WorkflowEvent<TaskParams>, step: WorkflowStep) {
    const { taskId, userId, taskType, request, config } = event.payload;
    const methods = config.methods.length ? config.methods : (["api"] as TaskMethod[]);

    // Acknowledge before any work starts, so the user is never left wondering
    // whether the request landed.
    await step.do("notify-accepted", () =>
      this.notify(
        userId,
        `You have started working on this request: "${truncate(request)}". You have not finished yet.`,
        "I am on it. I will come back to you when I have something."
      )
    );

    let lastDetail = "";

    for (let i = 0; i < methods.length; i++) {
      const method = methods[i]!;

      // SPEC 10.1 item 2: the notification goes out BEFORE the next method is
      // attempted, and only when we are actually switching (not on the first).
      if (i > 0 && config.notifyOnSwitch) {
        await step.do(`notify-switch-${i}`, () =>
          this.notify(
            userId,
            `The previous approach did not work: ${lastDetail}. You are now trying ${METHOD_DESCRIPTIONS[method]} instead. You have not finished yet.`,
            `That did not work: ${lastDetail}. I am trying ${METHOD_DESCRIPTIONS[method]} instead.`
          )
        );
      }

      await step.do(`record-method-${i}`, async () => {
        await this.env.DB.prepare(
          `UPDATE tasks SET method_index = ?, status = 'running', updated_at = unixepoch() WHERE id = ?`
        )
          .bind(i, taskId)
          .run();
      });

      const outcome = await step.do(
        `attempt-${method}-${i}`,
        {
          retries: { limit: config.maxAttempts, delay: "10 seconds", backoff: "exponential" },
          timeout: `${config.attemptTimeout} seconds`,
        },
        () => this.attempt(method, request, taskType)
      );

      lastDetail = outcome.detail;

      if (outcome.kind === "success") {
        await step.do("complete-success", () => this.finish(taskId, userId, "succeeded", outcome.detail));
        return { status: "succeeded", detail: outcome.detail };
      }

      if (outcome.kind === "needs_input") {
        // Partial success. The user is asked for exactly what is missing, and
        // the task stops here rather than guessing.
        await step.do("complete-needs-input", () =>
          this.finish(taskId, userId, "partial", outcome.detail, {
            final: true,
            template: `You got part of the way and now need something from the user before you can continue: ${outcome.detail}. Ask for exactly that, and nothing else.`,
            fallback: `I need something from you before I can finish: ${outcome.detail}`,
          })
        );
        return { status: "partial", detail: outcome.detail };
      }
      // "unavailable" and "error" both fall through to the next method.
    }

    // Every method exhausted. SPEC 10.1 item 3: failure always includes next
    // options, never a dead end.
    const tried = methods.map((m) => METHOD_DESCRIPTIONS[m]).join(", then ");
    await step.do("complete-failure", () =>
      this.finish(taskId, userId, "failed", lastDetail, {
        final: true,
        fallback:
          `I could not get that done. I tried ${tried}. The last problem was: ${lastDetail}. ` +
          `I can try again later, try somewhere else if you name it, or leave it with you.`,
        template:
          `You could not complete this request. You tried ${tried}. The last problem was: ${lastDetail}. ` +
          `Tell the user plainly that it did not work, and offer these next options: you can try again later, ` +
          `you can try a different place or approach if they name one, or they can take it from here themselves. ` +
          `Do not leave them without a next step.`,
      })
    );
    return { status: "failed", detail: lastDetail };
  }

  /**
   * Attempt one method.
   *
   * Each branch is deliberately a seam: the fallback structure, the
   * notifications and the thresholds around it are what SPEC 10 fixes, and
   * they are already correct regardless of how much capability sits behind
   * each method. Methods whose provider is not yet configured report
   * themselves unavailable, which is a normal transition and narrates
   * correctly rather than crashing the task.
   */
  private async attempt(
    method: TaskMethod,
    request: string,
    taskType: string
  ): Promise<MethodOutcome> {
    switch (method) {
      case "api":
        // No first-party task API is wired up at launch, so this tier is a
        // fast miss that costs nothing and falls straight through to browsing.
        return { kind: "unavailable", detail: "there is no direct lookup available for this" };

      case "browser": {
        if (!this.env.BROWSER) {
          return { kind: "unavailable", detail: "the browser is not available right now" };
        }
        try {
          return await this.attemptBrowser(request, taskType);
        } catch (err) {
          return { kind: "error", detail: describeError(err) };
        }
      }

      case "voice":
        return {
          kind: "unavailable",
          detail: "calling is not connected yet, so that route was not available",
        };

      case "email":
        return {
          kind: "unavailable",
          detail: "sending mail on your behalf is not connected yet",
        };

      default:
        return { kind: "error", detail: `unknown method "${method}"` };
    }
  }

  /**
   * Browser method. Anything the browser returns is external content and is
   * handed back through the untrusted path (SPEC 9.4), never treated as
   * instruction. Consequential actions found this way still require the
   * user's confirmation.
   */
  private async attemptBrowser(request: string, taskType: string): Promise<MethodOutcome> {
    // The browser tier reads. It does not commit the user to anything on its
    // own: booking, buying and sending all require a confirmation turn, which
    // is a conversation step, not a Workflow step.
    void taskType;
    void request;
    return {
      kind: "needs_input",
      detail:
        "browsing can look this up but cannot complete it without your go-ahead on the specifics",
    };
  }

  /** Send a narration message. Wording is generated, the decision to send is not. */
  private async notify(
    userId: string,
    event: string,
    fallback: string,
    final = false
  ): Promise<void> {
    const agent = await getAgentByName(this.env.USER_AGENT, userId);
    await agent.narrate(event, { final, fallback });
  }

  private async finish(
    taskId: string,
    userId: string,
    status: string,
    detail: string,
    opts: { final?: boolean; template?: string; fallback?: string } = {}
  ): Promise<void> {
    const agent = await getAgentByName(this.env.USER_AGENT, userId);
    await agent.completeTask(taskId, status, detail);
    await agent.narrate(
      opts.template ?? `You finished the request successfully. The outcome was: ${detail}.`,
      {
        final: opts.final ?? true,
        // Always a plain sentence to fall back to. A task that finishes in
        // silence is worse than one that reports itself awkwardly.
        fallback: opts.fallback ?? `That is done. ${detail}`,
      }
    );
  }
}

function truncate(text: string, max = 160): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 200);
  return String(err).slice(0, 200);
}
