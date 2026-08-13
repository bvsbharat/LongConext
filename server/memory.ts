/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The agent's long-term memory: what it learned on *previous* claims, retrievable on the
 * next one.
 *
 * This is the difference between state and memory, and the app needs both:
 *
 *   - `kv` / `checkpoints`   state -- where THIS claim is, so a restart resumes it
 *   - `agent_memory` (here)  memory -- what worked BEFORE, so a new claim starts informed
 *
 * `claim.workingMemory` is not this. It is scoped to one claim and dies with it, which is
 * precisely the cold start: every new claim re-negotiates a repair rate the agent already
 * won last week, re-asks a payer for evidence it already knows that payer demands. Memories
 * written here outlive the claim, the session, and the process.
 *
 * Retrieval has to change behaviour, not just pad a prompt, so a recalled memory carries the
 * structured `facts` that produced it (the concession actually won, the evidence list a payer
 * actually asked for) and those figures are what get fed into the next negotiation brief and
 * into the live voice call's dynamic variables.
 *
 * Retrieval modes
 * ---------------
 * `vector`  Atlas Vector Search over `embedding` ($vectorSearch). Requires Atlas *and* an
 *           OpenAI key for the embedding. Auto-provisions the index on first connect.
 * `keyword` Deterministic term-overlap scoring in process. Used on a local/ephemeral mongod,
 *           under MOCK_MODE, or when Atlas has not finished building the index. Same
 *           function signature and same shape of result, so nothing downstream branches.
 *
 * The mode is decided per call by what actually succeeds, never assumed, and is reported on
 * every recalled memory so the dashboard/log can show which path served it.
 */

import crypto from 'crypto';
import { Collection, ObjectId } from 'mongodb';
import {
  AgentMemoryEntry,
  AgentMemoryStatus,
  MemoryKind,
  RecallMode,
} from '../src/types.js';
import { getLlmClient, isLlmConfigured } from './llm.js';
import { store } from './mongo.js';

const COLLECTION = 'agent_memory';
const VECTOR_INDEX = 'agent_memory_vector';

/** `text-embedding-3-small`: 1536 dims, and cheap enough to embed every memory written. */
const EMBED_MODEL = process.env.OPENAI_EMBEDDING_MODEL?.trim() || 'text-embedding-3-small';
const EMBED_DIMS = Number(process.env.OPENAI_EMBEDDING_DIMS) || 1536;

/** How many candidates the keyword fallback scores before picking the top matches. */
const KEYWORD_CANDIDATES = 200;

// MemoryKind / RecallMode / the two wire shapes live in `src/types.ts`, which is the shared
// server+client contract. Re-exported so callers in `server/` need only one import.
export type { AgentMemoryEntry as RecalledMemory, AgentMemoryStatus as MemoryStatus, MemoryKind, RecallMode };

export interface AgentMemoryDoc {
  _id?: ObjectId;
  /** Stable dedupe key, so a retried webhook cannot write the same memory twice. */
  key: string;
  kind: MemoryKind;
  /** The memory itself, in one or two sentences, written to be read back into a prompt. */
  text: string;
  /** Who the agent was dealing with (shop, payer, claimant, ...). */
  counterparty: string;
  claimType: string;
  claimId: string;
  sessionId?: string;
  channel?: string | null;
  /**
   * Structured outcome behind the text. This is what makes a recall actionable rather than
   * decorative -- e.g. { concession: 640, quoteBefore: 9390, quoteAfter: 8750 }.
   */
  facts: Record<string, number | string | boolean | null>;
  embedding?: number[];
  createdAt: Date;
  recallCount: number;
  lastRecalledAt: Date | null;
}

let vectorReady = false;
let vectorAttempted = false;

const collection = (): Collection<AgentMemoryDoc> => store.collection<AgentMemoryDoc>(COLLECTION);

/**
 * Dedupe identity. Scoped to the SESSION rather than the claim: a provider retrying the same
 * webhook must not write twice, but re-running the same claim template tomorrow is a new run
 * whose outcome deserves its own memory.
 */
const memoryKey = (input: {
  sessionId?: string;
  claimId: string;
  kind: MemoryKind;
  counterparty: string;
  text: string;
}): string =>
  crypto
    .createHash('sha1')
    .update(`${input.sessionId ?? input.claimId}|${input.kind}|${input.counterparty}|${input.text}`)
    .digest('hex');

// ---------------------------------------------------------------------------- lifecycle

