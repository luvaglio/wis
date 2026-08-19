/** Small HTTP helpers. Kept deliberately thin, no framework. */

export function json(
  data: unknown,
  init: ResponseInit & { headers?: Record<string, string> } = {}
): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function badRequest(message: string): Response {
  return json({ ok: false, error: message }, { status: 400 });
}

export function unauthorized(): Response {
  return json({ ok: false, error: "Sign in first." }, { status: 401 });
}

export function notFound(): Response {
  return json({ ok: false, error: "Not found." }, { status: 404 });
}

/** Escape text for interpolation into server-rendered HTML. */
export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function html(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  return new Response(body, { ...init, headers });
}
