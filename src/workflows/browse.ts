/**
 * The browsing capability behind the `browser` task method
 * (ARCHITECTURE.md, "Web browsing agent").
 *
 * This module only fetches and extracts. It deliberately knows nothing about
 * what the user asked for and never decides anything: everything it returns is
 * external content, and it goes back through the untrusted path (SPEC 9.4)
 * before any of it reaches the reasoning model.
 *
 * It also only reads. Nothing here submits a form, signs in, or commits the
 * user to anything, because those are consequential actions and require the
 * user's confirmation in conversation first (SPEC 9.4 item 3).
 */

import puppeteer from "@cloudflare/puppeteer";

export type PageFinding = {
  url: string;
  title: string;
  text: string;
};

/**
 * Runs inside the page, not in the Worker.
 *
 * Kept as a string on purpose. It needs DOM globals, and adding "dom" to the
 * Worker's tsconfig lib would make `document` and friends appear available in
 * Worker code, where they do not exist. A string keeps that boundary honest:
 * this executes somewhere else.
 *
 * It must be an immediately invoked expression. Puppeteer sends a string to
 * Runtime.evaluate as an expression rather than calling it, so a bare
 * "() => {...}" evaluates to a function object, serialises to undefined, and
 * every page silently reads as empty.
 */
const EXTRACT_PAGE_TEXT = `(() => {
  for (const sel of ["script", "style", "noscript", "svg", "nav", "footer", "header"]) {
    for (const el of Array.from(document.querySelectorAll(sel))) el.remove();
  }
  const main = document.querySelector("main") || document.body;
  return {
    title: document.title || "",
    text: ((main && main.textContent) || "").replace(/\\s+/g, " ").trim()
  };
})()`;

/** Longest extract kept per page. The untrusted wrapper truncates again. */
const MAX_PAGE_CHARS = 6_000;

/** How long to wait for a page before giving up on it. */
const NAVIGATION_TIMEOUT_MS = 20_000;

/** Pages read per task. More than a few is rarely worth the wall clock. */
const MAX_PAGES = 2;

/**
 * Read a list of URLs and return what each one says.
 *
 * One browser is launched for the whole batch and always closed, including on
 * failure: a leaked browser is billed and counts against the concurrency
 * limit. A page that fails is skipped rather than failing the batch, so one
 * dead link cannot lose the findings from a good one.
 */
export async function readPages(env: Env, urls: string[]): Promise<PageFinding[]> {
  const targets = [...new Set(urls.map((u) => u.trim()))].filter(isSafeUrl).slice(0, MAX_PAGES);
  if (targets.length === 0) return [];

  const browser = await puppeteer.launch(env.BROWSER);
  const findings: PageFinding[] = [];

  try {
    for (const url of targets) {
      let page;
      try {
        page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });

        // Strips the page furniture first, so the extract is the content
        // rather than the navigation.
        const finding = (await page.evaluate(EXTRACT_PAGE_TEXT)) as
          | { title?: unknown; text?: unknown }
          | undefined;

        const title = typeof finding?.title === "string" ? finding.title : "";
        const text = typeof finding?.text === "string" ? finding.text : "";

        if (!text) {
          console.warn(`${url} returned no readable text`);
        }

        if (text) {
          findings.push({
            url,
            title: title.slice(0, 200),
            text: text.slice(0, MAX_PAGE_CHARS),
          });
        }
      } catch (err) {
        console.warn(
          `could not read ${url}: ${err instanceof Error ? err.message : String(err)}`
        );
      } finally {
        // Close the page even when evaluate threw, or the browser holds it
        // open for the rest of the batch.
        try {
          await page?.close();
        } catch {
          /* the page is already gone */
        }
      }
    }
  } finally {
    try {
      await browser.close();
    } catch (err) {
      console.warn("could not close browser", err);
    }
  }

  return findings;
}

/**
 * Only http and https, and never a private or loopback host.
 *
 * The URLs come from a model, which means they are effectively untrusted
 * input. Without this a suggested "http://localhost/..." or a link to an
 * internal address would turn the browser into a way to reach things from
 * inside Cloudflare's network that the user could not reach themselves.
 */
export function isSafeUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return false;

  const host = url.hostname.toLowerCase();

  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host.endsWith(".internal") ||
    host.endsWith(".local")
  ) {
    return false;
  }

  // Private and link-local IPv4 ranges, plus IPv6 unique-local.
  if (/^10\./.test(host)) return false;
  if (/^192\.168\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  if (/^169\.254\./.test(host)) return false;
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return false;

  return true;
}