/**
 * Indexes, plus a best-effort Atlas Vector Search index. Call after `initDb()`.
 *
 * `createSearchIndex` only exists on Atlas; on a local or ephemeral mongod it fails, which is
 * not an error condition -- it just means recall runs in `keyword` mode. Index builds are
 * asynchronous on Atlas too, so `vectorReady` is treated as optimistic and the first
 * `$vectorSearch` that fails demotes it.
 */
export async function initMemory(): Promise<AgentMemoryStatus> {
  const col = collection();
  await Promise.all([
    col.createIndex({ key: 1 }, { unique: true }),
    col.createIndex({ claimType: 1, createdAt: -1 }),
    col.createIndex({ counterparty: 1, kind: 1 }),
  ]);

  if (store.isAtlas() && isLlmConfigured()) {
    try {
      const existing = await col.listSearchIndexes().toArray();
      if (!existing.some(idx => idx.name === VECTOR_INDEX)) {
        await col.createSearchIndex({
          name: VECTOR_INDEX,
          type: 'vectorSearch',
          definition: {
            fields: [
              { type: 'vector', path: 'embedding', numDimensions: EMBED_DIMS, similarity: 'cosine' },
              { type: 'filter', path: 'claimType' },
              { type: 'filter', path: 'kind' },
            ],
          },
        } as any);
        store.log('INFO', `Atlas Vector Search index "${VECTOR_INDEX}" requested (build is async)`);
      }
      vectorReady = true;
    } catch (err: any) {
      vectorReady = false;
      store.log(
        'INFO',
        `Vector Search unavailable (${err?.codeName || err?.message || 'not Atlas'}) - agent memory recall runs in keyword mode`
      );
    }
  } else {
    store.log(
      'INFO',
      store.isAtlas()
        ? 'Vector Search skipped: no embedding model configured - agent memory recall runs in keyword mode'
        : 'Vector Search needs Atlas - agent memory recall runs in keyword mode'
    );
  }
  vectorAttempted = false;

  const status = await memoryStatus();
  store.log(
    'INFO',
    `Agent memory ready: ${status.total} memories, recall mode "${status.mode}"`
  );
  return status;
}

export async function memoryStatus(): Promise<AgentMemoryStatus> {
  const total = store.isReady() ? await collection().estimatedDocumentCount() : 0;
  const embeddings = isLlmConfigured();
  return {
    mode: vectorReady && embeddings ? 'vector' : 'keyword',
    vectorReady,
    embeddings,
    total,
  };
}

// ---------------------------------------------------------------------------- embedding

/**
 * Returns null rather than throwing on every failure path -- no key, MOCK_MODE, or a failed
 * request. A memory with no embedding is still written and still recallable by keyword; the
 * one thing that must never happen is a write being lost because embedding failed.
 */
async function embed(text: string): Promise<number[] | null> {
  const openai = getLlmClient();
  if (!openai) return null;
  try {
    const res = await openai.embeddings.create({
      model: EMBED_MODEL,
      input: text.slice(0, 8000),
      ...(EMBED_DIMS !== 1536 ? { dimensions: EMBED_DIMS } : {}),
    });
    const vector = res.data?.[0]?.embedding;
    return Array.isArray(vector) ? vector : null;
  } catch (err: any) {
    store.log('ERROR', `Embedding failed (memory still stored unembedded): ${err?.message || err}`);
    return null;
  }
}

// ---------------------------------------------------------------------------- writing

export interface RememberInput {
  kind: MemoryKind;
  text: string;
  counterparty: string;
  claimType: string;
  claimId: string;
  sessionId?: string;
  channel?: string | null;
  facts?: Record<string, number | string | boolean | null>;
}

/**
 * Upsert one durable memory. Idempotent on (claimId, kind, counterparty, text), because the
 * webhook paths that call this are themselves retried by the provider.
 *
 * Never throws: a memory write must not be able to break a claim that is otherwise fine.
 */
