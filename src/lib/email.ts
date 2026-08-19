/**
 * Outbound email (SPEC 6.3).
 *
 * Two paths exist to Cloudflare Email Service, and they do not have the same
 * reach:
 *
 *   REST API   sends to any recipient once the sending domain is onboarded.
 *   Binding    (`env.EMAIL.send`) refuses any destination that is not a
 *              verified address in the account.
 *
 * Sign-in codes go to people who have just typed their address for the first
 * time, so they are by definition unverified. That makes the REST API the only
 * workable path for auth mail, and the same is true of anything the assistant
 * sends on a user's behalf.
 *
 * The binding is kept as a fallback so a deployment without the API token
 * still delivers to verified addresses rather than failing entirely, and says
 * plainly in the logs why reach is limited.
 */

export type OutboundEmail = {
  to: string;
  fromAddress: string;
  fromName: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
};

export type SendResult = { ok: boolean; via: "rest" | "binding" | "none"; detail?: string };

export async function sendEmail(env: Env, message: OutboundEmail): Promise<SendResult> {
  if (env.EMAIL_API_TOKEN) {
    return sendViaRest(env, message);
  }

  console.warn(
    "EMAIL_API_TOKEN unset, falling back to the send_email binding. That path " +
      "only reaches verified destination addresses, so mail to new sign-ups " +
      "will not be delivered."
  );
  return sendViaBinding(env, message);
}

async function sendViaRest(env: Env, message: OutboundEmail): Promise<SendResult> {
  const url =
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}` +
    `/email/sending/send`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.EMAIL_API_TOKEN}`,
      },
      // The REST shape differs from the binding: `address` not `email`, and
      // `reply_to` not `replyTo`.
      body: JSON.stringify({
        to: [message.to],
        from: { address: message.fromAddress, name: message.fromName },
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
        ...(message.replyTo ? { reply_to: message.replyTo } : {}),
      }),
    });

    const body = (await res.json().catch(() => null)) as {
      success?: boolean;
      errors?: Array<{ message?: string }>;
    } | null;

    if (!res.ok || !body?.success) {
      const detail =
        body?.errors?.map((e) => e.message).filter(Boolean).join("; ") ??
        `HTTP ${res.status}`;
      console.error("email send failed via REST", detail);
      return { ok: false, via: "rest", detail };
    }

    return { ok: true, via: "rest" };
  } catch (err) {
    console.error("email send threw via REST", err);
    return { ok: false, via: "rest", detail: describe(err) };
  }
}

async function sendViaBinding(env: Env, message: OutboundEmail): Promise<SendResult> {
  try {
    await env.EMAIL.send({
      to: message.to,
      from: { email: message.fromAddress, name: message.fromName },
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
    });
    return { ok: true, via: "binding" };
  } catch (err) {
    console.error("email send failed via binding", err);
    return { ok: false, via: "binding", detail: describe(err) };
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 300);
  return String(err).slice(0, 300);
}
