/**
 * Durable claim-interaction sessions in MongoDB.
 *
 * The live claim still lives in `claims:active`. Every persist also upserts
 * `claims:session:{sessionId}` so a refresh, stop, or process restart does not
 * erase the full chat/timeline history. An index at `claims:sessions` lists
 * recent session ids (newest first).
 */

import {
  AwaitingContact,
  Claim,
  ClaimSessionEndReason,
  ClaimSessionRecord,
  ClaimSessionSummary,
} from '../src/types.js';
import { store } from './mongo.js';

const SESSIONS_INDEX_KEY = 'claims:sessions';
const MAX_SESSIONS = 80;

const sessionKey = (sessionId: string) => `claims:session:${sessionId}`;

export function newSessionId(): string {
  return `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Attach a fresh session id when a claim is first loaded into the agent. */
export function beginSession(claim: Claim): Claim {
  if (!claim.sessionId) {
    claim.sessionId = newSessionId();
    claim.sessionStartedAt = new Date().toISOString();
  }
  return claim;
}

async function readIndex(): Promise<string[]> {
  const raw = await store.get(SESSIONS_INDEX_KEY);
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }
  if (Array.isArray(raw)) {
    return raw.filter((x): x is string => typeof x === 'string');
  }
  return [];
}

async function writeIndex(ids: string[]): Promise<void> {
  const trimmed = ids.slice(0, MAX_SESSIONS);
  await store.set(SESSIONS_INDEX_KEY, JSON.stringify(trimmed), 'string', undefined, true);

  // Drop snapshots that fell off the retention window.
  const drop = ids.slice(MAX_SESSIONS);
  for (const id of drop) {
    try {
      await store.del(sessionKey(id));
    } catch {
      /* ignore */
    }
  }
}

async function ensureIndexed(sessionId: string): Promise<void> {
  const ids = await readIndex();
  if (ids[0] === sessionId) return;
  const next = [sessionId, ...ids.filter(id => id !== sessionId)];
  await writeIndex(next);
}

/**
 * Upsert the full claim interaction for this session.
 * Call on every persist and again when the run ends (stop / resolve / replace).
 */
export async function saveSessionSnapshot(
  claim: Claim,
  opts: {
    endReason?: ClaimSessionEndReason;
    awaiting?: AwaitingContact | null;
  } = {}
): Promise<void> {
  if (!claim.sessionId) beginSession(claim);

  const sessionId = claim.sessionId!;
  const now = new Date().toISOString();
  const endReason = opts.endReason ?? 'active';

  let previous: ClaimSessionRecord | null = null;
  try {
    const raw = await store.get(sessionKey(sessionId));
    if (raw && typeof raw === 'object' && (raw as ClaimSessionRecord).sessionId) {
      previous = raw as ClaimSessionRecord;
    }
  } catch {
    previous = null;
  }

  const record: ClaimSessionRecord = {
    sessionId,
    claimId: claim.id,
    claimantName: claim.claimantName,
    claimType: claim.claimType,
    status: claim.status,
    startedAt: claim.sessionStartedAt || previous?.startedAt || now,
    updatedAt: now,
    endedAt:
      endReason === 'active'
        ? undefined
        : previous?.endedAt && previous.endReason !== 'active'
          ? previous.endedAt
          : now,
    endReason,
    claim: JSON.parse(JSON.stringify(claim)) as Claim,
    awaiting: opts.awaiting ?? previous?.awaiting ?? null,
  };

  // Keep endedAt sticky once closed, unless we reopen as active (resume).
  if (endReason === 'active') {
    record.endedAt = undefined;
  }

  await store.set(sessionKey(sessionId), record, 'document', undefined, true);
  await ensureIndexed(sessionId);
}

export async function listSessionSummaries(limit = 40): Promise<ClaimSessionSummary[]> {
  const ids = (await readIndex()).slice(0, limit);
  const out: ClaimSessionSummary[] = [];

  for (const id of ids) {
    const raw = await store.get(sessionKey(id));
    if (!raw || typeof raw !== 'object') continue;
    const rec = raw as ClaimSessionRecord;
    if (!rec.claim || !rec.sessionId) continue;
    out.push({
      sessionId: rec.sessionId,
      claimId: rec.claimId,
      claimantName: rec.claimantName,
      claimType: rec.claimType,
      status: rec.status,
      startedAt: rec.startedAt,
      updatedAt: rec.updatedAt,
      endedAt: rec.endedAt,
      endReason: rec.endReason,
      claimAmount: rec.claim.claimAmount,
      currentStepIndex: rec.claim.currentStepIndex,
      stepCount: rec.claim.timeline?.length ?? 0,
    });
  }

  return out;
}

export async function getSession(sessionId: string): Promise<ClaimSessionRecord | null> {
  const raw = await store.get(sessionKey(sessionId));
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as ClaimSessionRecord;
  return rec.sessionId && rec.claim ? rec : null;
}

/**
 * Archive whatever is currently active (if anything) before loading a new claim.
 */
export async function archiveActiveSession(
  endReason: ClaimSessionEndReason,
  awaiting?: AwaitingContact | null
): Promise<void> {
  const raw = await store.get('claims:active');
  if (!raw || typeof raw !== 'object' || typeof (raw as Claim).id !== 'string') return;
  const claim = raw as Claim;
  if (!claim.sessionId) beginSession(claim);
  await saveSessionSnapshot(claim, { endReason, awaiting: awaiting ?? null });
}
