/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * End-to-end harness for the long-horizon claim flow.
 *
 * Black-box HTTP client against an ALREADY-RUNNING server — it deliberately does
 * not import the app or start a listener, so what it exercises is the real wire
 * contract (routes, payload parsing, Redis reverse index, dedupe) rather than
 * in-process functions.
 *
 *   npx tsx scripts/e2e-horizon.ts [templateKey]
 *   E2E_BASE_URL=http://localhost:3000 (default)
 *
 * Design note: this harness is meant to FAIL loudly. Every assertion prints
 * expected vs actual, a failure dumps the claim state that caused it, and the
 * exit code is non-zero unless every single assertion passed. A non-2xx or
 * unparseable response is a failed assertion — never a crash and never a skip.
 *
 * No vendor credentials are needed: all outbound sends are mocked by the channel
 * adapters, and the inbound webhooks here are synthesized locally. Nothing this
 * script does can dial a phone or send a message.
 */

import crypto from 'crypto';

const BASE = (process.env.E2E_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const TEMPLATE_KEY = process.argv[2] ?? 'marcus_vance';

/** Enough for 4 stages of sub-steps plus webhook round-trips, with room to spare. */
const MAX_ITERATIONS = 60;
/** Identical observable state this many times in a row means the claim is stuck. */
const STALL_LIMIT = 3;

const EL_TRANSCRIPT_PATH = '/webhooks/elevenlabs/transcript';
const EL_CALLBACK_PATH = '/webhooks/elevenlabs/callback';
const SENDBLUE_INBOUND_PATH = '/webhooks/sendblue/inbound';

// ---------------------------------------------------------------------------
// Result tracking
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures: string[] = [];
/** Things that could not be checked at all — reported separately from failures. */
const notes: string[] = [];

function pass(what: string): void {
  passed++;
  console.log(`PASS  ${what}`);
}

/** A failure always carries expected vs actual, and optionally the state that caused it. */
function fail(what: string, expected: unknown, actual: unknown, dump?: unknown): void {
  failed++;
  failures.push(what);
  console.log(`FAIL  ${what}`);
  console.log(`        expected: ${fmt(expected)}`);
  console.log(`        actual:   ${fmt(actual)}`);
  if (dump !== undefined) {
    console.log(`        state:    ${fmt(dump)}`);
  }
}

function check(what: string, ok: boolean, expected: unknown, actual: unknown, dump?: unknown): boolean {
  if (ok) {
    pass(what);
    return true;
  }
  fail(what, expected, actual, dump);
  return false;
}

function note(msg: string): void {
  notes.push(msg);
  console.log(`NOTE  ${msg}`);
}

function fmt(v: unknown, max = 900): string {
  let s: string;
  if (typeof v === 'string') s = v;
  else {
    try {
      s = JSON.stringify(v);
    } catch {
      s = String(v);
    }
  }
  s = s ?? 'undefined';
  return s.length > max ? `${s.slice(0, max)}… (${s.length} chars)` : s;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

interface Res {
  status: number;
  ok: boolean;
  /** Parsed JSON when possible, otherwise the raw text. */
  body: any;
  /** Raw text, always populated, for error reporting. */
  text: string;
  /** Set only when the request never completed (connection refused, timeout). */
  networkError?: string;
}

async function req(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<Res> {
  const url = `${BASE}${path}`;
  // Send a pre-serialized string so webhook signatures are computed over the
  // exact bytes the server will read.
  const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: payload,
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    let parsed: any = text;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        /* leave as text; callers report it verbatim */
      }
    }
    return { status: res.status, ok: res.ok, body: parsed, text };
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    return { status: 0, ok: false, body: null, text: '', networkError: `${method} ${url}: ${msg}` };
  }
}

/** One-line description of a response, for expected/actual output. */
function resDesc(r: Res): string {
  if (r.networkError) return `network error (${r.networkError})`;
  return `HTTP ${r.status} ${fmt(r.text || '(empty body)', 300)}`;
}

// ---------------------------------------------------------------------------
// Claim state helpers
// ---------------------------------------------------------------------------

