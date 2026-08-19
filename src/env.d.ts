/**
 * Secrets and optional bindings.
 *
 * `worker-configuration.d.ts` is generated from wrangler.jsonc and covers the
 * declared bindings and vars. Secrets are set with `wrangler secret put` and
 * never appear in configuration, so they are declared here instead.
 *
 * Every one of these is optional on purpose. The Worker deploys and runs
 * without them; each feature that needs one degrades visibly and says so,
 * rather than failing at import time or, worse, silently doing the wrong
 * thing. See README for what each unlocks.
 */

interface Env {
  /**
   * Cloudflare API token with Email Sending permission.
   *
   * Required to reach recipients who are not verified destination addresses,
   * which is every new sign-up. Without it, auth mail falls back to the
   * send_email binding and only reaches verified addresses.
   */
  EMAIL_API_TOKEN?: string;

  /** Reasoning tier via AI Gateway. Without it, that tier degrades to ROUTER_MODEL. */
  ANTHROPIC_API_KEY?: string;

  /** Telegram bot (SPEC 4). */
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_BOT_USERNAME?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;

  /** WhatsApp Cloud API (SPEC 4). */
  WHATSAPP_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
  WHATSAPP_NUMBER?: string;
  WHATSAPP_VERIFY_TOKEN?: string;
  WHATSAPP_APP_SECRET?: string;

  /** Stripe, for tokenising payment cards (SPEC 7.2). */
  STRIPE_SECRET_KEY?: string;
  STRIPE_PUBLISHABLE_KEY?: string;

  /**
   * The credential vault (SPEC 7.2). Passwords and logins live here, never in
   * D1, and the assistant holds only a reference. Credential cards fail closed
   * while this is unset: better to tell the user it did not save than to put a
   * raw credential somewhere it does not belong.
   */
  VAULT?: { put(name: string, value: string): Promise<unknown> };
}