export async function remember(input: RememberInput): Promise<boolean> {
  if (!store.isReady()) return false;
  const text = input.text.trim();
  if (!text) return false;

  try {
    const key = memoryKey({ ...input, text });
    const already = await collection().countDocuments({ key }, { limit: 1 });
    if (already > 0) return false;

    // Embed the memory together with who it is about, so recall matches on counterparty
    // as well as content ("body shop labour rate" should find the body shop memory).
    const embedding = await embed(`${input.counterparty} | ${input.claimType} | ${text}`);

    await collection().updateOne(
      { key },
      {
        $setOnInsert: {
          key,
          kind: input.kind,
          text,
          counterparty: input.counterparty,
          claimType: input.claimType,
          claimId: input.claimId,
          sessionId: input.sessionId,
          channel: input.channel ?? null,
          facts: input.facts ?? {},
          ...(embedding ? { embedding } : {}),
          createdAt: new Date(),
          recallCount: 0,
          lastRecalledAt: null,
        },
      },
      { upsert: true }
    );

    store.log('COMMAND', `MEMORY_WRITE [${input.kind}] ${input.counterparty}: ${truncate(text, 90)}`);
    await store.publish('claims:pubsub', `AGENT_MEMORY_WRITTEN:${input.kind}:${input.counterparty}`);
    return true;
  } catch (err: any) {
    store.log('ERROR', `Memory write failed: ${err?.message || err}`);
    return false;
  }
}

// ---------------------------------------------------------------------------- recall

export interface RecallOptions {
  /** Natural-language description of what the agent is about to do. */
  query: string;
  claimType?: string;
  kinds?: MemoryKind[];
  /**
   * Exclude the run currently in flight, so recall is genuinely prior experience.
   *
   * Scoped to the session and NOT the claim id on purpose. Claim ids come from templates and
   * repeat across runs, so excluding by claim id would make the agent blind to exactly the
   * memories that prove the point -- what it learned last time it worked this same claim.
   */
  excludeSessionId?: string;
  limit?: number;
}

/**
 * Retrieve prior memories relevant to what the agent is about to do.
 *
 * Tries `$vectorSearch` when Atlas and embeddings are both available, and silently demotes to
 * keyword scoring for the rest of the process if the aggregation fails (index still building,
 * permissions, dimension mismatch). Callers get the same shape either way and must not care.
 */
export async function recall(opts: RecallOptions): Promise<AgentMemoryEntry[]> {
  if (!store.isReady()) return [];
  const limit = opts.limit ?? 4;

  const filter: Record<string, any> = {};
  if (opts.claimType) filter.claimType = opts.claimType;
  if (opts.kinds?.length) filter.kind = { $in: opts.kinds };
  if (opts.excludeSessionId) filter.sessionId = { $ne: opts.excludeSessionId };

  let hits: AgentMemoryEntry[] = [];

  if (vectorReady && isLlmConfigured()) {
    const vector = await embed(opts.query);
    if (vector) {
      try {
        hits = await vectorRecall(vector, filter, limit);
        vectorAttempted = true;
      } catch (err: any) {
        vectorReady = false;
        store.log(
          'INFO',
          `$vectorSearch failed (${err?.codeName || err?.message}) - falling back to keyword recall for the rest of this process`
        );
      }
    }
  }

  if (hits.length === 0) hits = await keywordRecall(opts.query, filter, limit);
  if (hits.length === 0) return [];

  // Usage is part of the memory: a memory that keeps getting recalled is worth keeping.
  await collection()
    .updateMany(
      { _id: { $in: hits.map(h => new ObjectId(h.id)) } },
      { $inc: { recallCount: 1 }, $set: { lastRecalledAt: new Date() } }
    )
    .catch(() => {});

  store.log(
    'COMMAND',
    `MEMORY_RECALL (${hits[0].mode}) ${hits.length} hit(s) for "${truncate(opts.query, 60)}"`
  );
  await store.publish('claims:pubsub', `AGENT_MEMORY_RECALL:${hits[0].mode}:${hits.length}`);
  return hits;
}

async function vectorRecall(
  vector: number[],
  filter: Record<string, any>,
  limit: number
): Promise<AgentMemoryEntry[]> {
  // $vectorSearch only filters on paths declared as `filter` in the index definition, so the
  // session exclusion is applied as a normal $match stage afterwards instead.
  const preFilter: Record<string, any> = {};
  if (filter.claimType) preFilter.claimType = filter.claimType;
  if (filter.kind) preFilter.kind = filter.kind;

  const docs = await collection()
    .aggregate<AgentMemoryDoc & { score: number }>([
      {
        $vectorSearch: {
          index: VECTOR_INDEX,
          path: 'embedding',
          queryVector: vector,
          numCandidates: Math.max(limit * 20, 100),
          limit: limit * 3,
          ...(Object.keys(preFilter).length ? { filter: preFilter } : {}),
        },
      },
      { $set: { score: { $meta: 'vectorSearchScore' } } },
      ...(filter.sessionId ? [{ $match: { sessionId: filter.sessionId } }] : []),
      { $limit: limit },
    ])
    .toArray();

  return docs.map(doc => shape(doc, doc.score, 'vector'));
}

