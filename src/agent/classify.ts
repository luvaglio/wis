/**
 * Deciding whether a message implies a task that leaves the conversation
 * (SPEC 10).
 *
 * This ran entirely on the router model, and that made it unreliable in a way
 * that looked like the whole product failing. The model reasons before it
 * answers, a long or complex request makes it reason for longer, and once the
 * reasoning exhausts the token budget there is no answer left to parse. The
 * turn then falls through to an ordinary reply, where a model with no live
 * data correctly says it cannot look up flights. Same request, different
 * length, different outcome.
 *
 * So the clear cases are decided here, in code, before any model is involved:
 * deterministic, free, and the same every time. The model is only consulted
 * for genuinely ambiguous wording, and its failure now costs an ambiguous case
 * rather than an obvious one.
 */

export type TaskType = "reservation" | "research" | "outreach" | "generic";

/**
 * Things that read like an instruction but are answerable directly.
 *
 * Checked first, because several of them contain words that otherwise signal a
 * task: "what time is it" contains "time", "tell me about yourself" contains
 * "tell me". Starting a background task for these would be worse than useless.
 */
const ANSWER_DIRECTLY =
  /\b(what|which)\s+(day|date|time|year|month)\b|\bwhat(\s+is|'s)?\s+the\s+(date|time)\b|\bwho\s+are\s+you\b|\bwhat\s+can\s+you\s+do\b|\byour\s+name\b|\bhow\s+are\s+you\b|\bthank(s| you)\b|\b(hello|hi|hey)\b/i;

/**
 * Wording that reliably means work outside the conversation.
 *
 * Ordered: the first match wins, so the more committing intent is listed
 * before the more general one. "Book a flight" is a reservation, not research,
 * even though it mentions a flight.
 */
const TASK_SIGNALS: Array<{ pattern: RegExp; type: TaskType }> = [
  {
    // Committing to a place at a time.
    pattern:
      /\b(book|reserve|reservation|rebook|cancel my|change my)\b|\btable\s+for\b|\bget\s+me\s+a\s+(table|room|seat)\b/i,
    type: "reservation",
  },
  {
    // Reaching a third party on the user's behalf.
    pattern:
      /\b(email|message|text|call|ring|phone|contact|chase|follow up with)\s+(them|him|her|the|my|[A-Z][a-z]+)/i,
    type: "outreach",
  },
  {
    // Finding something out that we cannot know without looking.
    pattern:
      /\b(look\s+(for|up)|search|find\s+(me\s+)?|research|check\s+(if|whether|the|for|availability|prices?)|compare|what(\s+is|'s)?\s+the\s+(price|cost)|how\s+much\s+(is|are|does)|availability|opening\s+(hours|times)|options?\s+for)\b/i,
    type: "research",
  },
  {
    // Named things that only exist as live information.
    pattern: /\b(flights?|hotels?|trains?|restaurants?|tickets?)\b/i,
    type: "research",
  },
];

export type Classification = {
  type: TaskType | null;
  /** Where the decision came from, for logs and for deciding whether to ask a model. */
  source: "direct-answer" | "signal" | "undecided";
};

/**
 * Decide without a model where the wording is clear.
 *
 * Returns `undecided` rather than guessing when nothing matches, so the caller
 * can fall back to the router model for the genuinely ambiguous middle.
 */
export function classifyByWording(text: string): Classification {
  const message = text.trim();
  if (!message) return { type: null, source: "direct-answer" };

  if (ANSWER_DIRECTLY.test(message)) {
    return { type: null, source: "direct-answer" };
  }

  for (const { pattern, type } of TASK_SIGNALS) {
    if (pattern.test(message)) return { type, source: "signal" };
  }

  return { type: null, source: "undecided" };
}