interface AwaitingContact {
  claimId: string;
  stepIndex: number;
  subStepId: string;
  channel: 'sms' | 'call' | 'email';
  lookupKey: string;
  sentAt: string;
  attempt: number;
}

interface ActiveState {
  claim: any | null;
  awaiting: AwaitingContact | null;
  vendorStatus?: unknown;
  raw: Res;
}

async function getActive(): Promise<ActiveState> {
  const r = await req('GET', '/api/claims/active');
  if (!r.ok || typeof r.body !== 'object' || r.body === null) {
    return { claim: null, awaiting: null, raw: r };
  }
  return {
    claim: r.body.claim ?? null,
    awaiting: (r.body.awaiting ?? null) as AwaitingContact | null,
    vendorStatus: r.body.vendorStatus,
    raw: r,
  };
}

/**
 * Compact but diagnostic claim summary. Full claim JSON is far too big to print
 * on every failure, and the fields that matter for this flow are all here.
 */
function summarize(claim: any, awaiting?: AwaitingContact | null): unknown {
  if (!claim) return { claim: null, awaiting: awaiting ?? null };
  return {
    id: claim.id,
    status: claim.status,
    currentStepIndex: claim.currentStepIndex,
    version: claim.version,
    hasResolutionCheck: Boolean(claim.resolutionCheck),
    resolutionAmount: claim.resolutionCheck?.amount,
    steps: (claim.timeline ?? []).map((s: any) => ({
      id: s.id,
      status: s.status,
      subs: (s.subSteps ?? []).map((b: any) => `${b.id}:${b.type}:${b.contactStatus ?? '-'}`),
    })),
    awaiting: awaiting ?? undefined,
  };
}

/**
 * Observable-progress signature. If this is identical across STALL_LIMIT
 * consecutive polls the claim is not advancing and the loop must bail rather
 * than spin to MAX_ITERATIONS.
 */
function progressSignature(claim: any, awaiting: AwaitingContact | null): string {
  if (!claim) return 'no-claim';
  const subs = (claim.timeline ?? [])
    .map((s: any) => `${s.status}[${(s.subSteps ?? []).map((b: any) => b.contactStatus ?? '-').join(',')}]`)
    .join('|');
  return [
    claim.status,
    claim.currentStepIndex,
    claim.version,
    subs,
    awaiting ? `${awaiting.subStepId}@${awaiting.attempt}` : 'none',
  ].join('#');
}

/**
 * Recover the provider-facing lookup VALUE from `awaiting.lookupKey`.
 *
 * Easy to get wrong: `AwaitingContact.lookupKey` holds the fully-qualified Redis
 * key (`claims:lookup:{channel}:{value}`), but a webhook carries only the bare
 * value — the server re-applies the prefix via `lookupKeyFor()`. Echoing the key
 * back verbatim produces a double-prefixed lookup that matches nothing, and the
 * only symptom is a silent `applied: false`.
 *
 * Returns null on prefix drift so the caller can fail with a clear message
 * rather than silently sending garbage.
 */
function lookupValueOf(awaiting: AwaitingContact): string | null {
  const prefix = `claims:lookup:${awaiting.channel}:`;
  if (!awaiting.lookupKey.startsWith(prefix)) return null;
  const value = awaiting.lookupKey.slice(prefix.length);
  return value || null;
}

/** Report which top-level claim fields changed, for the dedupe assertion. */
function diffClaims(before: any, after: any): string[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const changed: string[] = [];
  for (const k of keys) {
    if (JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k])) changed.push(k);
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Webhook synthesis
// ---------------------------------------------------------------------------

/**
 * Bodies are cached per sub-step so a "replay" is byte-identical to the original
 * delivery. Both adapters derive their dedupe key from body content when the
 * provider supplies no event id, so re-sending the same bytes is exactly what a
 * provider retry looks like.
 */
const deliveredBodies = new Map<string, { path: string; body: string }>();

function sendblueInboundBody(lookupKey: string, text: string, dateSent: string): Record<string, unknown> {
  // Shape per sendblue.ts parseInboundWebhook: from_number + content required.
  return {
    from_number: lookupKey,
    content: text,
    is_outbound: false,
    status: 'RECEIVED',
    service: 'iMessage',
    date_sent: dateSent,
    number: process.env.SENDBLUE_NUMBER ?? '+15550000000',
  };
}

