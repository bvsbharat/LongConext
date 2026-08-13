/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Sendblue channel adapter — outbound SMS / iMessage plus inbound webhook parsing.
 *
 * Stateless by design: this module never persists anything. It returns result objects
 * and lets the orchestration layer decide what to store or retry.
 *
 * Like the model client in server/llm.ts, the live client is only "constructed" when the
 * credentials are actually present. With no credentials (or MOCK_MODE=true) every send
 * degrades to a logged, synthetic success so the app still runs as a pure demo.
 */

import { createHash } from 'crypto';

const SEND_ENDPOINT = 'https://api.sendblue.co/api/send-message';
const MESSAGES_ENDPOINT = 'https://api.sendblue.co/api/v2/messages';
const WEBHOOKS_ENDPOINT = 'https://api.sendblue.com/api/account/webhooks';

export interface SendSmsOptions {
  to: string;
  body: string;
  /** Sendblue will POST delivery-status transitions here (SENT -> DELIVERED / ERROR). */
  statusCallback?: string;
}

export interface SendSmsResult {
  ok: boolean;
  mock: boolean;
  messageId?: string;
  error?: string;
}

export interface InboundSms {
  fromPhone: string;
  /** The sender exactly as the provider reported it, pre-normalization. Diagnostic only:
   *  deliberately NOT used for index lookups -- see resolveAwaitingContact for why a
   *  sentinel must not be resolvable from an inbound webhook. */
  fromRaw: string;
  text: string;
  service?: string;
  sentAt?: string;
  eventId: string;
}

/**
 * True only when every credential is present and mock mode has not been forced.
 * The UI's vendor-status indicator reads this.
 */
export function isLive(): boolean {
  if (process.env.MOCK_MODE === 'true') return false;
  return Boolean(
    process.env.SENDBLUE_API_KEY_ID?.trim() &&
    process.env.SENDBLUE_API_SECRET_KEY?.trim() &&
    process.env.SENDBLUE_NUMBER?.trim()
  );
}

/**
 * Normalize any phone representation to strict E.164, defaulting to US/+1.
 *
 * This matters more than it looks: the orchestrator keys a MongoDB reverse-index on the
 * number it sent TO, then has to match that key against the `from_number` Sendblue
 * reports on the inbound reply. Those two strings routinely differ in punctuation, a
 * leading country code, or the `+`. Everything on both sides must pass through here.
 *
 * Already-valid E.164 is returned untouched (including non-US country codes) rather
 * than being coerced into a +1 shape.
 */
