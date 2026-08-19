/**
 * URL safety for the browsing tier.
 *
 * The URLs the browser is pointed at come from a model, which makes them
 * untrusted input rather than a decision. Without this check the browser
 * would be a way to reach hosts from inside Cloudflare's network that the
 * user could not reach themselves, so these cases are pinned.
 */

import { describe, it, expect } from "vitest";
import { isSafeUrl } from "../src/workflows/browse";

describe("isSafeUrl", () => {
  it("allows ordinary public pages", () => {
    expect(isSafeUrl("https://example.com")).toBe(true);
    expect(isSafeUrl("https://www.cipriani.com/venues/london")).toBe(true);
    expect(isSafeUrl("http://example.org/page?q=1")).toBe(true);
  });

  it("rejects anything that is not http or https", () => {
    for (const url of [
      "file:///etc/passwd",
      "ftp://example.com",
      "data:text/html,<script>alert(1)</script>",
      "javascript:alert(1)",
    ]) {
      expect(isSafeUrl(url)).toBe(false);
    }
  });

  it("rejects loopback and local hostnames", () => {
    for (const url of [
      "http://localhost/admin",
      "http://localhost:8787/api",
      "http://app.localhost/",
      "http://127.0.0.1/",
      "http://0.0.0.0/",
      "http://printer.local/",
      "http://metadata.internal/",
    ]) {
      expect(isSafeUrl(url)).toBe(false);
    }
  });

  it("rejects private and link-local address ranges", () => {
    for (const url of [
      "http://10.0.0.5/",
      "http://192.168.1.1/",
      "http://172.16.0.1/",
      "http://172.31.255.255/",
      "http://169.254.169.254/latest/meta-data/",
    ]) {
      expect(isSafeUrl(url)).toBe(false);
    }
  });

  it("allows public addresses that merely look similar", () => {
    expect(isSafeUrl("http://172.15.0.1/")).toBe(true);
    expect(isSafeUrl("http://172.32.0.1/")).toBe(true);
    expect(isSafeUrl("http://11.0.0.1/")).toBe(true);
  });

  it("rejects anything unparseable", () => {
    expect(isSafeUrl("")).toBe(false);
    expect(isSafeUrl("not a url")).toBe(false);
    expect(isSafeUrl("example.com")).toBe(false);
  });
});
