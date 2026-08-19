/**
 * Task classification by wording (SPEC 10).
 *
 * These cases are the ones that decide whether the product appears to work.
 * A request that should start a task and does not falls through to an ordinary
 * reply, where a model with no live data says it cannot help, which reads as
 * the assistant refusing to do its job.
 */

import { describe, it, expect } from "vitest";
import { classifyByWording } from "../src/agent/classify";

describe("classifyByWording", () => {
  it("treats looking things up as research", () => {
    for (const message of [
      "Look for flight options from London to Malaga on 29th August.",
      "Find me a hotel in Marbella for the 29th",
      "Search for restaurants near the office",
      "Research what the Cloudflare Workers free plan includes.",
      "Check availability at Cipriani on Saturday",
      "How much is a return to Malaga?",
      "What's the price of a table at Locanda Locatelli",
      "Compare train times to Manchester",
    ]) {
      expect(classifyByWording(message).type, message).toBe("research");
    }
  });

  it("treats committing to a time and place as a reservation", () => {
    for (const message of [
      "Book me a table at Cipriani for Friday at 8pm for two.",
      "Reserve a room in Marbella for the 29th",
      "Get me a table somewhere on Saturday",
      "Cancel my reservation at Locanda",
    ]) {
      expect(classifyByWording(message).type, message).toBe("reservation");
    }
  });

  it("prefers reservation over research when a request does both", () => {
    // Mentions a flight, but the intent is to commit.
    expect(classifyByWording("Book a flight to Malaga on the 29th").type).toBe("reservation");
  });

  it("treats reaching a third party as outreach", () => {
    for (const message of [
      "Email the restaurant and ask about parking",
      "Call them and confirm the booking",
      "Message my accountant about the invoice",
      "Chase them for a reply",
    ]) {
      expect(classifyByWording(message).type, message).toBe("outreach");
    }
  });

  it("answers directly rather than starting a task", () => {
    for (const message of [
      "What day is it today?",
      "What is the date?",
      "What time is it?",
      "Who are you?",
      "What can you do?",
      "How are you?",
      "Hello",
      "Thanks",
    ]) {
      const result = classifyByWording(message);
      expect(result.type, message).toBeNull();
      expect(result.source, message).toBe("direct-answer");
    }
  });

  it("does not start a task for a question about the time, even worded as a check", () => {
    // "check" is a task signal, but the subject makes it answerable directly.
    expect(classifyByWording("What time is it in Tokyo?").type).toBeNull();
  });

  it("leaves genuinely ambiguous wording undecided for the model", () => {
    for (const message of [
      // A lookup with no task verb in it. Real, and not separable from an
      // ordinary question by wording alone, so the model decides.
      "Does Amex have any FHR in Cyprus?",
      "I need to sort out the Marbella trip",
      "Can you help me with something",
      "That sounds good",
    ]) {
      const result = classifyByWording(message);
      expect(result.source, message).toBe("undecided");
      expect(result.type, message).toBeNull();
    }
  });

  it("treats an empty message as nothing to do", () => {
    expect(classifyByWording("   ").source).toBe("direct-answer");
  });
});