function elevenLabsTranscriptBody(
  lookupKey: string,
  eventTimestamp: number
): Record<string, unknown> {
  // Shape per elevenlabs.ts parseCallWebhook / the post-call webhook docs:
  // { type, event_timestamp, data:{ conversation_id, status, transcript[], analysis } }
  return {
    type: 'post_call_transcription',
    event_timestamp: eventTimestamp,
    data: {
      agent_id: 'agent_e2e',
      agent_name: 'Conquer Agent',
      conversation_id: lookupKey,
      status: 'done',
      transcript: [
        { role: 'agent', message: 'Calling about your open claim — can you confirm the details?', time_in_call_secs: 0 },
        { role: 'user', message: 'Yes, that all matches. Go ahead and proceed.', time_in_call_secs: 6 },
      ],
      analysis: {
        call_successful: 'success',
        transcript_summary: 'Recipient confirmed the details and authorized the agent to proceed.',
      },
      metadata: { start_time_unix_secs: eventTimestamp - 60, call_duration_secs: 60 },
    },
  };
}

/**
 * Sign with the same scheme elevenlabs.ts verifies (confirmed against the SDK's
 * own constructEvent): `t=<unix_secs>,v0=<hmac_sha256_hex>` over
 * `<timestamp>.<rawBody>`. Signing whenever a secret is configured means the
 * harness works both with and without verification enabled.
 */
const WEBHOOK_SECRET = process.env.ELEVENLABS_WEBHOOK_SECRET;

