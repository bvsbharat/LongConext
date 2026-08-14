/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ElevenLabs Conversational AI voice channel.
 *
 * Places outbound phone calls to policyholders and vendors and reads back the
 * resulting transcript. The phone number is a Twilio number bound *inside* the
 * ElevenLabs workspace, so this app never talks to Twilio directly.
 *
 * Stateless apart from a memoized client: every function returns a value and
 * writes no state. Persistence (the conversationId -> claim reverse index) and
 * orchestration belong to the caller.
 *
 * MOCK_MODE: with no credentials configured, nothing throws and no phone rings.
 * Mock is the safe default precisely because a real call dials a real person.
 */

import crypto from 'crypto';
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import type { ChatMessage } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

// Same spirit as getLlmClient() in server/llm.ts: construct lazily, only when a
// key is actually present, and fall back to canned behavior otherwise.
let client: ElevenLabsClient | null = null;
function getElevenLabsClient(): ElevenLabsClient | null {
  if (!client) {
    const key = process.env.ELEVENLABS_API_KEY;
    if (key && key.trim() !== '' && key !== 'MY_ELEVENLABS_API_KEY') {
      try {
        client = new ElevenLabsClient({ apiKey: key });
        console.log('[voice] ElevenLabs SDK client initialized successfully.');
      } catch (err) {
        console.error('[voice] Error initializing ElevenLabsClient:', err);
      }
    }
  }
  return client;
}

/**
 * True only when every credential needed to actually dial is present and
 * MOCK_MODE has not been forced on. Anything less and the adapter mocks.
 */
export function isLive(): boolean {
  if (process.env.MOCK_MODE === 'true') return false;
  return Boolean(
    process.env.ELEVENLABS_API_KEY &&
      process.env.ELEVENLABS_AGENT_ID &&
      process.env.ELEVENLABS_PHONE_NUMBER_ID
  );
}

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

/** 429, 5xx and bare network/timeout errors are worth another attempt; 4xx is not. */
function isTransient(err: any): boolean {
  const status = err?.statusCode ?? err?.status;
  if (typeof status === 'number') return status === 429 || status >= 500;
  return true; // no status at all => network reset / DNS / timeout
}