export function normalizePhone(raw: string): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';

  // Already strict E.164 — leave it alone. Don't assume +1 for e.g. +447700900123.
  if (/^\+[1-9]\d{7,14}$/.test(trimmed)) return trimmed;

  // Strip formatting: spaces, dashes, parens, dots, and any stray non-digits.
  // A leading "00" is the international dialling prefix, equivalent to "+".
  const hadPlus = trimmed.startsWith('+');
  let digits = trimmed.replace(/\D/g, '');
  if (!hadPlus && digits.startsWith('00')) digits = digits.slice(2);

  if (digits.length === 10) return `+1${digits}`;                       // 5551234567
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`; // 15551234567
  if (digits.length === 7) return '';                                   // local-only, unusable

  // Anything else: preserve the digits with a `+` so the caller at least gets a
  // consistent, comparable string instead of a silently reshaped number.
  return digits ? `+${digits}` : '';
}

/** Mock message ids are sequential rather than random so logs/tests stay reproducible. */
let mockSendCounter = 0;

function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Send an SMS / iMessage.
 *
 * PRECONDITION (Sendblue Free Tier): cold outbound is NOT permitted on this account —
 * the recipient must have texted the Sendblue number first, otherwise the API rejects
 * the send. This is an account limitation, not a bug, and is deliberately NOT worked
 * around here. Demo flows must seed an inbound message before expecting delivery.
 *
 * Never throws: transient failures get a short exponential-backoff retry (mirroring
 * generateWithRetry in server.ts) and a final failure resolves to { ok: false, error }.
 */
export async function sendSms(options: SendSmsOptions): Promise<SendSmsResult> {
  const to = normalizePhone(options.to);
  if (!to) {
    return { ok: false, mock: !isLive(), error: `Unusable destination phone: "${options.to}"` };
  }

  if (!isLive()) {
    mockSendCounter++;
    console.log(
      `[Sendblue][MOCK] Would send to ${to}: ${JSON.stringify(options.body)}` +
      `${options.statusCallback ? ` (status_callback=${options.statusCallback})` : ''}`
    );
    return { ok: true, mock: true, messageId: `mock-sms-${mockSendCounter}` };
  }

  const payload = {
    number: to,
    from_number: normalizePhone(process.env.SENDBLUE_NUMBER!),
    content: options.body,
    ...(options.statusCallback ? { status_callback: options.statusCallback } : {})
  };

  const maxAttempts = 3;
  let delay = 500;
  let lastError = 'Unknown Sendblue error';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(SEND_ENDPOINT, {
        method: 'POST',
        headers: {
          'sb-api-key-id': process.env.SENDBLUE_API_KEY_ID!,
          'sb-api-secret-key': process.env.SENDBLUE_API_SECRET_KEY!,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        // Sendblue echoes the message envelope; the id field name has varied across
        // API revisions, so accept the usual suspects before giving up on it.
        const data = await res.json().catch(() => ({} as Record<string, unknown>));
        const messageId =
          (data as any)?.message_handle ?? (data as any)?.messageHandle ?? (data as any)?.id;
        const status = (data as any)?.status;
        console.log(`[Sendblue] Sent to ${to} (status=${status ?? 'unknown'}, id=${messageId ?? 'none'})`);
        return { ok: true, mock: false, messageId: messageId ? String(messageId) : undefined };
      }

      const text = await res.text().catch(() => '');
      lastError = `Sendblue HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`;
      if (!isTransientStatus(res.status) || attempt === maxAttempts) break;
    } catch (err: any) {
      // Network-level failure — always worth one more attempt.
      lastError = `Sendblue network error: ${err?.message ?? String(err)}`;
      if (attempt === maxAttempts) break;
    }

    console.warn(`[Sendblue] Retrying send (attempt ${attempt}/${maxAttempts}) after ${delay}ms — ${lastError}`);
    await new Promise(r => setTimeout(r, delay));
    delay *= 2;
  }

  console.error(`[Sendblue] Send to ${to} failed: ${lastError}`);
  return { ok: false, mock: false, error: lastError };
}

/**
 * Validate and normalize an inbound Sendblue webhook body.
 *
 * Returns null (rather than throwing) for anything unrecognizable so the webhook route
 * can answer 200/400 without a try/catch around it.
 */
export function parseInboundWebhook(body: unknown): InboundSms | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const raw = body as Record<string, unknown>;

  const fromRaw = typeof raw.from_number === 'string' ? raw.from_number : '';
  const text = typeof raw.content === 'string' ? raw.content : '';
  const fromPhone = normalizePhone(fromRaw);

  // An inbound message needs, at minimum, a usable sender and some content.
  // Delivery-status callbacks share the endpoint shape but carry no `content`.
  if (!fromPhone || !text.trim()) return null;

  const service = typeof raw.service === 'string' ? raw.service : undefined;
  const sentAt = typeof raw.date_sent === 'string' ? raw.date_sent : undefined;

  // Sendblue's inbound payload has no explicit message id, so the dedupe key is a
  // deterministic hash of (sender, timestamp, content). Two identical messages sent in
  // the same second would collide — if a future API revision supplies a provider-side
  // id (message_handle / uuid), prefer that and delete this derivation.
  const providerId = typeof raw.message_handle === 'string' ? raw.message_handle : undefined;
  const eventId = providerId
    ? `sb:${providerId}`
    : `sb:${createHash('sha256').update(`${fromPhone}|${sentAt ?? ''}|${text}`).digest('hex').slice(0, 24)}`;

  return { fromPhone, fromRaw, text, service, sentAt, eventId };
}

export interface ListedMessage {
  messageHandle?: string;
  fromPhone: string;
  toPhone: string;
  text: string;
  isOutbound: boolean;
  status?: string;
  sentAt?: string;
  service?: string;
}

/**
 * Recent messages for a phone (Sendblue v2). Used as a long-horizon fallback when
 * the receive webhook was never registered — the UI poll can catch inbound replies
 * the agent would otherwise wait on forever.
 */
export async function listRecentMessages(phone: string, limit = 20): Promise<ListedMessage[]> {
  if (!isLive()) return [];
  const e164 = normalizePhone(phone);
  if (!e164) return [];

  try {
    const url = `${MESSAGES_ENDPOINT}?number=${encodeURIComponent(e164)}&limit=${limit}`;
    const res = await fetch(url, {
      headers: {
        'sb-api-key-id': process.env.SENDBLUE_API_KEY_ID!,
        'sb-api-secret-key': process.env.SENDBLUE_API_SECRET_KEY!,
      },
    });
    if (!res.ok) {
      console.warn(`[Sendblue] listRecentMessages HTTP ${res.status}`);
      return [];
    }
    const data = (await res.json().catch(() => null)) as any;
    const rows = Array.isArray(data?.data) ? data.data : [];
    return rows
      .map((m: any): ListedMessage | null => {
        const fromPhone = normalizePhone(String(m.from_number ?? m.fromNumber ?? ''));
        const toPhone = normalizePhone(String(m.to_number ?? m.toNumber ?? m.number ?? ''));
        const text = typeof m.content === 'string' ? m.content : '';
        if (!fromPhone || !text.trim()) return null;
        return {
          messageHandle: typeof m.message_handle === 'string' ? m.message_handle : undefined,
          fromPhone,
          toPhone,
          text,
          isOutbound: Boolean(m.is_outbound ?? m.isOutbound),
          status: typeof m.status === 'string' ? m.status : undefined,
          sentAt: typeof m.date_sent === 'string' ? m.date_sent : undefined,
          service: typeof m.service === 'string' ? m.service : undefined,
        };
      })
      .filter(Boolean) as ListedMessage[];
  } catch (err: any) {
    console.warn(`[Sendblue] listRecentMessages failed: ${err?.message ?? err}`);
    return [];
  }
}

/**
 * Ensure Conquer's inbound webhook is registered on the Sendblue account.
 * Idempotent — Sendblue appends; duplicates of the same URL are harmless.
 */
export async function ensureReceiveWebhook(webhookUrl: string): Promise<boolean> {
  if (!isLive()) return false;
  if (!webhookUrl.startsWith('https://')) return false;

  try {
    const listRes = await fetch(WEBHOOKS_ENDPOINT, {
      headers: {
        'sb-api-key-id': process.env.SENDBLUE_API_KEY_ID!,
        'sb-api-secret-key': process.env.SENDBLUE_API_SECRET_KEY!,
      },
    });
    if (listRes.ok) {
      const body = (await listRes.json().catch(() => null)) as any;
      const receive: string[] = body?.webhooks?.receive ?? [];
      if (receive.some(u => u === webhookUrl || (typeof u === 'object' && (u as any)?.url === webhookUrl))) {
        return true;
      }
    }

    const createRes = await fetch(WEBHOOKS_ENDPOINT, {
      method: 'POST',
      headers: {
        'sb-api-key-id': process.env.SENDBLUE_API_KEY_ID!,
        'sb-api-secret-key': process.env.SENDBLUE_API_SECRET_KEY!,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ webhooks: [webhookUrl], type: 'receive' }),
    });
    if (!createRes.ok) {
      console.warn(`[Sendblue] ensureReceiveWebhook HTTP ${createRes.status}: ${(await createRes.text()).slice(0, 200)}`);
      return false;
    }
    console.log(`[Sendblue] Registered receive webhook ${webhookUrl}`);
    return true;
  } catch (err: any) {
    console.warn(`[Sendblue] ensureReceiveWebhook failed: ${err?.message ?? err}`);
    return false;
  }
}