function signatureHeaders(rawBody: string): Record<string, string> {
  if (!WEBHOOK_SECRET) return {};
  const t = Math.floor(Date.now() / 1000);
  const v0 = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${rawBody}`).digest('hex');
  return { 'elevenlabs-signature': `t=${t},v0=${v0}` };
}

/**
 * Which ElevenLabs route accepts a post-call body. Probed once rather than
 * assumed, because the transcript and callback routes are separate and either
 * could be the one that resolves an awaiting sub-step.
 */
let callWebhookPath: string | null = null;

async function postCallWebhook(rawBody: string): Promise<{ res: Res; path: string }> {
  const candidates = callWebhookPath ? [callWebhookPath] : [EL_TRANSCRIPT_PATH, EL_CALLBACK_PATH];
  let last: Res | null = null;
  for (const path of candidates) {
    const res = await req('POST', path, rawBody, signatureHeaders(rawBody));
    if (res.status !== 404) {
      callWebhookPath = path;
      return { res, path };
    }
    last = res;
  }
  return { res: last!, path: candidates[candidates.length - 1] };
}

/** Deliver the inbound event that should resolve `awaiting`. Returns what was sent. */
async function deliverFor(
  awaiting: AwaitingContact
): Promise<{ res: Res; path: string; rawBody: string } | null> {
  const lookupValue = lookupValueOf(awaiting);
  if (!lookupValue) {
    fail(
      'awaiting.lookupKey matches the documented claims:lookup:{channel}:{value} shape',
      `a key starting with "claims:lookup:${awaiting.channel}:"`,
      awaiting.lookupKey,
      awaiting
    );
    return null;
  }

  if (awaiting.channel === 'sms') {
    const body = sendblueInboundBody(
      lookupValue,
      'Confirmed — thanks for handling this.',
      new Date().toISOString()
    );
    const rawBody = JSON.stringify(body);
    const res = await req('POST', SENDBLUE_INBOUND_PATH, rawBody);
    deliveredBodies.set(awaiting.subStepId, { path: SENDBLUE_INBOUND_PATH, body: rawBody });
    return { res, path: SENDBLUE_INBOUND_PATH, rawBody };
  }

  if (awaiting.channel === 'call') {
    const rawBody = JSON.stringify(elevenLabsTranscriptBody(lookupValue, Math.floor(Date.now() / 1000)));
    const { res, path } = await postCallWebhook(rawBody);
    deliveredBodies.set(awaiting.subStepId, { path, body: rawBody });
    return { res, path, rawBody };
  }

  // No inbound email parser exists in server/channels/email.ts (it is send-only),
  // so an email-channel wait is not resolvable by this harness.
  fail(
    `deliver inbound for channel "${awaiting.channel}"`,
    'a webhook endpoint capable of resolving an email wait',
    'email is send-only — server/channels/email.ts exposes no inbound parser and no /webhooks/email route exists',
    awaiting
  );
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`Conquer long-horizon E2E — base=${BASE} template=${TEMPLATE_KEY}`);
  console.log(
    WEBHOOK_SECRET
      ? 'ELEVENLABS_WEBHOOK_SECRET is set — webhooks will be signed and signature enforcement will be asserted.'
      : 'ELEVENLABS_WEBHOOK_SECRET is NOT set — webhook signature verification is disabled server-side, so it is NOT asserted here.'
  );
  console.log('');

  // --- 0. reachability ------------------------------------------------------
  const ping = await req('GET', '/api/claims/templates');
  if (!check('server is reachable and serving /api/claims/templates', ping.ok, 'HTTP 2xx', resDesc(ping))) {
    return; // nothing downstream can mean anything
  }

  // --- 1. clean slate -------------------------------------------------------
  const flush = await req('POST', '/api/redis/cmd', { command: 'FLUSHALL' });
  check('FLUSHALL accepted', flush.ok, 'HTTP 2xx', resDesc(flush));

  // Read the deductible the server will actually use, rather than assuming 500.
  const dRes = await req('POST', '/api/redis/cmd', { command: 'GET claims:config:deductible' });
  const dRaw = typeof dRes.body?.result === 'string' ? dRes.body.result.trim() : '';
  const deductible = Number.parseInt(dRaw, 10);
  if (!check(
    'claims:config:deductible is readable after flush',
    Number.isFinite(deductible),
    'an integer',
    dRaw === '' ? resDesc(dRes) : dRaw
  )) {
    return;
  }
  console.log(`      deductible in use: ${deductible}`);

  // --- 2. load the template -------------------------------------------------
  const load = await req('POST', '/api/claims/load', { claimKey: TEMPLATE_KEY });
  if (!check(`load template "${TEMPLATE_KEY}"`, load.ok && !!load.body?.claim, 'HTTP 2xx with a claim', resDesc(load))) {
    return;
  }
  const loaded = load.body.claim;
  const claimAmount = Number(loaded.claimAmount);
  check(
    'freshly loaded claim starts un-settled',
    loaded.status !== 'RESOLVED' && !loaded.resolutionCheck,
    'status !== RESOLVED and no resolutionCheck',
    { status: loaded.status, hasResolutionCheck: Boolean(loaded.resolutionCheck) },
    summarize(loaded)
  );

  // --- 3. approval gate must be CLOSED mid-timeline -------------------------
  // Run this before any stepping: the claim is at the very start, so an approval
  // that succeeds here means the gate is not gating anything.
  {
    const early = await req('POST', '/api/claims/approve-payout');
    if (early.status === 404) {
      fail(
        'approval gate rejects approval mid-timeline',
        'POST /api/claims/approve-payout to exist',
        'HTTP 404 — route is not wired yet, so the approval gate cannot be tested'
      );
    } else {
      check(
        'approval gate rejects approval mid-timeline',
        !early.ok,
        'non-2xx rejection',
        resDesc(early)
      );
      const after = await getActive();
      check(
        'early approval left no resolutionCheck behind',
        !after.claim?.resolutionCheck,
        'no resolutionCheck',
        { hasResolutionCheck: Boolean(after.claim?.resolutionCheck), amount: after.claim?.resolutionCheck?.amount },
        summarize(after.claim, after.awaiting)
      );
      check(
        'early approval did not settle the claim',
        after.claim?.status !== 'RESOLVED',
        'status !== RESOLVED',
        after.claim?.status,
        summarize(after.claim, after.awaiting)
      );
    }
  }

  // --- 4. drive the timeline event-driven ----------------------------------
  let sawAwaiting = false;
  let ranStaleLookupCheck = false;
  let ranDedupeCheck = false;
  let reachedApproval = false;
  let lastSig = '';
  let stallCount = 0;
  let lastState: ActiveState | null = null;
  let iterations = 0;

  for (; iterations < MAX_ITERATIONS; iterations++) {
    const state = await getActive();
    lastState = state;
    if (!state.raw.ok || !state.claim) {
      fail('GET /api/claims/active returns the active claim', 'HTTP 2xx with a claim', resDesc(state.raw));
      break;
    }

    if (state.claim.status === 'AWAITING_APPROVAL') {
      reachedApproval = true;
      break;
    }

    const sig = progressSignature(state.claim, state.awaiting);
    stallCount = sig === lastSig ? stallCount + 1 : 0;
    lastSig = sig;
    if (stallCount >= STALL_LIMIT) {
      fail(
        'claim keeps making progress toward AWAITING_APPROVAL',
        'state to change between polls',
        `identical state ${stallCount + 1} polls in a row (stalled at iteration ${iterations})`,
        summarize(state.claim, state.awaiting)
      );
      break;
    }

    if (state.awaiting) {
      sawAwaiting = true;
      const awaiting = state.awaiting;

      // 4a. A lookup value that matches nothing must be a harmless no-op.
      //     Run once, on the first wait we encounter.
      if (!ranStaleLookupCheck) {
        ranStaleLookupCheck = true;
        const before = state.claim;
        let stale: Res;
        let stalePath: string;
        if (awaiting.channel === 'call') {
          const raw = JSON.stringify(
            elevenLabsTranscriptBody('conv_e2e_does_not_exist', Math.floor(Date.now() / 1000))
          );
          const r = await postCallWebhook(raw);
          stale = r.res;
          stalePath = r.path;
        } else {
          stalePath = SENDBLUE_INBOUND_PATH;
          stale = await req(
            'POST',
            stalePath,
            sendblueInboundBody('+15550009999', 'reply from a number nobody is waiting on', new Date().toISOString())
          );
        }
        check(
          `unmatched lookup value on ${stalePath} does not 5xx`,
          stale.status !== 0 && stale.status < 500,
          'status < 500',
          resDesc(stale)
        );
        // The webhook routes report whether the event actually mutated a claim.
        check(
          'unmatched lookup value reported applied=false',
          stale.body?.applied === false,
          '{ applied: false }',
          fmt(stale.body, 200)
        );
        const afterStale = await getActive();
        check(
          'unmatched lookup value did not advance the claim',
          progressSignature(afterStale.claim, afterStale.awaiting) === progressSignature(before, awaiting),
          progressSignature(before, awaiting),
          progressSignature(afterStale.claim, afterStale.awaiting),
          summarize(afterStale.claim, afterStale.awaiting)
        );
      }

      // 4b. The real inbound event.
      const before = await getActive();
      const delivered = await deliverFor(awaiting);
      if (!delivered) break;
      if (delivered.res.status === 404) {
        fail(
          `webhook route ${delivered.path} exists`,
          'a wired webhook route',
          'HTTP 404 — route is not implemented yet, so the event-driven flow cannot be driven',
          awaiting
        );
        break;
      }
      check(
        `${awaiting.channel} webhook accepted at ${delivered.path} (sub-step ${awaiting.subStepId})`,
        delivered.res.ok,
        'HTTP 2xx',
        resDesc(delivered.res)
      );
      check(
        `${awaiting.channel} webhook reported applied=true (matched the reverse index)`,
        delivered.res.body?.applied === true,
        '{ applied: true }',
        fmt(delivered.res.body, 200),
        awaiting
      );

      const afterDeliver = await getActive();
      const advanced =
        progressSignature(afterDeliver.claim, afterDeliver.awaiting) !==
        progressSignature(before.claim, before.awaiting);
      check(
        `inbound ${awaiting.channel} event resolved the wait on ${awaiting.subStepId}`,
        advanced,
        'claim state to advance',
        'claim state unchanged after a matching webhook',
        summarize(afterDeliver.claim, afterDeliver.awaiting)
      );

      // 4c. Dedupe: replay the same delivery verbatim. Run once, on the first
      //     successfully-delivered event.
      if (advanced && !ranDedupeCheck) {
        ranDedupeCheck = true;
        const replayBefore = afterDeliver.claim;
        const replay = await req(
          'POST',
          delivered.path,
          delivered.rawBody,
          delivered.path === SENDBLUE_INBOUND_PATH ? {} : signatureHeaders(delivered.rawBody)
        );
        check(
          `replayed webhook does not 5xx (${delivered.path})`,
          replay.status !== 0 && replay.status < 500,
          'status < 500',
          resDesc(replay)
        );
        check(
          'replayed webhook reported applied=false (deduped)',
          replay.body?.applied === false,
          '{ applied: false }',
          fmt(replay.body, 200)
        );
        const replayAfter = await getActive();
        // Full-state comparison, not just currentStepIndex: a duplicate that
        // re-appends a chatLog or bumps `version` is still a dedupe bug.
        const changed = diffClaims(replayBefore, replayAfter.claim);
        check(
          'replayed webhook (same event id) did not advance the claim',
          changed.length === 0,
          'no change to any claim field',
          changed.length ? `fields changed: ${changed.join(', ')}` : 'no change',
          { before: summarize(replayBefore), after: summarize(replayAfter.claim, replayAfter.awaiting) }
        );
      }
      continue;
    }

    // No outstanding wait: tick the orchestrator forward.
    const step = await req('POST', '/api/claims/process-step');
    if (step.status === 404) {
      fail('POST /api/claims/process-step exists', 'a wired route', 'HTTP 404');
      break;
    }
    if (!step.ok) {
      fail(
        'process-step advances the claim',
        'HTTP 2xx',
        resDesc(step),
        summarize(state.claim, state.awaiting)
      );
      break;
    }
  }

  if (iterations >= MAX_ITERATIONS) {
    fail(
      'timeline completes within the iteration cap',
      `<= ${MAX_ITERATIONS} iterations`,
      `hit the cap of ${MAX_ITERATIONS}`,
      summarize(lastState?.claim, lastState?.awaiting)
    );
  }

  check(
    'at least one outbound contact parked the claim in awaiting_reply',
    sawAwaiting,
    'an `awaiting` contact to appear at least once',
    'never observed a non-null `awaiting` — the flow is not actually event-driven',
    summarize(lastState?.claim, lastState?.awaiting)
  );
  if (!ranStaleLookupCheck) note('unmatched-lookup assertion never ran (no `awaiting` state was reached).');
  if (!ranDedupeCheck) note('webhook dedupe assertion never ran (no webhook was successfully delivered).');

  // --- 5. the approval gate held the money back ----------------------------
  const parked = await getActive();
  check(
    'claim reached AWAITING_APPROVAL',
    reachedApproval && parked.claim?.status === 'AWAITING_APPROVAL',
    'status === AWAITING_APPROVAL',
    parked.claim?.status,
    summarize(parked.claim, parked.awaiting)
  );
  // The point of the gate: the check must not exist before a human approves.
  check(
    'no resolutionCheck exists before approval (money was held back)',
    !parked.claim?.resolutionCheck,
    'no resolutionCheck',
    parked.claim?.resolutionCheck ? `resolutionCheck present (amount=${parked.claim.resolutionCheck.amount})` : 'none',
    summarize(parked.claim, parked.awaiting)
  );

  // --- 6. signature enforcement -------------------------------------------
  // The secret that matters is the one in the SERVER's environment, and nothing over
  // HTTP reports whether it is set. So a bad signature is sent unconditionally and the
  // response is interpreted rather than blindly asserted: 401 proves enforcement,
  // while 200 is the documented fail-open path and cannot be distinguished from
  // "verification is broken" from out here. What IS asserted either way is the part
  // that would be a real vulnerability: a forged event must never mutate claim state.
  {
    const raw = JSON.stringify(elevenLabsTranscriptBody('conv_e2e_bad_signature', Math.floor(Date.now() / 1000)));
    const t = Math.floor(Date.now() / 1000);
    const bad = await req('POST', EL_CALLBACK_PATH, raw, {
      'elevenlabs-signature': `t=${t},v0=${'0'.repeat(64)}`,
    });

    if (bad.status === 401) {
      pass('callback with a bad signature is rejected 401 (verification is enforced)');
    } else if (bad.status === 200) {
      note(
        'signature enforcement NOT proven: a deliberately bad signature got HTTP 200. That is the ' +
          'documented fail-open path for an unset ELEVENLABS_WEBHOOK_SECRET *in the server process* ' +
          '(setting it only for this script proves nothing). To actually cover this, restart the ' +
          'server with ELEVENLABS_WEBHOOK_SECRET set, then re-run.'
      );
    } else {
      fail(
        'callback with a bad signature is handled',
        'HTTP 401 (enforced) or HTTP 200 (documented fail-open)',
        resDesc(bad)
      );
    }

    // True regardless of how the secret is configured.
    check(
      'forged-signature event did not mutate claim state',
      bad.body?.applied !== true,
      'applied !== true',
      fmt(bad.body, 200)
    );
    const afterForged = await getActive();
    check(
      'forged-signature event left the claim parked in AWAITING_APPROVAL',
      afterForged.claim?.status === 'AWAITING_APPROVAL' && !afterForged.claim?.resolutionCheck,
      'AWAITING_APPROVAL with no resolutionCheck',
      { status: afterForged.claim?.status, hasResolutionCheck: Boolean(afterForged.claim?.resolutionCheck) },
      summarize(afterForged.claim, afterForged.awaiting)
    );
  }

  // --- 7. approve and verify the payout math ------------------------------
  const approve = await req('POST', '/api/claims/approve-payout');
  let approvalSucceeded = false;
  if (approve.status === 404) {
    fail('POST /api/claims/approve-payout exists', 'a wired route', 'HTTP 404 — route is not implemented yet');
  } else {
    approvalSucceeded = check(
      'approve-payout accepted once parked in AWAITING_APPROVAL',
      approve.ok,
      'HTTP 2xx',
      resDesc(approve)
    );
  }

  // Only assert the settlement if the approval call itself worked. Asserting on
  // whatever state happens to be lying around would let a claim that was ALREADY
  // settled (e.g. by a legacy auto-settling process-step) satisfy "RESOLVED with
  // a correct payout" and paint the run green while the approval gate is broken.
  if (!approvalSucceeded) {
    fail(
      'settlement is verifiable',
      'approve-payout to succeed so the resulting settlement can be checked',
      'approval did not succeed — RESOLVED / resolutionCheck / payout-math assertions were NOT evaluated, ' +
        'because pre-existing state must not be allowed to satisfy them',
      summarize((await getActive()).claim)
    );
    return;
  }

  const settled = await getActive();
  check(
    'claim is RESOLVED after approval',
    settled.claim?.status === 'RESOLVED',
    'RESOLVED',
    settled.claim?.status,
    summarize(settled.claim, settled.awaiting)
  );
  const rc = settled.claim?.resolutionCheck;
  if (check(
    'resolutionCheck exists after approval',
    !!rc,
    'a resolutionCheck object',
    rc ? 'present' : 'missing',
    summarize(settled.claim, settled.awaiting)
  )) {
    const expectedAmount = claimAmount - deductible;
    check(
      `payout equals claimAmount - deductible (${claimAmount} - ${deductible})`,
      Number(rc.amount) === expectedAmount,
      expectedAmount,
      rc.amount,
      { resolutionCheck: rc }
    );
  }
}

// A thrown exception is a harness failure, reported as one — never a silent exit 0.
main()
  .catch((err) => {
    failed++;
    failures.push('harness completed without throwing');
    console.log('FAIL  harness completed without throwing');
    console.log(`        expected: no exception`);
    console.log(`        actual:   ${err?.stack ?? err?.message ?? String(err)}`);
  })
  .finally(() => {
    console.log('');
    console.log(`${passed} passed, ${failed} failed${notes.length ? `, ${notes.length} not covered` : ''}`);
    if (failures.length) {
      console.log('Failed assertions:');
      for (const f of failures) console.log(`  - ${f}`);
    }
    if (notes.length) {
      console.log('Not covered:');
      for (const n of notes) console.log(`  - ${n}`);
    }
    process.exit(failed === 0 ? 0 : 1);
  });