/**
 * Deterministic term-overlap scoring, done in process over a bounded candidate set.
 *
 * Not a pretend vector search: it is a plain lexical ranker, and it is honest about being
 * one. It exists so that the demo path (ephemeral mongod, no OpenAI key) still *retrieves*
 * real prior memories and still changes the agent's behaviour -- just less cleverly.
 */
async function keywordRecall(
  query: string,
  filter: Record<string, any>,
  limit: number
): Promise<AgentMemoryEntry[]> {
  const candidates = await collection()
    .find(filter)
    .sort({ createdAt: -1 })
    .limit(KEYWORD_CANDIDATES)
    .toArray();
  if (candidates.length === 0) return [];

  const terms = tokenize(query);
  if (terms.length === 0) {
    return candidates.slice(0, limit).map(doc => shape(doc, 0, 'keyword'));
  }

  const scored = candidates.map(doc => {
    const haystack = tokenize(`${doc.counterparty} ${doc.kind} ${doc.text}`);
    const bag = new Set(haystack);
    const overlap = terms.filter(t => bag.has(t)).length;
    // Normalize by query length so a long query cannot swamp a short precise memory, then
    // nudge by how often this memory has proved useful before.
    const base = overlap / terms.length;
    const usefulness = Math.min(doc.recallCount ?? 0, 5) * 0.01;
    return { doc, score: base + usefulness };
  });

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(s => shape(s.doc, Number(s.score.toFixed(3)), 'keyword'));
}

function shape(doc: AgentMemoryDoc, score: number, mode: RecallMode): AgentMemoryEntry {
  return {
    id: String(doc._id),
    kind: doc.kind,
    text: doc.text,
    counterparty: doc.counterparty,
    claimType: doc.claimType,
    claimId: doc.claimId,
    facts: doc.facts ?? {},
    createdAt: (doc.createdAt instanceof Date ? doc.createdAt : new Date()).toISOString(),
    score,
    mode,
  };
}

// ---------------------------------------------------------------------------- prompt glue

/**
 * Recalled memories as a prompt block, or '' when there is nothing to recall.
 *
 * Returning '' on an empty recall matters: an empty "PRIOR EXPERIENCE:" heading invites the
 * model to invent precedent it does not have.
 */
export function memoryBlock(hits: AgentMemoryEntry[]): string {
  if (hits.length === 0) return '';
  const lines = hits.map(h => {
    const facts = Object.entries(h.facts)
      .filter(([, v]) => v !== null && v !== '')
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    return `- [${h.counterparty}] ${h.text}${facts ? ` (${facts})` : ''}`;
  });
  return [
    'PRIOR EXPERIENCE recalled from earlier claims (real outcomes, not assumptions):',
    ...lines,
    'Use these figures and requirements as your starting position. Do not re-ask for something already known.',
  ].join('\n');
}

/** Flat one-liner for ElevenLabs dynamic variables, which must be strings. */
export function memoryVariable(hits: AgentMemoryEntry[]): string {
  if (hits.length === 0) return '';
  return hits.map(h => `${h.counterparty}: ${h.text}`).join(' | ');
}

// ---------------------------------------------------------------------------- housekeeping

export async function listMemories(limit = 40): Promise<AgentMemoryEntry[]> {
  if (!store.isReady()) return [];
  const docs = await collection().find({}).sort({ createdAt: -1 }).limit(limit).toArray();
  return docs.map(doc => shape(doc, doc.recallCount ?? 0, vectorAttempted ? 'vector' : 'keyword'));
}

/** Wipe long-term memory. Deliberately separate from FLUSHALL, which only clears state. */
export async function forgetAll(): Promise<number> {
  if (!store.isReady()) return 0;
  const res = await collection().deleteMany({});
  store.log('COMMAND', `MEMORY_FORGET_ALL removed ${res.deletedCount} memories`);
  return res.deletedCount;
}

const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9$\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2 && !STOP_WORDS.has(t));

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'was', 'were', 'has', 'have', 'had',
  'they', 'their', 'them', 'about', 'into', 'onto', 'are', 'not', 'but', 'you', 'our', 'any',
  'all', 'can', 'will', 'would', 'should', 'what', 'when', 'who', 'how', 'why',
]);

const truncate = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;
