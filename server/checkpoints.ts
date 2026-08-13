/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Thread-scoped state checkpoints, in the shape LangGraph's MongoDB checkpointer uses:
 * one document per state transition, each pointing at its parent, keyed by a thread id.
 *
 *   thread_id            = the claim id (one long-horizon claim is one graph thread)
 *   checkpoint_id        = this transition
 *   parent_checkpoint_id = the transition it followed, so the lineage is walkable
 *
 * Why this exists on top of `sessions.ts`: a session snapshot is the *latest* state of a run,
 * overwritten in place, and it is what the UI's history list reads. A checkpoint is the
 * *sequence* -- every advance, dispatch and reply appended, never overwritten. That buys two
 * things a snapshot cannot:
 *
 *   1. Crash recovery mid-claim. The agent is parked waiting on a webhook for hours or days;
 *      the process restarting in that window must not lose the claim. `recoverOnBoot()` reads
 *      the newest unfinished checkpoint and puts it back in `claims:active`, so a restart
 *      resumes rather than cold-starts.
 *   2. Auditable rewind. `restoreCheckpoint()` moves the live claim back to any earlier
 *      transition, which is how you replay "what did the agent know before that call".
 *
 * Recovery is deliberately conservative. It restores the claim document and the outstanding
 * `claims:awaiting` + reverse-index lookup, and it does NOT re-send anything: the contact
 * already went out before the crash, and re-dialling a policyholder on every deploy would be
 * the worst possible failure mode. Progression still waits for the inbound webhook.
 */

import { Collection, ObjectId } from 'mongodb';
import { AwaitingContact, CheckpointReason, CheckpointSummary, Claim } from '../src/types.js';
import { store } from './mongo.js';

const COLLECTION = 'checkpoints';
const ACTIVE_KEY = 'claims:active';
const AWAITING_KEY = 'claims:awaiting';

/** Long enough that a reply the next day still matches -- mirrors the orchestrator's TTL. */
const LOOKUP_TTL_SECONDS = 48 * 60 * 60;

/** Retained transitions per thread. Enough to rewind a whole claim, bounded so it cannot grow forever. */
const MAX_PER_THREAD = 200;

/** A claim in one of these states has nothing left to resume. */
const TERMINAL_STATUSES = new Set(['RESOLVED', 'CLOSED']);

// CheckpointReason and CheckpointSummary live in `src/types.ts`, the shared server+client
// contract. Re-exported so callers in `server/` need only one import.
export type { CheckpointReason, CheckpointSummary };

export interface CheckpointDoc {
  _id?: ObjectId;
  threadId: string;
  checkpointId: string;
  parentCheckpointId: string | null;
  sessionId?: string;
  ts: Date;
  reason: CheckpointReason;
  /** Claim status at this transition, so recovery can skip finished threads cheaply. */
  status: string;
  stepIndex: number;
  /** Sub-step this transition was about, when it was about one. */
  subStepId: string | null;
  /** Monotonic write counter copied off the claim -- handy when reading the lineage by eye. */
  version: number;
  /** The full claim document as it stood. This is the resumable state. */
  state: Claim;
  awaiting: AwaitingContact | null;
}

const collection = (): Collection<CheckpointDoc> => store.collection<CheckpointDoc>(COLLECTION);

export async function initCheckpoints(): Promise<void> {
  const col = collection();
  await Promise.all([
    col.createIndex({ checkpointId: 1 }, { unique: true }),
    col.createIndex({ threadId: 1, ts: -1 }),
    col.createIndex({ status: 1, ts: -1 }),
  ]);
}

// ---------------------------------------------------------------------------- writing

/**
 * Append a checkpoint for this claim. Never throws -- a lost checkpoint degrades recovery,
 * but a throw here would break the claim it was trying to protect.
 */
export async function saveCheckpoint(
  claim: Claim,
  opts: { reason: CheckpointReason; awaiting?: AwaitingContact | null; subStepId?: string | null } = {
    reason: 'advance',
  }
): Promise<string | null> {
  if (!store.isReady()) return null;
  try {
    const parent = await collection()
      .find({ threadId: claim.id }, { projection: { checkpointId: 1 } })
      .sort({ ts: -1 })
      .limit(1)
      .next();

    const _id = new ObjectId();
    const doc: CheckpointDoc = {
      _id,
      threadId: claim.id,
      checkpointId: _id.toHexString(),
      parentCheckpointId: parent?.checkpointId ?? null,
      sessionId: claim.sessionId,
      ts: new Date(),
      reason: opts.reason,
      status: claim.status,
      stepIndex: claim.currentStepIndex,
      subStepId: opts.subStepId ?? opts.awaiting?.subStepId ?? null,
      version: claim.version,
      // Deep copy: the orchestrator keeps mutating the live object after this returns.
      state: JSON.parse(JSON.stringify(claim)) as Claim,
      awaiting: opts.awaiting ?? null,
    };

    await collection().insertOne(doc);
    await trim(claim.id);
    await store.publish('claims:pubsub', `CHECKPOINT_SAVED:${opts.reason}:${doc.checkpointId}`);
    return doc.checkpointId;
  } catch (err: any) {
    store.log('ERROR', `Checkpoint write failed: ${err?.message || err}`);
    return null;
  }
}