/** Exponential backoff, in the spirit of generateWithRetry in server.ts. */
async function withRetry<T>(label: string, fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastErr: any;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      if (attempt === maxAttempts || !isTransient(err)) break;
      const delay = 500 * 2 ** (attempt - 1);
      console.warn(`[voice] ${label} attempt ${attempt} failed (${errText(err)}); retrying in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

function errText(err: any): string {
  if (!err) return 'unknown error';
  const status = err?.statusCode ?? err?.status;
  const msg = err?.message ?? String(err);
  return status ? `${status} ${msg}` : msg;
}

// ---------------------------------------------------------------------------
// Transcript normalization
// ---------------------------------------------------------------------------

/**
 * The one place provider transcript turns become ChatMessage.
 *
 * ElevenLabs labels turns `agent` / `user` (confirmed: the SDK's
 * ConversationHistoryTranscriptResponseModelRole enum is exactly
 * {"user","agent"}); the app's ChatMessage uses `agent` / `recipient`, so
 * `user` maps to `recipient`.
 *
 * Reads both camelCase and snake_case because the two sources disagree: the
 * typed SDK response is camelCased by Fern, while raw webhook JSON is
 * snake_case straight off the API.
 *
 * Turns with no text (tool-call-only turns) are dropped -- they are not
 * something a human said.
 */
function toChatMessages(
  turns: unknown,
  names: { agent: string; recipient: string }
): ChatMessage[] {
  if (!Array.isArray(turns)) return [];
  const out: ChatMessage[] = [];
  for (const turn of turns as any[]) {
    const role = turn?.role;
    const text =
      turn?.message ?? turn?.original_message ?? turn?.originalMessage ?? turn?.text ?? turn?.content;
    if (typeof text !== 'string' || text.trim() === '') continue;
    const sender: ChatMessage['sender'] = role === 'agent' ? 'agent' : 'recipient';
    out.push({
      sender,
      name: sender === 'agent' ? names.agent : names.recipient,
      text: text.trim(),
    });
  }
  return out;
}

const DEFAULT_AGENT_NAME = 'Conquer Agent';
const DEFAULT_RECIPIENT_NAME = 'Recipient';

// ---------------------------------------------------------------------------
// Outbound calls
// ---------------------------------------------------------------------------

export interface PlaceCallArgs {
  toNumber: string;
  /** Flat per-claim context injected as ElevenLabs dynamic variables. */
  contextVars: Record<string, string>;
  /** Optional override for the agent's opening line. */
  firstMessage?: string;
}

export interface PlaceCallResult {
  ok: boolean;
  mock: boolean;
  /** Reverse-index key the orchestrator uses to match a later webhook to a claim. */
  conversationId?: string;
  callSid?: string;
  error?: string;
}

let mockCallSeq = 0;

/**
 * Dial `toNumber` with the workspace agent, injecting `contextVars` as dynamic
 * variables so the agent's opening turn knows which claim it is calling about.
 *
 * Never throws: transient failures are retried, then reported as
 * { ok: false, error } so the orchestrator decides whether to reschedule.
 */
/** Placeholders Conquer injects on every outbound dial. Must be registered on the
 *  ElevenLabs agent or {{claim_id}} / {{claimant_name}} stay unsubstituted. */
export const CLAIM_DYNAMIC_VARIABLE_KEYS = [
  'claim_id',
  'claimant_name',
  'claim_type',
  'claim_amount',
  'policy_number',
  'claim_description',
  'claim_status',
  'step_signal',
  'agent_memory',
  'recipient_name',
  'purpose',
  'collection_goals',
] as const;

let ensuredDynamicVarsForAgent: string | null = null;

/**
 * Neutral defaults for every claim dynamic variable. Shared by the agent-registration call
 * and by the per-call payload builder, so a value can never be registered with one default
 * and substituted with another. Missing keys get a harmless word rather than an empty
 * string, since ElevenLabs leaves absent variables unsubstituted mid-sentence.
 */
const CLAIM_VARIABLE_PLACEHOLDERS: Record<string, string> = {
  claim_id: 'claim:0000',
  claimant_name: 'Policyholder',
  claim_type: 'claim',
  claim_amount: '$0.00',
  policy_number: 'POLICY',
  claim_description: 'claim details',
  claim_status: 'PROCESSING',
  step_signal: 'current step',
  agent_memory: '(none)',
  recipient_name: 'Recipient',
  purpose: 'confirm claim details',
  collection_goals: 'Get the one fact this call needs, then end.',
};

/** Placeholder for a key with no usable value. Never returns an empty string. */
function placeholdersFallback(key: string): string {
  return CLAIM_VARIABLE_PLACEHOLDERS[key] || 'not provided';
}

/** Replace {{var}} / {{ var }} so TTS never speaks brace names like "claim_id". */
function interpolateTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key: string) => {
    const v = vars[key];
    return typeof v === 'string' && v.trim() !== '' ? v : placeholdersFallback(key);
  });
}

function buildSpokenFirstMessage(firstMessage: string | undefined, vars: Record<string, string>): string {
  const role = vars.recipient_name || 'Recipient';
  const defaultOpener =
    `Hi, Conquer calling ${role} on claim ${vars.claim_id} for ${vars.claimant_name}.`;
  const base = firstMessage?.trim() || defaultOpener;
  return interpolateTemplate(base, vars);
}

function buildPromptOverride(vars: Record<string, string>): string {
  const role = vars.recipient_name || 'Recipient';
  const goals = vars.collection_goals || vars.purpose;
  return `You are Conquer Claims on a short outbound phone call.
Pace: FAST and BRIEF. One question per turn. At most TWO questions on the whole call, then wrap up.
Speak in 1 short sentence, 2 only if you must. No small talk, no recap of the whole claim, no extra confirmations.

ROLE:
- YOU are Conquer. The person who answered is "${role}", not the patient ${vars.claimant_name} unless ${role} is the claimant.
- Collect the one fact below. Do not ask them what Conquer should invent or send unless they are a Provider who can supply docs.
- Payer: ask auth status only. If they volunteer missing docs or a case number, take it. Do not interrogate.
- Provider: one ask — will they submit the requested evidence.
- Shop: one ask — revised total / concession. Do not walk labor, OEM, and price as separate questions. Do not invent discounts.
- Claimant: one confirm on schedule or settlement figures. Then hang up.

THE ASK (get this, then end):
${goals}

Facts (use these values — never say placeholder names like claim_id):
- Claim: ${vars.claim_id} · ${vars.claimant_name} · ${vars.claim_type} · ${vars.claim_amount}
- Policy: ${vars.policy_number}
- Purpose: ${vars.purpose}
- Memory: ${vars.agent_memory}

Flow: opener already stated who you are. Ask the one thing. If they answer, thank them in one clause and end the call. If they do not know, leave a callback and end. Do not promise payment.`;
}

/**
 * Register placeholders and enable firstMessage/prompt client overrides.
 * Uses raw PATCH — the SDK update path has left dynamic_variable_placeholders empty,
 * and overrides default to false so outbound firstMessage was ignored.
 */
export async function ensureClaimDynamicVariables(agentId: string): Promise<void> {
  if (!isLive() || !agentId) return;
  if (ensuredDynamicVarsForAgent === agentId) return;
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return;

  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${agentId}`, {
      method: 'PATCH',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        conversation_config: {
          agent: {
            first_message:
              'Hi, this is Conquer calling about claim {{claim_id}} for {{claimant_name}}. Do you have a quick moment?',
            dynamic_variables: {
              dynamic_variable_placeholders: { ...CLAIM_VARIABLE_PLACEHOLDERS },
            },
          },
        },
        platform_settings: {
          overrides: {
            conversation_config_override: {
              agent: {
                first_message: true,
                language: true,
                prompt: { prompt: true },
              },
            },
          },
        },
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${res.status} ${text.slice(0, 200)}`);
    }
    ensuredDynamicVarsForAgent = agentId;
    console.log(`[voice] Ensured claim dynamic vars + firstMessage/prompt overrides on ${agentId}`);
  } catch (err: any) {
    console.warn(`[voice] Could not ensure dynamic variables: ${err?.message ?? err}`);
  }
}

export async function placeCall({
  toNumber,
  contextVars,
  firstMessage,
}: PlaceCallArgs): Promise<PlaceCallResult> {
  const el = isLive() ? getElevenLabsClient() : null;

  if (!el) {
    const conversationId = `mock-conv-${Date.now().toString(36)}-${(++mockCallSeq).toString(36)}`;
    console.log(
      `[voice][MOCK] Would have called ${toNumber} as conversation ${conversationId}.\n` +
        `[voice][MOCK]   first message: ${firstMessage ?? '(agent default)'}\n` +
        `[voice][MOCK]   context vars: ${JSON.stringify(contextVars)}`
    );
    return { ok: true, mock: true, conversationId };
  }

  const agentId = process.env.ELEVENLABS_AGENT_ID!;
  const agentPhoneNumberId = process.env.ELEVENLABS_PHONE_NUMBER_ID!;

  // Guarantee every context key is a non-empty string — ElevenLabs drops / leaves
  // unsubstituted keys that are missing from the initiation payload.
  const dynamicVariables: Record<string, string> = {};
  for (const key of CLAIM_DYNAMIC_VARIABLE_KEYS) {
    const raw = contextVars[key];
    dynamicVariables[key] = typeof raw === 'string' && raw.trim() !== '' ? raw : placeholdersFallback(key);
  }

  // Pre-interpolate so TTS never speaks "{{claim_id}}" even if ElevenLabs
  // templating fails. firstMessage/prompt overrides must be enabled on the agent.
  const spokenFirst = buildSpokenFirstMessage(firstMessage, dynamicVariables);
  const promptOverride = buildPromptOverride(dynamicVariables);

  await ensureClaimDynamicVariables(agentId);

  console.log(
    `[voice] Dialing ${toNumber} with claim_id=${dynamicVariables.claim_id} ` +
      `claimant=${dynamicVariables.claimant_name} first="${spokenFirst.slice(0, 120)}"`
  );

  try {
    const res = await withRetry(`outboundCall to ${toNumber}`, () =>
      el.conversationalAi.twilio.outboundCall({
        agentId,
        agentPhoneNumberId,
        toNumber,
        // Recording is off unless explicitly opted in -- these are calls with
        // real policyholders.
        callRecordingEnabled: process.env.ELEVENLABS_RECORD_CALLS === 'true',
        conversationInitiationClientData: {
          dynamicVariables,
          conversationConfigOverride: {
            agent: {
              firstMessage: spokenFirst,
              prompt: { prompt: promptOverride },
            },
          },
        },
      })
    );

    // Response shape confirmed against the installed SDK's
    // TwilioOutboundCallResponse: { success, message, conversationId?, callSid? }.
    if (!res?.success) {
      return { ok: false, mock: false, error: res?.message || 'outbound call rejected by ElevenLabs' };
    }
    if (!res.conversationId) {
      // The orchestrator cannot index the call without this, so surface it
      // rather than silently returning a half-usable success.
      return {
        ok: false,
        mock: false,
        callSid: res.callSid,
        error: 'ElevenLabs accepted the call but returned no conversationId',
      };
    }
    console.log(`[voice] Placed call to ${toNumber} (conversation ${res.conversationId}).`);
    return { ok: true, mock: false, conversationId: res.conversationId, callSid: res.callSid };
  } catch (err: any) {
    console.error(`[voice] Outbound call to ${toNumber} failed: ${errText(err)}`);
    return { ok: false, mock: false, error: errText(err) };
  }
}

// ---------------------------------------------------------------------------
// Conversation status / transcript
// ---------------------------------------------------------------------------

export interface GetConversationResult {
  ok: boolean;
  mock: boolean;
  /** ElevenLabs status: initiated | in-progress | processing | done | failed. */
  status?: string;
  transcript?: ChatMessage[];
  summary?: string;
  callDurationSecs?: number;
  terminationReason?: string;
  hasUserAudio?: boolean;
  error?: string;
}

/** Canned transcript so the demo has something to render without credentials. */
function mockTranscript(): ChatMessage[] {
  return [
    {
      sender: 'agent',
      name: DEFAULT_AGENT_NAME,
      text: "Hi, this is the claims assistant calling about your open claim. Do you have a moment to confirm a couple of details?",
    },
    { sender: 'recipient', name: DEFAULT_RECIPIENT_NAME, text: 'Yes, go ahead.' },
    {
      sender: 'agent',
      name: DEFAULT_AGENT_NAME,
      text: 'Thanks. I have the repair estimate at four thousand two hundred dollars. Can you confirm the shop has the vehicle now?',
    },
    {
      sender: 'recipient',
      name: DEFAULT_RECIPIENT_NAME,
      text: 'That is right, they picked it up Tuesday and said about a week.',
    },
    {
      sender: 'agent',
      name: DEFAULT_AGENT_NAME,
      text: 'Perfect, I will note that and send the authorization. You will get a text confirmation shortly.',
    },
  ];
}

/**
 * Fetch a conversation's status and transcript. Poll-style companion to the
 * webhook path -- useful when a webhook was missed or the app is behind NAT.
 */
export async function getConversation(conversationId: string): Promise<GetConversationResult> {
  const el = isLive() ? getElevenLabsClient() : null;

  if (!el) {
    console.log(`[voice][MOCK] Returning canned transcript for conversation ${conversationId}.`);
    return { ok: true, mock: true, status: 'done', transcript: mockTranscript(), summary: 'Mock call: recipient confirmed the repair estimate and vehicle drop-off.' };
  }

  try {
    // Confirmed path/signature: conversations.get(conversation_id, request?).
    const res = await withRetry(`conversations.get ${conversationId}`, () =>
      el.conversationalAi.conversations.get(conversationId)
    );
    return {
      ok: true,
      mock: false,
      status: res.status,
      transcript: toChatMessages(res.transcript, {
        agent: res.agentName || DEFAULT_AGENT_NAME,
        recipient: DEFAULT_RECIPIENT_NAME,
      }),
      summary: res.analysis?.transcriptSummary,
      callDurationSecs: res.metadata?.callDurationSecs,
      terminationReason: res.metadata?.terminationReason,
      hasUserAudio: res.hasUserAudio,
    };
  } catch (err: any) {
    console.error(`[voice] Failed to fetch conversation ${conversationId}: ${errText(err)}`);
    return { ok: false, mock: false, error: errText(err) };
  }
}

// ---------------------------------------------------------------------------
// Webhook signature verification
// ---------------------------------------------------------------------------

/** Replay window. Matches the 30 minutes the SDK's own constructEvent() allows. */
const SIGNATURE_TOLERANCE_MS = 30 * 60 * 1000;

/**
 * Verify an `elevenlabs-signature` header.
 *
 * Format confirmed by reading the installed SDK's own implementation
 * (node_modules/@elevenlabs/elevenlabs-js/wrapper/webhooks.js, constructEvent):
 * the header is Stripe-style `t=<unix_seconds>,v0=<hmac_sha256_hex>`, the signed
 * payload is `<timestamp>.<rawBody>`, and the SDK rejects timestamps older than
 * 30 minutes. We reimplement rather than call constructEvent for two reasons:
 * it throws instead of returning a boolean, and it compares digests with `!==`
 * (not constant-time). We use crypto.timingSafeEqual.
 *
 * TRADEOFF -- fail closed only when a secret exists: if ELEVENLABS_WEBHOOK_SECRET
 * is set, a missing/invalid/stale signature returns false. If it is NOT set we
 * return true and warn loudly, so the mock demo runs without a secret while
 * nobody can reach production unaware that verification is off.
 */
export function verifyWebhookSignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined
): boolean {
  const secret = process.env.ELEVENLABS_WEBHOOK_SECRET;
  if (!secret || secret.trim() === '') {
    console.warn(
      '[voice] WEBHOOK VERIFICATION DISABLED: ELEVENLABS_WEBHOOK_SECRET is not set, ' +
        'so every inbound webhook is accepted unverified. Do not run this way in production.'
    );
    return true;
  }

  if (!signatureHeader) {
    console.warn('[voice] Rejected webhook: no elevenlabs-signature header.');
    return false;
  }

  const parts = signatureHeader.split(',').map((p) => p.trim());
  const timestamp = parts.find((p) => p.startsWith('t='))?.slice(2);
  const provided = parts.find((p) => p.startsWith('v0='))?.slice(3);
  if (!timestamp || !provided) {
    console.warn('[voice] Rejected webhook: signature header missing t= or v0= component.');
    return false;
  }

  const tsMs = Number(timestamp) * 1000;
  if (!Number.isFinite(tsMs) || Date.now() - tsMs > SIGNATURE_TOLERANCE_MS) {
    console.warn('[voice] Rejected webhook: signature timestamp is stale or unparseable (replay guard).');
    return false;
  }

  const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

  // timingSafeEqual throws on length mismatch, so length-check first.
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) {
    console.warn('[voice] Rejected webhook: signature length mismatch.');
    return false;
  }
  if (!crypto.timingSafeEqual(a, b)) {
    console.warn('[voice] Rejected webhook: signature does not match.');
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Webhook payload parsing
// ---------------------------------------------------------------------------

export interface ParsedCallWebhook {
  conversationId: string;
  /** e.g. post_call_transcription | call_initiation_failure | call_started. */
  eventType: string;
  status?: string;
  transcript?: ChatMessage[];
  summary?: string;
  callDurationSecs?: number;
  terminationReason?: string;
  hasUserAudio?: boolean;
  /** Stable dedupe key -- safe to SETNX on. */
  eventId: string;
}

/** Truncated debug dump so a human can correct an unrecognized shape. */
function debugBody(label: string, body: unknown): void {
  let dump: string;
  try {
    dump = JSON.stringify(body);
  } catch {
    dump = String(body);
  }
  console.debug(`[voice] ${label}: ${dump?.slice(0, 500)}${dump && dump.length > 500 ? '...' : ''}`);
}

/**
 * Collapse the call-started / transcript / post-call callback payloads into one
 * shape, or null if the body is unrecognizable.
 *
 * Confirmed from the docs: post-call webhooks are
 * `{ type, event_timestamp, data }` where `type` is one of
 * post_call_transcription | post_call_audio | call_initiation_failure, and
 * `data` carries conversation_id / agent_id / status / transcript[] /
 * analysis.transcript_summary. The SDK ships no type for this body
 * (constructEvent returns `any`), so field locations are read defensively via
 * optional chaining across the plausible spots -- snake_case (raw webhook JSON)
 * and camelCase (in case a caller hands us an SDK-shaped object), nested under
 * `data` or flat at the top level.
 */
export function parseCallWebhook(body: unknown): ParsedCallWebhook | null {
  if (!body || typeof body !== 'object') {
    debugBody('Unparseable webhook body (not an object)', body);
    return null;
  }

  const b = body as any;
  const data = b.data && typeof b.data === 'object' ? b.data : b;

  const conversationId: unknown =
    data.conversation_id ?? data.conversationId ?? b.conversation_id ?? b.conversationId;
  if (typeof conversationId !== 'string' || conversationId === '') {
    debugBody('Unrecognized webhook body (no conversation id)', body);
    return null;
  }

  const eventType: string =
    b.type ?? b.event_type ?? b.eventType ?? data.type ?? data.event_type ?? 'unknown';

  // call_initiation_failure carries no `status`, only a failure_reason -- surface
  // it as a failed status so the orchestrator has one field to branch on.
  const failureReason: string | undefined = data.failure_reason ?? data.failureReason;
  const rawStatus: unknown = data.status ?? data.call_status ?? data.callStatus;
  const status: string | undefined =
    typeof rawStatus === 'string' ? rawStatus : failureReason ? 'failed' : undefined;

  const agentName: string =
    data.agent_name ?? data.agentName ?? b.agent_name ?? DEFAULT_AGENT_NAME;
  const turns = data.transcript ?? data.transcript_turns ?? data.messages;
  const transcript = toChatMessages(turns, {
    agent: agentName,
    recipient: DEFAULT_RECIPIENT_NAME,
  });

  const summary: string | undefined =
    data.analysis?.transcript_summary ??
    data.analysis?.transcriptSummary ??
    data.transcript_summary ??
    data.summary ??
    failureReason;

  const metadata = data.metadata && typeof data.metadata === 'object' ? data.metadata : {};
  const rawDuration = metadata.call_duration_secs ?? metadata.callDurationSecs ?? data.call_duration_secs;
  const callDurationSecs = typeof rawDuration === 'number' && Number.isFinite(rawDuration) ? rawDuration : undefined;
  const rawTerm = metadata.termination_reason ?? metadata.terminationReason ?? data.termination_reason;
  const terminationReason = typeof rawTerm === 'string' && rawTerm.trim() !== '' ? rawTerm : undefined;
  const hasUserAudio =
    typeof data.has_user_audio === 'boolean'
      ? data.has_user_audio
      : typeof data.hasUserAudio === 'boolean'
        ? data.hasUserAudio
        : undefined;

  // Prefer a provider-supplied event id -- it is the only value guaranteed
  // stable across ElevenLabs' own retries of the same delivery. Only when none
  // is present do we derive one, and the derivation must stay deterministic
  // (no Date.now()) or retries would each look like a new event.
  const providedId: unknown = b.event_id ?? b.eventId ?? data.event_id ?? data.eventId;
  let eventId: string;
  if (typeof providedId === 'string' && providedId !== '') {
    eventId = providedId;
  } else {
    const ts =
      b.event_timestamp ??
      b.eventTimestamp ??
      data.event_timestamp ??
      data.metadata?.start_time_unix_secs ??
      data.metadata?.startTimeUnixSecs ??
      '';
    eventId = `${conversationId}:${eventType}:${crypto
      .createHash('sha256')
      .update(`${conversationId}|${eventType}|${ts}`)
      .digest('hex')
      .slice(0, 12)}`;
  }

  return {
    conversationId,
    eventType,
    ...(status ? { status } : {}),
    ...(transcript.length ? { transcript } : {}),
    ...(summary ? { summary } : {}),
    ...(callDurationSecs !== undefined ? { callDurationSecs } : {}),
    ...(terminationReason ? { terminationReason } : {}),
    ...(hasUserAudio !== undefined ? { hasUserAudio } : {}),
    eventId,
  };
}

/**
 * Whether a parsed call webhook should unblock the claim walk.
 *
 * Conquer parks on a call until the conversation is actually done. Missed /
 * no-answer / initiation-failure events still produce ElevenLabs post-call
 * webhooks; treating those as success dialed the next timeline step while the
 * first call was still ringing in the user's mind. Only a finished
 * transcription that includes at least one recipient turn advances the claim.
 * Force-advance remains the escape hatch for demos.
 */
export function isCallCompleteForProgression(parsed: ParsedCallWebhook): {
  complete: boolean;
  reason: string;
} {
  const type = (parsed.eventType || '').toLowerCase();

  if (type.includes('call_started')) {
    return { complete: false, reason: 'call still in progress (call_started)' };
  }
  if (type.includes('initiation_failure')) {
    return {
      complete: false,
      reason: 'call initiation failed; keeping claim parked on this contact',
    };
  }
  if (type.includes('post_call_audio')) {
    return {
      complete: false,
      reason: 'audio-only webhook; waiting for post_call_transcription',
    };
  }

  const status = (parsed.status || '').toLowerCase();
  if (status === 'failed' || status === 'error') {
    return {
      complete: false,
      reason: `call status "${parsed.status}"; keeping claim parked`,
    };
  }

  // ElevenLabs often posts an empty transcript plus
  // "Summary couldn't be generated" on missed/no-answer — and also on a
  // hangup before analysis finishes. Do not treat that placeholder as a
  // completed contact by itself; require recipient speech or a connected hangup.
  const uselessSummary = /summary couldn't be generated/i;

  const recipientTurns = (parsed.transcript || []).filter(
    m =>
      m.sender === 'recipient' &&
      typeof m.text === 'string' &&
      m.text.trim() !== '' &&
      !uselessSummary.test(m.text)
  );
  if (recipientTurns.length > 0) {
    return { complete: true, reason: 'recipient spoke; call complete for progression' };
  }

  // A connected call that then hangs up is done — even if the recipient said
  // little or the transcript is still empty. Missed/no-answer stays parked.
  const duration = parsed.callDurationSecs ?? 0;
  const term = (parsed.terminationReason || '').toLowerCase();
  const hungUp = /hangup|hang_up|disconnect|end_call|ended|inactivity|max_duration/.test(term);
  const connected =
    duration >= 3 ||
    parsed.hasUserAudio === true ||
    (parsed.transcript || []).length > 0 ||
    hungUp;
  const finished =
    status === 'done' ||
    status === 'completed' ||
    type.includes('post_call_transcription') ||
    hungUp;

  if (finished && connected) {
    return {
      complete: true,
      reason: 'call finished after connect (disconnect); advancing',
    };
  }

  return {
    complete: false,
    reason:
      'call ended with no recipient speech (missed/no-answer); keeping claim parked until a completed conversation or force-advance',
  };
}

/** Fill in transcript/duration from the Conversations API when a webhook is thin. */
export async function hydrateCallWebhook(parsed: ParsedCallWebhook): Promise<ParsedCallWebhook> {
  if ((parsed.transcript && parsed.transcript.length > 0) && parsed.callDurationSecs !== undefined) {
    return parsed;
  }
  const fetched = await getConversation(parsed.conversationId);
  if (!fetched.ok) return parsed;
  return {
    ...parsed,
    status: parsed.status ?? fetched.status,
    transcript: parsed.transcript?.length ? parsed.transcript : fetched.transcript,
    summary: parsed.summary ?? fetched.summary,
    callDurationSecs: parsed.callDurationSecs ?? fetched.callDurationSecs,
    terminationReason: parsed.terminationReason ?? fetched.terminationReason,
    hasUserAudio: parsed.hasUserAudio ?? fetched.hasUserAudio,
  };
}
