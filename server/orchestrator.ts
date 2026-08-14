/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Long-horizon claim orchestrator.
 *
 * The old `POST /api/claims/process-step` did an entire timeline stage per click:
 * synthesize the dialogue with the model, mark the stage complete, and (on the last
 * stage) cut the settlement check. That is a simulation. This module pulls those two
 * halves apart into a real agent loop:
 *
 *   advanceClaim()            walk sub-steps until an outbound contact fires, then STOP
 *   resolveAwaitingSubStep()  a webhook delivers the reply, so resume the walk
 *   finalizeClaim()           a human approved the payout, so move the money
 *
 * Scope is deliberately ONE active claim with ONE outstanding contact at a time, so
 * `claims:active` / `claims:awaiting` are singletons rather than per-claim namespaces.
 *
 * State-store keys owned here:
 *   claims:active                        the in-flight claim (hash / JSON envelope)
 *   claims:awaiting                      AwaitingContact, or absent when not waiting
 *   claims:lookup:sms:{e164}             -> claimId   (48h TTL)
 *   claims:lookup:call:{conversationId}  -> claimId   (48h TTL)
 *   claims:lookup:email:{threadId}       -> claimId   (48h TTL)
 *   claims:payout_amount, claims:status  written by finalizeClaim, as before
 *   claims:session:{sessionId}           full interaction archive (via sessions.ts)
 *   claims:sessions                      JSON index of recent session ids
 * plus the mutex `claims:lock:{claimId}` via store.withLock (which stores it under
 * its own `__mutex__:` prefix).
 */

import { generateJson, isLlmConfigured, modelName, strictObject, nullable, str, num } from './llm.js';
import { AwaitingContact, ChatMessage, Claim, ReplySource, SubStep, TimelineStep, VendorStatus } from '../src/types.js';
import { store } from './mongo.js';
import * as smsChannel from './channels/sendblue.js';
import * as emailChannel from './channels/email.js';
import * as voiceChannel from './channels/elevenlabs.js';
import { beginSession, saveSessionSnapshot } from './sessions.js';
import { memoryBlock, memoryVariable, recall, remember, type RecalledMemory } from './memory.js';
import { saveCheckpoint, type CheckpointReason } from './checkpoints.js';

const ACTIVE_KEY = 'claims:active';
const AWAITING_KEY = 'claims:awaiting';

/** Long enough that a policyholder can reply the next day and still be matched. */
const LOOKUP_TTL_SECONDS = 48 * 60 * 60;

/** The walk is bounded so a malformed timeline can never spin forever. */
const MAX_WALK_ITERATIONS = 500;

export type Channel = 'sms' | 'call' | 'email';

// ---------------------------------------------------------------------------
// Keys and locking
// ---------------------------------------------------------------------------

/** Mutex name for a claim. store.withLock stores it under `__mutex__:` + this. */
export function claimLockName(claimId: string): string {
  return `claims:lock:${claimId}`;
}

/**
 * Serialize a read-modify-write on one claim. `server.ts` should wrap its
 * process-step / force-advance routes in this for the same reason the webhook path
 * does: two callers must not both advance (and both send) the same claim.
 * Resolves to null without running `fn` when the lock is already held.
 */
export function withClaimLock<T>(claimId: string, fn: () => Promise<T>, ttlMs = 15000): Promise<T | null> {
  return store.withLock(claimLockName(claimId), fn, ttlMs);
}

/**
 * Marks a lookup value as locally invented rather than provider-issued -- used for mock
 * sends, failed sends, and "no recipient configured". Deliberately not phone-shaped so it
 * is obvious in the dashboard that nothing was really dialled.
 */
const SYNTHETIC_PREFIX = 'local:';

/**
 * A synthetic stand-in for a provider handle. `#` separates the two ids because neither a
 * claim id nor a sub-step id contains one, which keeps claim/sub-step -> value injective:
 * without a reserved separator, ("claim:1002", "sub_2_3") and ("claim:1002:sub", "2_3")
 * would produce the same string and share one reverse-index entry.
 */
export function syntheticLookupValue(claimId: string, subStepId: string): string {
  return `${SYNTHETIC_PREFIX}${claimId}#${subStepId}`;
}

export function isSyntheticLookupValue(value: string): boolean {
  return value.startsWith(SYNTHETIC_PREFIX);
}

/**
 * Recover the raw lookup value from a stored key. Strips the known prefix rather than
 * splitting on ':' -- a conversation id or a synthetic sentinel legitimately contains
 * colons. Inverse of `lookupKeyFor` for any value it passes through untouched.
 */