async function trim(threadId: string): Promise<void> {
  const total = await collection().countDocuments({ threadId });
  if (total <= MAX_PER_THREAD) return;
  const stale = await collection()
    .find({ threadId }, { projection: { _id: 1 } })
    .sort({ ts: 1 })
    .limit(total - MAX_PER_THREAD)
    .toArray();
  if (stale.length) {
    await collection().deleteMany({ _id: { $in: stale.map(d => d._id!) } });
  }
}

// ---------------------------------------------------------------------------- reading

export async function listCheckpoints(threadId?: string, limit = 50): Promise<CheckpointSummary[]> {
  if (!store.isReady()) return [];
  const docs = await collection()
    .find(threadId ? { threadId } : {})
    .sort({ ts: -1 })
    .limit(limit)
    .toArray();
  return docs.map(summarize);
}

export async function latestCheckpoint(threadId: string): Promise<CheckpointDoc | null> {
  if (!store.isReady()) return null;
  return collection().find({ threadId }).sort({ ts: -1 }).limit(1).next();
}

function summarize(doc: CheckpointDoc): CheckpointSummary {
  return {
    checkpointId: doc.checkpointId,
    parentCheckpointId: doc.parentCheckpointId,
    threadId: doc.threadId,
    ts: (doc.ts instanceof Date ? doc.ts : new Date()).toISOString(),
    reason: doc.reason,
    status: doc.status,
    stepIndex: doc.stepIndex,
    subStepId: doc.subStepId,
    version: doc.version,
    claimantName: doc.state?.claimantName ?? '',
    claimAmount: doc.state?.claimAmount ?? 0,
    awaitingChannel: doc.awaiting?.channel ?? null,
  };
}

// ---------------------------------------------------------------------------- restoring

/**
 * Put a checkpoint's state back as the live claim.
 *
 * Rewrites `claims:active`, `claims:awaiting` and the channel reverse-index together, because
 * a restored claim that is waiting on a reply is useless if the inbound webhook cannot map the
 * provider's handle back to it. Sends nothing.
 */
export async function restoreCheckpoint(checkpointId: string): Promise<Claim | null> {
  if (!store.isReady()) return null;
  const doc = await collection().findOne({ checkpointId });
  if (!doc?.state) return null;
  return applyState(doc, 'restore');
}

async function applyState(doc: CheckpointDoc, mode: 'restore' | 'recover'): Promise<Claim> {
  const claim = doc.state;

  await store.set(ACTIVE_KEY, claim, 'document', undefined, true);
  await store.set('claims:active_id', claim.id, 'string', undefined, true);
  await store.set('claims:status', claim.status, 'string', undefined, true);
  await store.set('claims:amount', String(claim.claimAmount), 'string', undefined, true);
  await store.set('claims:claimant', claim.claimantName, 'string', undefined, true);
  if (claim.workingMemory) {
    await store.set('claims:working_memory', claim.workingMemory, 'string', undefined, true);
  }

  if (doc.awaiting) {
    await store.set(AWAITING_KEY, doc.awaiting, 'document', undefined, true);
    // The reverse index is what an inbound webhook resolves; without it the claim is
    // waiting on a reply that can never be matched back to it.
    await store.set(doc.awaiting.lookupKey, claim.id, 'string', LOOKUP_TTL_SECONDS, true);
  } else {
    await store.del(AWAITING_KEY).catch(() => {});
  }

  const label = mode === 'recover' ? 'CHECKPOINT_RECOVERED' : 'CHECKPOINT_RESTORED';
  store.log(
    'INFO',
    `${label}: claim ${claim.id} (${claim.claimantName}) back at step ${claim.currentStepIndex}` +
      (doc.awaiting ? `, still awaiting ${doc.awaiting.channel} on ${doc.awaiting.lookupKey}` : '') +
      ` [checkpoint ${doc.checkpointId}, reason ${doc.reason}]`
  );
  await store.publish('claims:pubsub', `${label}:${doc.checkpointId}`);
  return claim;
}

/**
 * Boot-time recovery: the whole point of checkpointing.
 *
 * Runs only when there is no live claim -- an existing `claims:active` is newer than any
 * checkpoint by definition and must never be clobbered. Picks the newest non-terminal
 * checkpoint across all threads and reinstates it.
 *
 * On an ephemeral dev mongod there is nothing to recover, because the database died with the
 * previous process. That is exactly the cold start `MONGODB_URI` removes, and the log line
 * says so rather than staying silent.
 */
export async function recoverOnBoot(): Promise<Claim | null> {
  if (!store.isReady()) return null;
  try {
    const existing = await store.get(ACTIVE_KEY);
    if (existing && typeof existing === 'object') {
      store.log('INFO', 'Boot: live claim already present, no checkpoint recovery needed');
      return null;
    }

    const candidate = await collection()
      .find({ status: { $nin: Array.from(TERMINAL_STATUSES) } })
      .sort({ ts: -1 })
      .limit(1)
      .next();

    if (!candidate?.state) {
      store.log('INFO', 'Boot: no unfinished checkpoint to recover - starting cold');
      return null;
    }
    if (candidate.reason === 'stopped') {
      store.log(
        'INFO',
        `Boot: newest checkpoint for ${candidate.threadId} was an operator stop - not resuming it`
      );
      return null;
    }

    const claim = await applyState(candidate, 'recover');
    await saveCheckpoint(claim, { reason: 'restored', awaiting: candidate.awaiting });
    return claim;
  } catch (err: any) {
    store.log('ERROR', `Checkpoint recovery failed: ${err?.message || err}`);
    return null;
  }
}
