/**
 * Tone and personality rules (docs/CONTENT_AND_TONE.md).
 *
 * That document says its rules are requirements, not style suggestions, so
 * the ones that can be checked mechanically are checked here.
 */

import { describe, it, expect } from "vitest";

import {
  BASE_SYSTEM_PROMPT,
  personalityLayer,
  proactivityEstimate,
  narrationPrompt,
  type Preferences,
} from "../src/agent/prompts";

function prefs(overrides: Partial<Preferences> = {}): Preferences {
  return {
    assistant_name: "Aria",
    address_as: null,
    personality: "butler",
    personality_note: null,
    language: "en",
    proactivity: 3,
    ...overrides,
  };
}

describe("base system prompt", () => {
  it("encodes the universal rules, which apply regardless of preset", () => {
    expect(BASE_SYSTEM_PROMPT).toContain("Never use em dashes");
    expect(BASE_SYSTEM_PROMPT).toContain("Be brief by default");
    expect(BASE_SYSTEM_PROMPT).toContain("eyebrow titles");
  });

  it("contains no em dashes itself", () => {
    expect(BASE_SYSTEM_PROMPT).not.toContain("—");
  });

  it("states the untrusted-content and confirmation rules", () => {
    expect(BASE_SYSTEM_PROMPT).toContain("<untrusted_content>");
    expect(BASE_SYSTEM_PROMPT).toContain("requires your user's confirmation");
  });

  it("forbids claiming an action completed when it has not", () => {
    expect(BASE_SYSTEM_PROMPT).toContain("NEVER CLAIM SOMETHING HAPPENED THAT DID NOT");
    expect(BASE_SYSTEM_PROMPT).toContain("Do not invent a confirmation number");
  });
});

describe("personality layer", () => {
  it("defaults to the butler voice with Sir or Madam", () => {
    const layer = personalityLayer(prefs());
    expect(layer).toContain("British butler");
    expect(layer).toContain('"Sir" or "Madam"');
  });

  it("lets a stated form of address override the preset default", () => {
    const layer = personalityLayer(prefs({ address_as: "Rohan" }));
    expect(layer).toContain('Address the user as "Rohan"');
    expect(layer).not.toContain('"Sir" or "Madam"');
    expect(layer).toContain("until they change it");
  });

  it("does not force-fit the butler voice into other presets", () => {
    for (const personality of ["warm", "no-nonsense", "formal"] as const) {
      const layer = personalityLayer(prefs({ personality }));
      expect(layer).not.toContain("British butler");
      expect(layer).not.toContain('"Sir" or "Madam"');
    }
  });

  it("carries the user's own description for a custom voice", () => {
    const layer = personalityLayer(
      prefs({ personality: "custom", personality_note: "Like a sardonic older brother" })
    );
    expect(layer).toContain("sardonic older brother");
  });

  it("contains no em dashes in any preset", () => {
    for (const personality of ["butler", "warm", "no-nonsense", "formal", "custom"] as const) {
      expect(personalityLayer(prefs({ personality }))).not.toContain("—");
    }
  });

  it("renders the assistant's name and language", () => {
    const layer = personalityLayer(prefs({ assistant_name: "Jeeves", language: "fr" }), "Rohan");
    expect(layer).toContain("Jeeves");
    expect(layer).toContain("fr");
    expect(layer).toContain("Rohan");
  });
});

describe("proactivity", () => {
  it("gives a concrete message estimate, not a token count", () => {
    expect(proactivityEstimate(3)).toBe("roughly 20 messages a month");
    expect(proactivityEstimate(1)).toContain("messages a month");
    expect(proactivityEstimate(5)).toContain("messages a month");
  });

  it("clamps out-of-range levels rather than failing", () => {
    expect(proactivityEstimate(0)).toBe(proactivityEstimate(1));
    expect(proactivityEstimate(9)).toBe(proactivityEstimate(5));
  });

  it("changes how forward the assistant is told to be", () => {
    expect(personalityLayer(prefs({ proactivity: 1 }))).toContain("Only act when asked");
    expect(personalityLayer(prefs({ proactivity: 5 }))).toContain("Check in regularly");
  });
});

describe("narration prompt (SPEC 10.2)", () => {
  it("asks only for wording of an event that already happened", () => {
    const prompt = narrationPrompt(prefs());
    expect(prompt).toContain("already happened");
    expect(prompt).toContain("Do not add information that is not in the description");
    expect(prompt).toContain("Do not use em dashes");
  });
});