export function lookupValueFromKey(channel: Channel, key: string): string {
  const prefix = `claims:lookup:${channel}:`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

/** True when a stored key was indexed under a synthetic sentinel rather than a real handle. */
export function isSyntheticLookupKey(channel: Channel, key: string): boolean {
  return isSyntheticLookupValue(lookupValueFromKey(channel, key));
}

/**
 * Build the reverse-index key. Real SMS values go through `normalizePhone` on BOTH the
 * write and the read side -- the number we dialled and the `from_number` the provider
 * reports back are formatted differently often enough that skipping this silently breaks
 * matching.
 *
 * Synthetic values are passed through untouched. `normalizePhone` strips every non-digit,
 * so feeding it a sentinel turned `local:claim:1002:sub_2_3` into `+100223`: a fake phone
 * number in the dashboard, and worse, distinct claim/sub-step pairs collapsing onto the
 * same key and cross-wiring replies between claims. It hid itself because both sides call
 * this function, so matching still appeared to work.
 */
export function lookupKeyFor(channel: Channel, value: string): string {
  const indexed = channel === 'sms' && !isSyntheticLookupValue(value) ? smsChannel.normalizePhone(value) : value;
  return `claims:lookup:${channel}:${indexed}`;
}

// ---------------------------------------------------------------------------
// Sub-step classification and recipients
// ---------------------------------------------------------------------------

/**
 * Which outbound channel (if any) a sub-step represents. Internal sub-step types
 * (horizon / api / tool / outcome) return null and resolve immediately.
 *
 * `SubStepType` has no 'email' member, so an email contact can only be recognized
 * heuristically -- by techType/description. Model-authored timelines use 'custom'
 * for anything off-menu, which is where an email sub-step realistically shows up.
 */
export function classifyChannel(sub: SubStep): Channel | null {
  if (sub.type === 'sms') return 'sms';
  if (sub.type === 'phone') return 'call';
  // Checked after sms/phone so "texts the emailed receipt" cannot misroute.
  const hay = `${sub.techType ?? ''} ${sub.systemName} ${sub.description}`.toLowerCase();
  if (/\be-?mails?\b|\binbox\b|\bmailbox\b/.test(hay)) return 'email';
  return null;
}

/**
 * Outbound email with no inbound webhook path (confirmation / quote / notice).
 * These should send and continue — parking forever would strand the demo.
 */
function isOneWayEmail(sub: SubStep): boolean {
  const hay = `${sub.techType ?? ''} ${sub.systemName} ${sub.description}`.toLowerCase();
  if (!/\be-?mails?\b|\binbox\b|\bmailbox\b/.test(hay)) return false;
  return /\b(confirmation|confirm|quote|estimate|notice|receipt|summary|checklist)\b/.test(hay);
}

/**
 * Who to actually contact. Falls back to the demo env vars, then gives up -- a phone
 * number or address is never invented, because a wrong guess means contacting a
 * stranger. `null` means "log it and treat the contact as mock-sent".
 */
function resolveRecipient(claim: Claim, channel: Channel): string | null {
  if (channel === 'email') {
    const addr = claim.claimantEmail?.trim() || process.env.DEMO_CLAIMANT_EMAIL?.trim();
    return addr && addr.includes('@') ? addr : null;
  }
  const raw = claim.claimantPhone?.trim() || process.env.DEMO_CLAIMANT_PHONE?.trim();
  if (!raw) return null;
  const e164 = smsChannel.normalizePhone(raw);
  return e164 || null;
}

// ---------------------------------------------------------------------------
// Contact copy
// ---------------------------------------------------------------------------

/**
 * Everything needed to contact someone about one sub-step, derived in ONE place so the
 * SMS body, the call's opening line and the email content can never drift apart.
 */
export interface ContactBrief {
  channel: Channel;
  recipientName: string;
  smsBody: string;
  emailSubject: string;
  emailBody: string;
  firstMessage: string;
  contextVars: Record<string, string>;
}

/**
 * The authored `chatLog` that shipped with the claim template is a simulation artifact:
 * its recipient turn is a fake reply we are now getting for real. It is stripped from
 * the claim on dispatch, but stashed here so `synthesizeReply` can fall back to the
 * hand-written line on the force-advance path. Process-local; after a restart
 * force-advance falls back to a generic line instead.
 */
const cannedReplies = new Map<string, ChatMessage>();

function cannedKey(claimId: string, subStepId: string): string {
  return `${claimId}:${subStepId}`;
}

function money(amount: number): string {
  return `$${amount.toLocaleString()}`;
}

function isShopNegotiationSub(sub: SubStep): boolean {
  const role = (sub.systemName || '').toLowerCase();
  const desc = (sub.description || '').toLowerCase();
  return (
    role.includes('shop') ||
    desc.includes('concession') ||
    desc.includes('price correction') ||
    (desc.includes('quote') && (desc.includes('labor') || desc.includes('oem') || desc.includes('negotiation')))
  );
}

function isDynamicSettlementCopy(sub: SubStep): boolean {
  const desc = (sub.description || '').toLowerCase();
  return (
    desc.includes('settlement') ||
    desc.includes('payout breakdown') ||
    desc.includes('final customer confirmation')
  );
}

/** Deterministic copy used when the model is not configured (or its call fails). */
function fallbackBrief(claim: Claim, sub: SubStep, channel: Channel, authored?: string): ContactBrief {
  const recipientName = sub.systemName;
  const gross = money(claim.claimAmount);
  const concessionNote =
    claim.shopConcession && claim.shopConcession > 0
      ? ` Shop concession applied: ${money(claim.shopConcession)}` +
        (claim.initialShopQuote ? ` (from ${money(claim.initialShopQuote)}).` : '.')
      : '';

  if (isDynamicSettlementCopy(sub) && channel === 'email') {
    const subject = `Settlement confirmation — ${gross} repairs (${claim.id})`;
    const body =
      `Hi ${claim.claimantName},\n\n` +
      `Westside repairs are agreed at ${gross}.${concessionNote} ` +
      `Your policy deductible still applies; after adjuster approval we will pay the shop the net amount.\n\n` +
      `Claim: ${claim.id}\n` +
      `Policy: ${claim.policyNumber}\n` +
      `Agreed repair total: ${gross}\n\n` +
      `We will also call you shortly to confirm.\n\n` +
      `— Conquer claims agent`;
    return {
      channel,
      recipientName,
      smsBody: `Settlement ready for ${claim.id}: repairs ${gross}.${concessionNote} We'll call to confirm.`,
      emailSubject: subject,
      emailBody: body,
      firstMessage: `Hi ${claim.claimantName}, Conquer — claim ${claim.id} settlement is ${gross}.${concessionNote} Can you confirm?`,
      contextVars: contextVarsFor(claim, sub),
    };
  }

  if (isDynamicSettlementCopy(sub) && channel === 'call') {
    const line =
      `Hi ${claim.claimantName}, Conquer — claim ${claim.id} repairs are ${gross}.${concessionNote} Confirm that works?`;
    return {
      channel,
      recipientName,
      smsBody: line,
      emailSubject: `${claim.claimType} - claim ${claim.id}`,
      emailBody: line,
      firstMessage: line,
      contextVars: contextVarsFor(claim, sub),
    };
  }

  const line =
    authored ??
    `Regarding ${claim.claimType} claim ${claim.id} for ${claim.claimantName} (policy ${claim.policyNumber}): ` +
      `${sub.description}. Please reply so we can proceed.`;

  return {
    channel,
    recipientName,
    smsBody: line,
    emailSubject: `${claim.claimType} - claim ${claim.id} (${claim.claimantName})`,
    emailBody:
      `Hi ${claim.claimantName},\n\n` +
      `${line}\n\n` +
      `Claim: ${claim.id}\n` +
      `Policyholder: ${claim.claimantName}\n` +
      `Policy: ${claim.policyNumber}\n` +
      `Estimate: ${gross}\n\n` +
      `— Conquer claims agent`,
    firstMessage: line,
    contextVars: contextVarsFor(claim, sub),
  };
}

/** Regex fallback when the model cannot parse the shop's spoken numbers. */
function extractShopQuoteRegex(
  text: string,
  currentAmount: number
): { revisedTotal: number | null; concessionAmount: number | null } {
  const revised = text.match(
    /(?:revised|final|agreed|new)\s+(?:quote|total|estimate|price)[^\d$]{0,24}\$?\s*([\d,]+(?:\.\d{1,2})?)/i
  );
  if (revised) {
    const n = parseFloat(revised[1].replace(/,/g, ''));
    if (Number.isFinite(n) && n > 0) {
      return { revisedTotal: n, concessionAmount: Math.max(0, currentAmount - n) };
    }
  }

  const conc =
    text.match(
      /(?:conced\w*|discount|reduction|reduce[d]?|take|knock)\D{0,24}\$?\s*([\d,]+(?:\.\d{1,2})?)/i
    ) ||
    text.match(/\$?\s*([\d,]+(?:\.\d{1,2})?)\s*(?:dollars?\s+)?(?:off|concession)/i) ||
    text.match(/\b(?:a|one)\s+dollar\b/i);

  if (conc) {
    const c =
      conc[1] != null ? parseFloat(String(conc[1]).replace(/,/g, '')) : 1; // "a dollar"
    if (Number.isFinite(c) && c > 0) {
      return { revisedTotal: Math.max(0, currentAmount - c), concessionAmount: c };
    }
  }

  if (/\bquote\b|\btotal\b|\bestimate\b/i.test(text)) {
    const all = [...text.matchAll(/\$\s*([\d,]+(?:\.\d{1,2})?)/g)].map(m =>
      parseFloat(m[1].replace(/,/g, ''))
    );
    const last = all.filter(n => Number.isFinite(n) && n > 0).pop();
    if (last != null) {
      return { revisedTotal: last, concessionAmount: Math.max(0, currentAmount - last) };
    }
  }

  return { revisedTotal: null, concessionAmount: null };
}

/**
 * Pull the shop's agreed repair total / concession from the live reply so later
 * settlement email + phone use the real negotiated figure (even a $1 change).
 */
async function applyShopNegotiationFromReply(
  claim: Claim,
  sub: SubStep,
  replyText?: string,
  transcript?: ChatMessage[] | null
): Promise<void> {
  if (!isShopNegotiationSub(sub)) return;

  const corpus = replyDigest(sub, replyText, transcript);
  if (!corpus.trim()) return;

  const before = claim.claimAmount;
  if (claim.initialShopQuote == null) claim.initialShopQuote = before;

  let revisedTotal: number | null = null;
  let concessionAmount: number | null = null;

  const drafted = await generateJson<{
    revisedTotal: number | null;
    concessionAmount: number | null;
    summary: string;
  }>({
    label: `shop quote extract for [${sub.systemName}]`,
    schemaName: 'shop_negotiation',
    schema: strictObject({
      revisedTotal: nullable(num),
      concessionAmount: nullable(num),
      summary: str,
    }),
    prompt: `Extract the FINAL agreed repair quote from this shop / body-shop reply about an insurance estimate.
Current estimate on file: ${before} dollars.
Reply text:
"""
${corpus}
"""
Rules:
- revisedTotal = the final dollar total the shop agreed to (after any discount/concession).
- concessionAmount = dollars they took off, if stated (e.g. "$1 off" → 1).
- If they only say a concession (e.g. "take a dollar off") and no new total, set concessionAmount and leave revisedTotal null.
- If they only state a new total, set revisedTotal and concessionAmount null (or the delta if obvious).
- Numbers only; no currency symbols in numeric fields. summary: one short sentence.`,
  });

  if (drafted) {
    revisedTotal = drafted.revisedTotal;
    concessionAmount = drafted.concessionAmount;
  }

  if (revisedTotal == null && concessionAmount == null) {
    const rb = extractShopQuoteRegex(corpus, before);
    revisedTotal = rb.revisedTotal;
    concessionAmount = rb.concessionAmount;
  }

  let next = before;
  if (revisedTotal != null && revisedTotal > 0) {
    next = Math.round(revisedTotal * 100) / 100;
  } else if (concessionAmount != null && concessionAmount > 0) {
    next = Math.max(0, Math.round((before - concessionAmount) * 100) / 100);
  } else {
    store.log('INFO', `Shop reply had no parseable quote/concession — keeping ${money(before)}`);
    return;
  }

  const conceded = Math.round((before - next) * 100) / 100;
  claim.claimAmount = next;
  claim.shopConcession = conceded > 0 ? conceded : concessionAmount ?? 0;

  await store.set('claims:amount', String(claim.claimAmount), 'string', undefined, true);
  await store.set('claims:shop_concession', String(claim.shopConcession ?? 0), 'string', undefined, true);
  await store.set('claims:initial_shop_quote', String(claim.initialShopQuote), 'string', undefined, true);

  const bullet =
    `• [Shop negotiation] Agreed repair total ${money(claim.claimAmount)}` +
    (claim.shopConcession && claim.shopConcession > 0
      ? ` after ${money(claim.shopConcession)} concession from ${money(claim.initialShopQuote ?? before)}`
      : '');
  const prior = (claim.workingMemory ?? '').trim();
  if (!prior.includes(bullet)) {
    claim.workingMemory = prior ? `${prior}\n${bullet}` : bullet;
  }

  store.log(
    'INFO',
    `SHOP_QUOTE_UPDATED: ${money(before)} → ${money(claim.claimAmount)}` +
      (claim.shopConcession ? ` (concession ${money(claim.shopConcession)})` : '')
  );
  await store.publish(
    'claims:pubsub',
    `SHOP_QUOTE:${claim.id}:${claim.claimAmount}:${claim.shopConcession ?? 0}`
  );

  // The single most valuable thing to carry into the NEXT claim: what this counterparty
  // actually agreed to, with the numbers attached rather than paraphrased.
  await remember({
    kind: 'negotiation',
    counterparty: sub.systemName,
    claimType: claim.claimType,
    claimId: claim.id,
    sessionId: claim.sessionId,
    channel: classifyChannel(sub) ?? null,
    text:
      `${sub.systemName} agreed a repair total of ${money(claim.claimAmount)}` +
      (claim.shopConcession && claim.shopConcession > 0
        ? ` after conceding ${money(claim.shopConcession)} from ${money(claim.initialShopQuote ?? before)}.`
        : '.'),
    facts: {
      quoteBefore: claim.initialShopQuote ?? before,
      quoteAfter: claim.claimAmount,
      concession: claim.shopConcession ?? 0,
    },
  });
}

/** One primary ask for the voice agent — keep calls short. */
function collectionGoalsFor(sub: SubStep): string {
  const role = (sub.systemName || '').toLowerCase();
  const desc = (sub.description || '').toLowerCase();

  if (role.includes('payer') && (desc.includes('auth') || desc.includes('evidence') || desc.includes('prior'))) {
    return 'Ask only: is prior auth approved, pending, or denied? If they volunteer missing docs or a case number, note it. Then end.';
  }

  if (role.includes('provider') && desc.includes('evidence')) {
    return 'Ask only: can you submit the requested clinical evidence? Then end.';
  }

  if (
    role.includes('shop') ||
    role.includes('body') ||
    role.includes('repair') ||
    (desc.includes('quote') && (desc.includes('labor') || desc.includes('concession') || desc.includes('oem')))
  ) {
    return 'Ask only: can you revise the estimate to network rate and give the new dollar total? Then end. Do not invent a discount.';
  }

  if (role.includes('claimant') || role.includes('patient') || role.includes('member')) {
    return `Ask only what you need for: ${sub.description}. Then end.`;
  }

  return `Ask one concrete question for: ${sub.description}. Then end.`;
}

/** Template memory for the active step + anything learned from prior contacts. */
function memoryForCall(claim: Claim, step?: TimelineStep): string {
  const parts = [claim.workingMemory?.trim(), step?.agentMemory?.trim()].filter(Boolean);
  return parts.length > 0 ? parts.join('\n') : '';
}

/**
 * Flat string map -- ElevenLabs dynamic variables must be strings.
 *
 * `prior_experience` is what stops the *voice* agent cold-starting too. Without it the call
 * opens from the claim alone and re-negotiates ground already won on a previous claim; with it
 * the agent opens the call already knowing this shop's network labour rate.
 */
function contextVarsFor(
  claim: Claim,
  sub: SubStep,
  recalled: RecalledMemory[] = []
): Record<string, string> {
  const step = claim.timeline[claim.currentStepIndex];
  return {
    claim_id: claim.id,
    claimant_name: claim.claimantName,
    claim_type: claim.claimType,
    claim_amount: money(claim.claimAmount),
    policy_number: claim.policyNumber,
    claim_description: claim.description,
    claim_status: claim.status,
    step_signal: step?.signal ?? '',
    agent_memory: memoryForCall(claim, step),
    recipient_name: sub.systemName,
    purpose: sub.description,
    collection_goals: collectionGoalsFor(sub),
    prior_experience: memoryVariable(recalled),
  };
}

/** Pull a short recipient summary from a reply / transcript for working memory. */
function replyDigest(sub: SubStep, replyText?: string, transcript?: ChatMessage[] | null): string {
  if (transcript && transcript.length > 0) {
    const recipientBits = transcript
      .filter(m => m.sender === 'recipient')
      .map(m => m.text.trim())
      .filter(Boolean);
    if (recipientBits.length > 0) {
      const joined = recipientBits.join(' ').replace(/\s+/g, ' ');
      return joined.length > 280 ? `${joined.slice(0, 277)}…` : joined;
    }
  }
  const text = (replyText ?? '').trim().replace(/\s+/g, ' ');
  if (!text) return `${sub.systemName} responded (${sub.description})`;
  return text.length > 280 ? `${text.slice(0, 277)}…` : text;
}

/**
 * Append what we learned from a contact onto the persisted claim.workingMemory and
 * the current step's agentMemory so the next dial/SMS sees prior context.
 */
function absorbContactIntoMemory(
  claim: Claim,
  step: TimelineStep,
  sub: SubStep,
  replyText?: string,
  transcript?: ChatMessage[] | null
): void {
  const digest = replyDigest(sub, replyText, transcript);
  const bullet = `• [${sub.systemName}] ${digest}`;
  const prior = (claim.workingMemory ?? '').trim();
  // Avoid duplicating the same bullet if a webhook retries after a partial write.
  if (!prior.includes(bullet)) {
    claim.workingMemory = prior ? `${prior}\n${bullet}` : bullet;
  }

  const base = (step.agentMemory || '').split(/\n\nLearned from contacts:/)[0].trim();
  const trail = (claim.workingMemory || '').split('\n').slice(-8).join('\n');
  step.agentMemory = base
    ? `${base}\n\nLearned from contacts:\n${trail}`
    : `Learned from contacts:\n${trail}`;
}

/**
 * Draft channel-appropriate copy for a sub-step. Uses the model when configured, canned
 * text otherwise. The authored agent turn from the claim template is offered to the model
 * as the intended message and used verbatim as the fallback, so the demo keeps its
 * hand-written voice with no API key.
 */
export async function buildContactBrief(claim: Claim, sub: SubStep, channel?: Channel): Promise<ContactBrief> {
  const resolved = channel ?? classifyChannel(sub) ?? 'sms';
  const authored = sub.chatLog?.find(m => m.sender === 'agent')?.text;
  // Settlement / final confirm must use the LIVE negotiated claimAmount — never the
  // template's hardcoded $8,750 email/phone copy.
  const dynamicMoney = isDynamicSettlementCopy(sub);
  const fallback = fallbackBrief(claim, sub, resolved, dynamicMoney ? undefined : authored);

  const step = claim.timeline[claim.currentStepIndex];

  // Long-term memory, retrieved BEFORE the copy is drafted. Scoped to other claims so this
  // is genuinely prior experience rather than the claim quoting itself back.
  const recalled = await recall({
    query: `${sub.systemName} ${sub.description} ${claim.claimType} ${step?.signal ?? ''}`,
    claimType: claim.claimType,
    excludeSessionId: claim.sessionId,
    limit: 4,
  });
  const priorExperience = memoryBlock(recalled);

  const concessionLine =
    claim.shopConcession && claim.shopConcession > 0
      ? `A shop concession of ${claim.shopConcession} dollars was applied` +
        (claim.initialShopQuote ? ` from an initial quote of ${claim.initialShopQuote}.` : '.')
      : 'No shop concession on file yet.';

  const drafted = await generateJson<{
    smsBody: string;
    emailSubject: string;
    emailBody: string;
    firstMessage: string;
  }>({
    label: `contact copy for [${sub.systemName}]`,
    schemaName: 'contact_brief',
    schema: strictObject({ smsBody: str, emailSubject: str, emailBody: str, firstMessage: str }),
    prompt: `You are an AI insurance claim representative contacting someone about a live claim.
The claimant/patient is ${claim.claimantName} (they are NOT necessarily who you are calling).
The claim is a ${claim.claimType}. CURRENT AGREED REPAIR TOTAL: ${claim.claimAmount} dollars (use this exact number — it may have changed after shop negotiation).
${concessionLine}
Incident details: ${claim.description}.
Policy number: ${claim.policyNumber}.
Working memory: "${claim.workingMemory ?? ''}"
${priorExperience}
The current step signal is: "${step?.signal ?? ''}"
Relevant agent memory: "${step?.agentMemory ?? ''}"
You are contacting "${sub.systemName}" over ${resolved.toUpperCase()} in order to: "${sub.description}".
Role rule: address "${sub.systemName}" as that party. Example: if contacting Payer, ask for authorization status; do not ask the payer what evidence Conquer should upload as if they were the patient.
${authored && !dynamicMoney ? `The intended message was drafted as: "${authored}". Stay faithful to its intent, but if dollar amounts differ from CURRENT AGREED REPAIR TOTAL, use the current total.` : ''}
${dynamicMoney ? `CRITICAL: Every dollar figure in emailSubject/emailBody/firstMessage/smsBody MUST use ${claim.claimAmount} as the repair total. Mention any concession if present.` : ''}
Write the OUTBOUND message only - no recipient reply, no small talk.
Be FAST and BRIEF. One ask. Do not stack questions. Do not recap the whole claim.
Field guidance:
- smsBody: under 200 characters, one sentence plus one question max, no links.
- emailSubject: under 60 characters.
- emailBody: 1 short paragraph + a Claim:/Policy:/amount fact block. Sign with "— Conquer claims agent". No HTML tags.
- firstMessage: ONE spoken sentence (under 25 words). Name ${sub.systemName}, claim ${claim.id}, and the single ask. No "do you have a moment", no second question.`,
  });

  // Prefer template phone openers except settlement confirms (those need live totals).
  const phoneFirst =
    resolved === 'call' && !dynamicMoney && authored?.trim() ? authored.trim() : '';

  // null covers unconfigured, request failure, and unparseable output alike.
  if (!drafted) {
    const base = { ...fallback, contextVars: contextVarsFor(claim, sub, recalled) };
    return phoneFirst ? { ...base, firstMessage: phoneFirst } : base;
  }

  return {
    channel: resolved,
    recipientName: sub.systemName,
    smsBody: drafted.smsBody || fallback.smsBody,
    emailSubject: drafted.emailSubject || fallback.emailSubject,
    emailBody: drafted.emailBody || fallback.emailBody,
    firstMessage: phoneFirst || drafted.firstMessage || fallback.firstMessage,
    contextVars: contextVarsFor(claim, sub, recalled),
  };
}

/**
 * Generate a plausible recipient reply for the force-advance override, so a demo can
 * move past an outstanding contact without a real human answering. Prefers the model, then
 * the claim template's authored reply, then a generic acknowledgement.
 *
 * Whatever this returns is synthetic either way, so the caller must record the resolution
 * as replySource: 'synthesized' -- never 'inbound'.
 */
export async function synthesizeReply(claim: Claim, sub: SubStep): Promise<string> {
  const authored = cannedReplies.get(cannedKey(claim.id, sub.id))?.text;
  const generic = authored ?? `Understood - ${sub.description.toLowerCase()}. Confirmed on our end, please proceed.`;

  const step = claim.timeline[claim.currentStepIndex];
  const drafted = await generateJson<{ text: string }>({
    label: `synthesized reply from [${sub.systemName}]`,
    schemaName: 'synthesized_reply',
    schema: strictObject({ text: str }),
    prompt: `You are role-playing the RECIPIENT of a message from an AI insurance claim representative.
The claimant is ${claim.claimantName}.
The overall claim is a ${claim.claimType} for ${claim.claimAmount} dollars (Incident details: ${claim.description}).
The current step signal is: "${step?.signal ?? ''}"
You are "${sub.systemName}" and the agent contacted you to: "${sub.description}".
${
      isShopNegotiationSub(sub)
        ? `You are a body-shop manager negotiating price. Include an explicit revised dollar total and/or concession (e.g. "we'll take $1 off — revised quote is $9199" or "concede $450, revised quote $8750").`
        : ''
    }
Write ONLY your single reply message, in the "text" field. Be brief, concrete, and
cooperative - include any reference number, time, or confirmation a real ${sub.systemName}
would give.`,
  });

  if (typeof drafted?.text === 'string' && drafted.text.trim()) return drafted.text.trim();
  return generic;
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

/**
 * `claims:active` may carry the app-level lock flag that the dashboard sets, so every
 * write is a forced write. Version is bumped on each persist for the UI's stale-write
 * guard.
 */
async function persistClaim(claim: Claim, reason: CheckpointReason = 'advance'): Promise<void> {
  claim.version = (claim.version ?? 0) + 1;
  if (!claim.sessionId) beginSession(claim);
  await store.set(ACTIVE_KEY, claim, 'document', undefined, true);
  // Mirror every write into the session archive so refresh / restart keeps the full run.
  const awaiting = await getAwaiting().catch(() => null);
  const endReason =
    claim.status === 'RESOLVED' || claim.status === 'CLOSED' ? 'resolved' : 'active';
  await saveSessionSnapshot(claim, { endReason, awaiting }).catch(err => {
    store.log('ERROR', `Session snapshot failed: ${(err as Error)?.message || err}`);
  });
  // Append the transition to the claim's checkpoint lineage. The snapshot above is the
  // latest state; this is the sequence, and it is what survives a process restart.
  await saveCheckpoint(claim, { reason, awaiting });
}

/** `del` throws on an app-locked key; a failed cleanup must not abort the walk. */
async function safeDel(key: string): Promise<void> {
  try {
    await store.del(key);
  } catch (err: any) {
    store.log('ERROR', `Could not delete ${key}: ${err?.message || err}`);
  }
}

/**
 * Label a claim's pre-populated chat logs as template fixtures.
 *
 * Every DEFAULT_CLAIMS template ships with `chatLog` already filled in, including the
 * recipient's side. Those conversations never happened with anyone, and the UI renders
 * them identically to a real inbound reply -- so an adjuster opening a fresh claim reads
 * a fabricated transcript and is then asked to approve money against it. Labelling them
 * is what lets the UI mark them as not-real.
 *
 * Only fills in an ABSENT `replySource`; never overwrites a provenance already recorded.
 */
export function markFixtureProvenance(claim: Claim): Claim {
  let marked = 0;
  for (const step of claim.timeline) {
    for (const sub of step.subSteps) {
      if (sub.replySource === undefined && sub.chatLog && sub.chatLog.length > 0) {
        sub.replySource = 'fixture';
        marked++;
      }
    }
  }
  if (marked > 0) {
    store.log('INFO', `Labelled ${marked} pre-populated chat log(s) as template fixtures - no real contact occurred`);
  }
  return claim;
}

export async function getAwaiting(): Promise<AwaitingContact | null> {
  const raw = await store.get(AWAITING_KEY);
  if (!raw || typeof raw !== 'object') return null;
  return raw as AwaitingContact;
}

/**
 * End the active workflow from the UI: drop the outstanding contact (so late webhooks
 * no longer advance anything), clear the active claim, and return the operator to the
 * template picker. Does not FLUSHALL — logs/keys outside this claim stay intact.
 */
export async function stopActiveClaim(): Promise<{ stopped: boolean; claimId?: string; sessionId?: string }> {
  const raw = await store.get(ACTIVE_KEY);
  const claim =
    raw && typeof raw === 'object' && typeof (raw as Claim).id === 'string' ? (raw as Claim) : null;
  const awaiting = await getAwaiting();

  const clear = async () => {
    if (awaiting?.lookupKey) await safeDel(awaiting.lookupKey);
    await safeDel(AWAITING_KEY);
    await safeDel(ACTIVE_KEY);
    await safeDel('claims:active_id');
    await safeDel('claims:status');
    await safeDel('claims:amount');
    await safeDel('claims:claimant');
    await safeDel('claims:payout_amount');
  };

  if (claim) {
    if (!claim.sessionId) beginSession(claim);
    await saveSessionSnapshot(claim, { endReason: 'stopped', awaiting }).catch(err => {
      store.log('ERROR', `Session archive on stop failed: ${(err as Error)?.message || err}`);
    });
    // Checkpoint the stop explicitly. `recoverOnBoot` refuses to resume a thread whose
    // newest checkpoint is a stop, so an operator disconnect is not undone by a restart.
    await saveCheckpoint(claim, { reason: 'stopped', awaiting });
    const ran = await withClaimLock(claim.id, clear);
    if (ran === null) await clear(); // lock busy — still clear; operator explicitly stopped
    store.log(
      'INFO',
      `Stopped workflow for ${claim.id} — session ${claim.sessionId} archived; interaction closed by user`
    );
    await store.publish('claims:pubsub', `CLAIM_STOPPED:${claim.id}`);
    return { stopped: true, claimId: claim.id, sessionId: claim.sessionId };
  }

  await clear();
  store.log('INFO', 'Stopped workflow — no active claim; cleared awaiting/lookup leftovers');
  return { stopped: true };
}

/** Throttle Sendblue inbox polls so the UI's 2.5s refresh cannot DDOS the provider. */
let lastSmsInboxPollMs = 0;
const SMS_INBOX_POLL_MIN_MS = 15_000;

/**
 * Long-horizon safety net for SMS: if we are parked on an SMS contact and the
 * receive webhook never fired (misconfigured Sendblue account is the usual
 * cause), pull recent inbound messages from Sendblue and apply any that match.
 *
 * Safe to call on every `/api/claims/active` poll — internally rate-limited and
 * a no-op when not awaiting SMS or when SMS is mocked.
 */
export async function pollSmsInboxFallback(): Promise<Claim | null> {
  const awaiting = await getAwaiting();
  if (!awaiting || awaiting.channel !== 'sms') return null;
  if (!smsChannel.isLive()) return null;

  const now = Date.now();
  if (now - lastSmsInboxPollMs < SMS_INBOX_POLL_MIN_MS) return null;
  lastSmsInboxPollMs = now;

  const prefix = 'claims:lookup:sms:';
  if (!awaiting.lookupKey.startsWith(prefix)) return null;
  const expectFrom = awaiting.lookupKey.slice(prefix.length);
  if (!expectFrom || expectFrom.startsWith(SYNTHETIC_PREFIX)) return null;

  const sentAtMs = Date.parse(awaiting.sentAt);
  const messages = await smsChannel.listRecentMessages(expectFrom, 25);
  // Oldest first so earlier replies apply before later ones if several piled up.
  const inbound = messages
    .filter(m => !m.isOutbound && m.fromPhone === expectFrom)
    .filter(m => {
      if (!m.sentAt || !Number.isFinite(sentAtMs)) return true;
      const t = Date.parse(m.sentAt);
      return !Number.isFinite(t) || t >= sentAtMs - 5_000;
    })
    .sort((a, b) => Date.parse(a.sentAt ?? '') - Date.parse(b.sentAt ?? ''));

  for (const msg of inbound) {
    const eventId = msg.messageHandle
      ? `sb:${msg.messageHandle}`
      : `sb-poll:${awaiting.subStepId}:${msg.sentAt ?? ''}:${msg.text.slice(0, 40)}`;
    const outcome = await resolveAwaitingContact({
      channel: 'sms',
      lookupValue: msg.fromPhone,
      replyText: msg.text,
      eventId,
      replySource: 'inbound',
    });
    if (outcome.status === 'applied') {
      store.log(
        'INFO',
        `SMS inbox poll applied inbound from ${msg.fromPhone} (webhook may be missing) — resuming claim`
      );
      return outcome.claim;
    }
  }
  return null;
}

const CALL_POLL_MIN_MS = 8_000;
let lastCallPollMs = 0;

/**
 * Safety net for voice: ElevenLabs post-call webhooks often never reach localhost
 * (the dashboard URL is not this process). While parked on a live call, fetch the
 * conversation and advance once it is done — including a hangup after connect.
 */
export async function pollCallCompletionFallback(): Promise<Claim | null> {
  const awaiting = await getAwaiting();
  if (!awaiting || awaiting.channel !== 'call') return null;
  if (!voiceChannel.isLive()) return null;

  const now = Date.now();
  if (now - lastCallPollMs < CALL_POLL_MIN_MS) return null;
  lastCallPollMs = now;

  const prefix = 'claims:lookup:call:';
  if (!awaiting.lookupKey.startsWith(prefix)) return null;
  const conversationId = awaiting.lookupKey.slice(prefix.length);
  if (!conversationId || conversationId.startsWith(SYNTHETIC_PREFIX) || conversationId.startsWith('mock-')) {
    return null;
  }

  const conv = await voiceChannel.getConversation(conversationId);
  if (!conv.ok) return null;
  if (conv.status === 'initiated' || conv.status === 'in-progress') return null;
  if (conv.status === 'processing' && !(conv.transcript && conv.transcript.length > 0)) return null;
  if (conv.status === 'failed') {
    store.log('INFO', `Call ${conversationId} failed; keeping claim parked on this contact`);
    return null;
  }

  const parsed: voiceChannel.ParsedCallWebhook = {
    conversationId,
    eventType: 'post_call_transcription',
    status: conv.status,
    transcript: conv.transcript,
    summary: conv.summary,
    callDurationSecs: conv.callDurationSecs,
    terminationReason: conv.terminationReason,
    hasUserAudio: conv.hasUserAudio,
    eventId: `el-poll:${conversationId}:${conv.status ?? 'done'}`,
  };
  const gate = voiceChannel.isCallCompleteForProgression(parsed);
  if (!gate.complete) {
    store.log('INFO', `Call poll: not advancing — ${gate.reason} (conversation=${conversationId})`);
    return null;
  }

  const uselessSummary = /summary couldn't be generated/i;
  const replyText =
    conv.transcript && conv.transcript.length > 0
      ? undefined
      : conv.summary && !uselessSummary.test(conv.summary)
        ? conv.summary
        : 'Call ended; the recipient disconnected.';

  const outcome = await resolveAwaitingContact({
    channel: 'call',
    lookupValue: conversationId,
    transcript: conv.transcript,
    replyText,
    eventId: parsed.eventId,
    replySource: 'inbound',
  });
  if (outcome.status === 'applied') {
    store.log(
      'INFO',
      `Call poll applied conversation ${conversationId} (webhook may be missing) — resuming claim`
    );
    return outcome.claim;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Settlement arithmetic
// ---------------------------------------------------------------------------

export interface Settlement {
  deductible: number;
  payout: number;
}

/**
 * THE single source of settlement arithmetic. `advanceClaim` calls it to draft the
 * pre-approval preview (`proposedDeductible` / `proposedPayout`) and `finalizeClaim`
 * calls it to cut the real check, so the figure the adjuster signs off on is the figure
 * that actually gets paid. Never inline this formula anywhere else.
 */
export async function computeSettlement(claim: Claim): Promise<Settlement> {
  const deductible = await resolveDeductible(claim);
  return { deductible, payout: Math.max(0, claim.claimAmount - deductible) };
}

/** Used when the deductible is unset or the configured value is unusable. */
const DEFAULT_DEDUCTIBLE = 500;

/**
 * Read and validate `claims:config:deductible`.
 *
 * This key is seeded specifically so it can be edited from the dashboard CLI, so the value
 * is untrusted input that feeds a payout calculation. The previous
 * `parseInt(String(v), 10) || 500` got three things wrong, each of which moved money:
 *
 *   "0"     -> `|| 500` treated a legitimate zero-deductible as unset and withheld $500
 *              from the claimant. Absent and zero are now distinguished.
 *   "-100"  -> a negative deductible ADDED to the payout, taking it above the claim
 *              amount. `Math.max(0, ...)` clamps the payout but validated nothing.
 *   "1e3"   -> parseInt stops at the first non-digit and yielded 1, not 1000. (Same class
 *              of bug as "100abc" -> 100.) Number() parses the whole string or fails.
 */
async function resolveDeductible(claim: Claim): Promise<number> {
  const configured = await store.get('claims:config:deductible');

  // Genuinely unset -- distinct from a configured 0, which is honoured below.
  if (configured === null || configured === undefined) return DEFAULT_DEDUCTIBLE;

  const raw = String(configured).trim();
  const reject = (why: string): number => {
    store.log(
      'ERROR',
      `claims:config:deductible ${JSON.stringify(raw)} ${why} - falling back to ` +
        `${money(DEFAULT_DEDUCTIBLE)}. Fix the key; the settlement figure is not trustworthy until you do.`
    );
    return DEFAULT_DEDUCTIBLE;
  };

  if (raw === '') return reject('is empty');

  // Number() rather than parseInt: it rejects trailing garbage instead of truncating, and
  // it understands exponent notation. Note Number('') is 0, hence the empty check above.
  const value = Number(raw);
  if (!Number.isFinite(value)) return reject('is not a finite number');
  if (value < 0) return reject('is negative, which would inflate the payout above the claim');

  // A deductible ABOVE the claim amount is deliberately honoured rather than rejected: in
  // insurance that is a below-deductible claim and the correct payout is zero, which
  // Math.max(0, ...) produces. Substituting the default here would pay out money that no
  // configuration asked for, and overpaying is worse than underpaying because the human
  // approval gate shows proposedPayout before anything is released -- an adjuster seeing
  // $0 will catch a typo'd deductible, whereas a plausible-looking figure sails through.
  if (value > claim.claimAmount) {
    store.log(
      'ERROR',
      `claims:config:deductible ${money(value)} exceeds the ${money(claim.claimAmount)} claim ` +
        `amount - this claim is below deductible and the payout will be ${money(0)}.`
    );
  }

  return value;
}

/**
 * Park the claim at the human approval gate, drafting the payout preview at that moment
 * so the approval screen can show a real number instead of "pending calculation".
 */
async function enterAwaitingApproval(claim: Claim, reason: string): Promise<void> {
  const { deductible, payout } = await computeSettlement(claim);
  claim.proposedDeductible = deductible;
  claim.proposedPayout = payout;
  claim.status = 'AWAITING_APPROVAL';

  store.log(
    'INFO',
    `${reason} - claim is AWAITING_APPROVAL: proposed payout ${money(payout)} ` +
      `(${money(claim.claimAmount)} less ${money(deductible)} deductible)`
  );
  await store.set('claims:status', 'AWAITING_APPROVAL', 'string');
  await store.publish('claims:pubsub', `CLAIM_AWAITING_APPROVAL:${payout}`);
}

/** Live-vs-mock per channel, for the header indicator in the UI. */
export function getVendorStatus(): VendorStatus {
  return {
    sms: smsChannel.isLive(),
    call: voiceChannel.isLive(),
    email: emailChannel.isLive(),
    llm: isLlmConfigured(),
  };
}

// ---------------------------------------------------------------------------
// Outbound dispatch
// ---------------------------------------------------------------------------

interface DispatchOutcome {
  lookupKey: string;
  mock: boolean;
  ok: boolean;
  error?: string;
  /** True when email was sent as notify-only (no wait for inbound). */
  continueWalk?: boolean;
}

/**
 * Fire one outbound contact and park the claim on it.
 *
 * A send failure still parks the sub-step in `awaiting_reply` rather than skipping it:
 * "the agent tried to reach someone and is waiting" is the truth, and it leaves the
 * force-advance override as the way out. Skipping would silently pretend the contact
 * never needed to happen.
 */
async function dispatchContact(
  claim: Claim,
  stepIndex: number,
  sub: SubStep,
  channel: Channel
): Promise<DispatchOutcome> {
  const brief = await buildContactBrief(claim, sub, channel);
  const recipient = resolveRecipient(claim, channel);

  // Stash the authored reply before we strip it, then replace the simulated dialogue
  // with just the message we are really sending.
  const authoredReply = sub.chatLog?.find(m => m.sender === 'recipient');
  if (authoredReply) cannedReplies.set(cannedKey(claim.id, sub.id), authoredReply);

  const outbound = channel === 'email' ? `${brief.emailSubject} - ${brief.emailBody}` : brief.smsBody;
  sub.chatLog = [{ sender: 'agent', name: 'Agent', text: channel === 'call' ? brief.firstMessage : outbound }];
  // Nothing has been RECEIVED yet, so drop any provenance inherited from the template.
  // Leaving a stale 'fixture' here would mislabel the real outbound message we just wrote.
  sub.replySource = undefined;

  let ok = true;
  let mock = true;
  let error: string | undefined;
  // Providers only hand back an id on a successful live send. A deterministic synthetic id
  // keeps the reverse index usable for mock sends, failed sends, and force-advance.
  let lookupValue = syntheticLookupValue(claim.id, sub.id);

  if (!recipient) {
    store.log(
      'ERROR',
      `No ${channel === 'email' ? 'email address' : 'phone number'} for ${claim.claimantName} - ` +
        `set claimantPhone/claimantEmail on the claim or DEMO_CLAIMANT_${channel === 'email' ? 'EMAIL' : 'PHONE'}. ` +
        `Treating [${sub.systemName}] contact as mock-sent.`
    );
  } else if (channel === 'sms') {
    const res = await smsChannel.sendSms({ to: recipient, body: brief.smsBody });
    ok = res.ok;
    mock = res.mock;
    error = res.error;
    // SMS is indexed by the number we sent TO -- that is what comes back as from_number.
    lookupValue = recipient;
  } else if (channel === 'call') {
    const res = await voiceChannel.placeCall({
      toNumber: recipient,
      contextVars: brief.contextVars,
      firstMessage: brief.firstMessage,
    });
    ok = res.ok;
    mock = res.mock;
    error = res.error;
    if (res.conversationId) lookupValue = res.conversationId;
  } else {
    const res = await emailChannel.sendEmail({
      to: recipient,
      subject: brief.emailSubject,
      body: brief.emailBody,
    });
    ok = res.ok;
    mock = res.mock;
    error = res.error;
    // threadId is what an inbound reply would carry; messageId is the next best handle.
    if (res.threadId) lookupValue = res.threadId;
    else if (res.messageId) lookupValue = res.messageId;
  }

  const lookupKey = lookupKeyFor(channel, lookupValue);
  const tag = mock ? 'MOCK' : 'LIVE';

  // Confirmation / quote emails have no inbound webhook — send and keep walking.
  if (channel === 'email' && isOneWayEmail(sub)) {
    sub.contactStatus = 'done';
    sub.chatLog = [
      ...(sub.chatLog ?? []),
      {
        sender: 'recipient',
        name: sub.systemName,
        text: ok
          ? `Email ${mock ? 'logged (mock)' : 'delivered'} to ${recipient ?? 'configured inbox'}.`
          : `Email send failed: ${error ?? 'unknown error'}`,
      },
    ];
    sub.replySource = 'synthesized';
    if (ok) {
      store.log('INFO', `[${tag}] EMAIL sent to [${sub.systemName}] (one-way — continuing walk)`);
      await store.publish('claims:pubsub', `AGENT_CONTACT_SENT:${channel}:${sub.id}`);
    } else {
      store.log('ERROR', `EMAIL to [${sub.systemName}] failed: ${error ?? 'unknown error'} — continuing walk`);
      await store.publish('claims:pubsub', `AGENT_CONTACT_FAILED:${channel}:${sub.id}`);
    }
    const step = claim.timeline[stepIndex];
    const deliveredNote = sub.chatLog?.[sub.chatLog.length - 1]?.text;
    if (step) absorbContactIntoMemory(claim, step, sub, deliveredNote);
    await store.set('claims:working_memory', claim.workingMemory ?? '', 'string', undefined, true);
    return { lookupKey, mock, ok, error, continueWalk: true };
  }

  // A retry of the same sub-step keeps counting up rather than resetting to 1.
  const previous = await getAwaiting();
  const attempt = previous && previous.subStepId === sub.id && previous.claimId === claim.id ? previous.attempt + 1 : 1;

  const awaiting: AwaitingContact = {
    claimId: claim.id,
    stepIndex,
    subStepId: sub.id,
    channel,
    lookupKey,
    sentAt: new Date().toISOString(),
    attempt,
  };

  await store.set(AWAITING_KEY, awaiting, 'document', undefined, true);
  await store.set(lookupKey, claim.id, 'string', LOOKUP_TTL_SECONDS, true);
  sub.contactStatus = 'awaiting_reply';

  if (ok) {
    store.log('INFO', `[${tag}] ${channel.toUpperCase()} sent to [${sub.systemName}] - awaiting reply on ${lookupKey}`);
    await store.publish('claims:pubsub', `AGENT_CONTACT_SENT:${channel}:${sub.id}`);
  } else {
    store.log('ERROR', `${channel.toUpperCase()} to [${sub.systemName}] failed: ${error ?? 'unknown error'}`);
    await store.publish('claims:pubsub', `AGENT_CONTACT_FAILED:${channel}:${sub.id}`);
  }

  return { lookupKey, mock, ok, error };
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

/**
 * Walk the claim forward until it either fires an outbound contact (and stops to wait)
 * or runs out of timeline (and stops for human approval). Persists on the way out.
 *
 * Callers should hold the claim's mutex -- see `withClaimLock`.
 */
export async function advanceClaim(claim: Claim): Promise<Claim> {
  // A version-0 claim has never been persisted, so it is a freshly loaded template and any
  // chat log on it is authored fixture content. Label it before the walk can be mistaken
  // for real contact. The version guard is what makes this safe to do here: any real
  // dispatch goes through persistClaim, which bumps the version, so a genuine outbound
  // message can never be relabelled as a fixture on a later pass.
  if ((claim.version ?? 0) === 0) markFixtureProvenance(claim);

  // Seed cumulative memory from the first step so the first outbound call has context
  // even before any reply lands (persisted on claims:active with the claim).
  if (!claim.workingMemory?.trim()) {
    const seed = claim.timeline[0]?.agentMemory?.trim();
    if (seed) {
      claim.workingMemory = seed;
      await store.set('claims:working_memory', seed, 'string', undefined, true);
    }
  }

  let iterations = 0;
  /** Set when the walk stopped because an outbound contact is now outstanding. */
  let parked = false;

  while (iterations++ < MAX_WALK_ITERATIONS) {
    if (claim.status === 'AWAITING_APPROVAL' || claim.status === 'RESOLVED' || claim.status === 'CLOSED') {
      // Backfill the preview for a claim persisted before these fields existed, so the
      // approval screen is never left with nothing to show.
      if (claim.status === 'AWAITING_APPROVAL' && claim.proposedPayout === undefined) {
        await enterAwaitingApproval(claim, 'Backfilled settlement preview');
      }
      break;
    }

    if (claim.currentStepIndex >= claim.timeline.length) {
      await enterAwaitingApproval(claim, 'Timeline exhausted');
      break;
    }

    const step: TimelineStep = claim.timeline[claim.currentStepIndex];
    if (step.status === 'pending') step.status = 'active';
    if (claim.status === 'INTAKE') claim.status = 'PROCESSING';

    const next = step.subSteps.find(s => s.contactStatus !== 'done');

    if (!next) {
      // Stage complete.
      step.status = 'completed';
      store.log('INFO', `CLAIM_STAGE_COMPLETE: "${step.signal}"`);
      await store.publish('claims:pubsub', `AGENT_STAGE_COMPLETE:index_${claim.currentStepIndex}`);

      if (claim.currentStepIndex === claim.timeline.length - 1) {
        // Final stage done -- do NOT finalize. Money only moves after a human approves.
        await enterAwaitingApproval(claim, 'All stages complete');
        break;
      }

      claim.currentStepIndex++;
      claim.timeline[claim.currentStepIndex].status = 'active';
      claim.status = 'PROCESSING';
      await store.set('claims:status', 'PROCESSING', 'string');
      continue;
    }

    // Already parked on this contact -- nothing to do until a webhook lands.
    if (next.contactStatus === 'awaiting_reply') break;

    const channel = classifyChannel(next);
    if (!channel) {
      // Internal sub-step: Horizon workflow, API call, tool write, outcome marker.
      next.contactStatus = 'done';
      store.log('COMMAND', `SUBSTEP_RESOLVED: [${next.systemName}] ${next.description}`);
      continue;
    }

    const dispatched = await dispatchContact(claim, claim.currentStepIndex, next, channel);
    if (dispatched.continueWalk) continue; // one-way email: keep advancing
    parked = true;
    break; // long-horizon: stop here and wait for the reply
  }

  // Label the checkpoint by what actually happened, so the lineage reads as a sequence of
  // agent actions rather than an undifferentiated list of writes.
  await persistClaim(
    claim,
    parked ? 'contact_dispatched' : claim.status === 'AWAITING_APPROVAL' ? 'awaiting_approval' : 'advance'
  );
  return claim;
}

// ---------------------------------------------------------------------------
// Inbound resolution
// ---------------------------------------------------------------------------

export interface ResolveOptions {
  channel: Channel;
  /** Phone number, conversationId, or email threadId, as reported by the provider. */
  lookupValue: string;
  replyText?: string;
  /** Full call transcript; replaces `replyText` for the voice channel. */
  transcript?: ChatMessage[];
  /** Dedupe key. Providers retry aggressively; the same event must apply once. */
  eventId: string;
  /**
   * Where this reply actually came from. `'inbound'` may ONLY be passed by a genuine
   * provider webhook; the force-advance path must pass `'synthesized'`.
   *
   * Deliberately optional with no default: an absent value means "provenance unknown" and
   * the UI renders that as not-real. Defaulting to `'inbound'` would let any caller that
   * forgot to say silently over-claim that a real person replied, which is the one error
   * this whole field exists to prevent.
   */
  replySource?: ReplySource;
}

/**
 * The three genuinely different things an inbound event can do. `null` used to stand for
 * all of the last two at once, so a webhook could not tell "we deliberately ignored this,
 * stop retrying" from "someone else held the lock, please retry" -- and answered 200 to
 * both, which silently dropped the retry. ElevenLabs sends a transcript AND a post-call
 * callback for one conversation, so concurrent distinct events are routine, not rare.
 */
export type ResolveOutcome =
  | { status: 'applied'; claim: Claim }
  | { status: 'ignored'; reason: string }
  | { status: 'contended' };

function ignored(reason: string): ResolveOutcome {
  store.log('ERROR', `${reason} - ignored`);
  return { status: 'ignored', reason };
}

/**
 * Resolve the outstanding contact from an inbound reply and resume the walk.
 */
export async function resolveAwaitingContact(opts: ResolveOptions): Promise<ResolveOutcome> {
  // The index key is derived the SAME way on both sides, by `lookupKeyFor`: a synthetic
  // sentinel passes through verbatim (normalizing it is what mangled it originally), and
  // anything else is phone-normalized. An exact hit is then REQUIRED -- there is no
  // fallback to the outstanding contact.
  //
  // An earlier version did fall back: if the direct lookup missed and the outstanding
  // contact happened to be indexed synthetically, any reply on that channel resolved it.
  // That was badly wrong. /webhooks/sendblue/inbound carries no signature (the free tier
  // issues no secret), so ANY unauthenticated POST advanced the claim -- and worse, the
  // stranger's text was written into the claim record as replySource: 'inbound', which the
  // UI renders as an authentic reply attributed to the policyholder. Fabricating a
  // policyholder reply and labelling it real is a worse failure than the wedge it fixed.
  //
  // Consequence, stated plainly: a contact dispatched with NO recipient configured is
  // indexed under a sentinel that no provider webhook can reproduce, so it is resolvable
  // only by force-advance (which correctly labels the reply 'synthesized'). That is the
  // honest outcome -- you cannot receive a real reply to a message you never really sent.
  const matchedKey = lookupKeyFor(opts.channel, opts.lookupValue);
  const claimId = await store.get(matchedKey);

  if (!claimId || typeof claimId !== 'string') {
    return ignored(`Inbound ${opts.channel} reply did not match any claim (no index at ${matchedKey})`);
  }

  // Dedupe lives INSIDE the mutex, and the ordering within it is load-bearing:
  //
  //   guards -> markEventSeen -> apply -> PERSIST -> delete awaiting/lookup -> advance
  //
  // 1. Guards run BEFORE markEventSeen so an event a guard ignores does not burn its
  //    dedupe slot. Burning it means the provider's retry is silently dropped, which is
  //    what turns a transiently-wedged claim into a permanently wedged one.
  // 2. markEventSeen still sits immediately before the apply, because it is the only
  //    atomic gate preventing a double-apply. It cannot be deferred past the apply: after
  //    a reply resolves sub-step A, the walk frequently dispatches sub-step B over the
  //    SAME channel to the SAME phone number, which re-creates an identical lookup key. A
  //    retry of the first event would then satisfy every guard and land its stale text on
  //    sub-step B. The SETNX is what stops that.
  // 3. The claim is PERSISTED before `claims:awaiting` and the lookup key are deleted.
  //    Deleting first meant a crash in between left the store durably inconsistent -- sub-step
  //    still awaiting_reply, awaiting record gone -- and `advanceClaim` breaks on
  //    awaiting_reply, so nothing could ever re-dispatch it. `claims:awaiting` has no TTL,
  //    so that state never healed. With persistence first, the worst case is an awaiting
  //    record pointing at an already-done sub-step, which the next walk simply skips.
  //
  // Residual window: a crash between markEventSeen and the persist drops that one event's
  // retry. It leaves no corrupt state (both keys still intact), and any later event or a
  // force-advance recovers the claim, so at-least-once is preserved where it matters.
  const outcome = await store.withLock<ResolveOutcome>(claimLockName(claimId), async () => {
    const claim = (await store.get(ACTIVE_KEY)) as Claim | null;
    if (!claim || typeof claim !== 'object') {
      return ignored(`Inbound ${opts.channel} reply for ${claimId} but no active claim is loaded`);
    }
    if (claim.id !== claimId) {
      return ignored(`Stale index ${matchedKey} points at ${claimId} but active claim is ${claim.id}`);
    }

    const awaiting = await getAwaiting();
    if (!awaiting) {
      return ignored(`Inbound ${opts.channel} reply for ${claim.id} but nothing is awaiting a reply`);
    }
    if (awaiting.claimId !== claim.id || awaiting.channel !== opts.channel || awaiting.lookupKey !== matchedKey) {
      return ignored(
        `Inbound ${opts.channel} reply does not match the outstanding contact ` +
          `(awaiting ${awaiting.channel} on ${awaiting.lookupKey})`
      );
    }

    const step = claim.timeline[awaiting.stepIndex];
    const sub = step?.subSteps.find(s => s.id === awaiting.subStepId);
    if (!step || !sub) {
      return ignored(`Awaiting sub-step ${awaiting.subStepId} is not present on claim ${claim.id}`);
    }
    if (sub.contactStatus !== 'awaiting_reply') {
      return ignored(`Sub-step ${sub.id} is "${sub.contactStatus}", not awaiting_reply`);
    }

    const transcript = opts.transcript && opts.transcript.length > 0 ? opts.transcript : null;
    const text = (opts.replyText ?? '').trim();
    if (!transcript && !text) {
      return ignored(`Inbound ${opts.channel} event ${opts.eventId} carried no reply text`);
    }

    // Guards have accepted. Claim the dedupe slot now, immediately before mutating.
    if (!(await store.markEventSeen(opts.eventId))) {
      return ignored(`Duplicate webhook ${opts.eventId} (already applied)`);
    }

    // Append the reply. A call replaces the log with the real transcript (which already
    // contains the agent's turns); text channels append a single recipient message.
    if (transcript) {
      sub.chatLog = transcript;
    } else {
      sub.chatLog = [...(sub.chatLog ?? []), { sender: 'recipient', name: sub.systemName, text }];
    }

    sub.contactStatus = 'done';

    // Record where this reply came from, overwriting whatever the template claimed.
    // Left undefined when the caller did not say, which the UI treats as untrusted.
    sub.replySource = opts.replySource;
    if (!opts.replySource) {
      store.log(
        'ERROR',
        `Reply for [${sub.systemName}] recorded with NO provenance - it will render as ` +
          `unverified. The caller of resolveAwaitingSubStep should pass replySource.`
      );
    }

    // Fold the reply into persisted working memory before the walk continues so the
    // next contact on this claim receives prior-call context via agent_memory.
    absorbContactIntoMemory(claim, step, sub, text || undefined, transcript);
    // If this was the shop negotiation call, parse their spoken total/concession and
    // rewrite claim.claimAmount so settlement email + final phone use the live figure.
    await applyShopNegotiationFromReply(claim, sub, text || undefined, transcript);
    await store.set('claims:working_memory', claim.workingMemory ?? '', 'string', undefined, true);

    // Only a REAL reply becomes long-term memory. A synthesized force-advance reply is the
    // agent talking to itself, and writing it here would poison future claims with invented
    // precedent -- the same reason `replySource` exists at all.
    if (opts.replySource === 'inbound') {
      await remember({
        kind: 'contact_outcome',
        counterparty: sub.systemName,
        claimType: claim.claimType,
        claimId: claim.id,
        sessionId: claim.sessionId,
        channel: opts.channel,
        text: `Over ${opts.channel}, ${sub.systemName} (${sub.description}): ${replyDigest(sub, text || undefined, transcript)}`,
        facts: { claimAmount: claim.claimAmount, stepSignal: step.signal },
      });
    }

    // Durable BEFORE the keys that describe the outstanding contact are removed.
    await persistClaim(claim, 'reply_resolved');

    await safeDel(AWAITING_KEY);
    // The key that actually matched -- which is the synthetic one when the fallback fired.
    await safeDel(matchedKey);

    store.log(
      'INFO',
      `${opts.replySource === 'inbound' ? 'INBOUND' : 'SYNTHESIZED'}_${opts.channel.toUpperCase()}: ` +
        `[${sub.systemName}] replied - resuming claim ${claim.id}`
    );
    await store.publish('claims:pubsub', `AGENT_REPLY_RECEIVED:${opts.channel}:${sub.id}`);

    return { status: 'applied', claim: await advanceClaim(claim) } as ResolveOutcome;
  }, 15000);

  // `withLock` returns null ONLY when the mutex was held, because the body above always
  // resolves to a ResolveOutcome. That is what makes contention distinguishable from a
  // deliberate ignore -- callers can retry the former and must not retry the latter.
  if (outcome === null) {
    store.log(
      'INFO',
      `Inbound ${opts.channel} event ${opts.eventId} hit a contended claim lock - ` +
        `no state change, safe to retry`
    );
    return { status: 'contended' };
  }
  return outcome;
}

/**
 * Back-compatible wrapper: the advanced claim, or null for anything else. Callers that
 * need to tell "deliberately ignored" from "retry me" should use `resolveAwaitingContact`.
 */
export async function resolveAwaitingSubStep(opts: ResolveOptions): Promise<Claim | null> {
  const outcome = await resolveAwaitingContact(opts);
  return outcome.status === 'applied' ? outcome.claim : null;
}

// ---------------------------------------------------------------------------
// Finalization (human-approved)
// ---------------------------------------------------------------------------

/**
 * Cut the settlement. Ported from the old process-step tail: read the configured
 * deductible, net it off the claim amount, optionally have the model write the memo and
 * justification, and record the check. Additionally emails the settlement breakdown --
 * an email failure is logged and never blocks finalization.
 *
 * Callers must have verified the human approval gate (status AWAITING_APPROVAL) and
 * should hold the claim mutex.
 */
export async function finalizeClaim(claim: Claim): Promise<Claim> {
  const fresh = await computeSettlement(claim);

  // Pay what the adjuster actually approved. `proposedPayout` was drafted from the same
  // computeSettlement() call when the claim entered AWAITING_APPROVAL, so normally these
  // agree exactly. They can only diverge if claims:config:deductible was edited between
  // the draft and the approval click -- in which case honouring the approved figure is
  // the defensible choice, and the discrepancy is logged loudly rather than swallowed.
  let deduct = fresh.deductible;
  let payoutAmount = fresh.payout;

  if (claim.proposedPayout !== undefined && claim.proposedPayout !== fresh.payout) {
    store.log(
      'ERROR',
      `Deductible config changed after approval was drafted: approved ${money(claim.proposedPayout)} ` +
        `but current config computes ${money(fresh.payout)}. Paying the APPROVED amount.`
    );
    payoutAmount = claim.proposedPayout;
    deduct = claim.proposedDeductible ?? fresh.deductible;
  }

  let resolutionText =
    `Claim resolved for policyholder ${claim.claimantName}. Initial evaluation of ` +
    `$${claim.claimAmount.toLocaleString()} approved. Deductible of $${deduct.toLocaleString()} applied. ` +
    `Net disbursal sum: $${payoutAmount.toLocaleString()}.`;
  let memo = `${claim.claimType} Settlement`;

  if (isLlmConfigured()) {
    store.log('INFO', `Invoking ${modelName()} to synthesize the official resolution check printout`);
  }
  const printout = await generateJson<{ memo: string; resolutionText: string }>({
    label: `resolution check printout for ${claim.id}`,
    schemaName: 'resolution_printout',
    schema: strictObject({ memo: str, resolutionText: str }),
    prompt: `You are an insurance claim resolution coordinator.
The claimant is ${claim.claimantName}.
The overall claim is a ${claim.claimType} for ${claim.claimAmount} dollars (Incident details: ${claim.description}).
We are finalizing and approving this claim. Net payout is calculated as claim amount minus deductible.
The applied deductible is ${deduct} dollars.
Write a formal, brief 1-2 sentence justification (resolutionText) for the checkout check.
Also write a check memo line of max 5 words.`,
  });

  // Each field is guarded independently: a partial answer must not blank out the
  // deterministic text that is about to be printed on a settlement check.
  if (printout?.resolutionText?.trim()) resolutionText = printout.resolutionText.trim();
  if (printout?.memo?.trim()) memo = printout.memo.trim();

  claim.resolutionCheck = {
    checkNumber: `CK-${Math.floor(100000 + Math.random() * 900000)}`,
    date: new Date().toLocaleDateString(),
    amount: payoutAmount,
    payTo: claim.claimantName,
    memo,
    signature: 'SmartAgent AutoSign',
    resolutionText,
  };
  claim.status = 'RESOLVED';

  await store.set('claims:payout_amount', String(payoutAmount), 'string');
  await store.set('claims:status', 'RESOLVED', 'string');

  // How this claim type actually settled, so the next one of its kind starts from a real
  // precedent rather than the template's default figures.
  await remember({
    kind: 'settlement',
    counterparty: claim.claimantName,
    claimType: claim.claimType,
    claimId: claim.id,
    sessionId: claim.sessionId,
    text:
      `${claim.claimType} settled at ${money(payoutAmount)} net (claim ${money(claim.claimAmount)} ` +
      `less ${money(deduct)} deductible)` +
      (claim.shopConcession && claim.shopConcession > 0
        ? `, after a ${money(claim.shopConcession)} vendor concession.`
        : '.'),
    facts: {
      payout: payoutAmount,
      deductible: deduct,
      claimAmount: claim.claimAmount,
      concession: claim.shopConcession ?? 0,
    },
  });

  // The reference flow's last act is emailing the settlement breakdown.
  const to = resolveRecipient(claim, 'email');
  if (!to) {
    store.log('ERROR', 'No email address for the settlement notice - set claimantEmail or DEMO_CLAIMANT_EMAIL');
  } else {
    const res = await emailChannel.sendEmail({
      to,
      subject: `Settlement for claim ${claim.id} - ${money(payoutAmount)} approved`,
      body:
        `Hi ${claim.claimantName},\n\n` +
        `${resolutionText}\n\n` +
        `Claim: ${claim.id}\n` +
        `Policyholder: ${claim.claimantName}\n` +
        `Policy: ${claim.policyNumber}\n` +
        `Claim amount: ${money(claim.claimAmount)}\n` +
        `Deductible applied: ${money(deduct)}\n` +
        `Net settlement: ${money(payoutAmount)}\n` +
        `Check number: ${claim.resolutionCheck.checkNumber}\n` +
        `Memo: ${memo}\n\n` +
        `— Conquer claims agent`,
    });
    if (res.ok) {
      store.log('INFO', `[${res.mock ? 'MOCK' : 'LIVE'}] Settlement notice emailed to ${to}`);
    } else {
      // Never block finalization on the notification.
      store.log('ERROR', `Settlement notice email failed (payout still approved): ${res.error}`);
    }
  }

  // Nothing should be outstanding at this point, but clear it defensively.
  await safeDel(AWAITING_KEY);

  await persistClaim(claim, 'finalized');
  store.log('INFO', `Claim resolved with payout of $${payoutAmount} drafted`);
  await store.publish('claims:pubsub', `CLAIM_RESOLVED:${claim.id}`);
  return claim;
}
