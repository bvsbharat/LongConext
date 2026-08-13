# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Conquer" — a **long-horizon insurance claim agent**, modeled on the pattern Sierra calls "Horizon". When a claim opens, the agent drives it end-to-end over days or weeks: it contacts the policyholder and vendors over real channels (SMS/iMessage, phone, email), keeps its state, checkpoints and long-term memory in MongoDB, and stops for human sign-off before any money moves.

Three things are worth internalizing before changing anything:

1. **Progression is event-driven, not manual.** The agent fires an outbound contact and then *waits*. An inbound webhook is what advances the claim. There is no polling loop and no timer driving the timeline forward.
2. **Nothing is simulated any more except the claim data itself.** MongoDB is real (`mongodb` driver), the messages are real, the phone calls are real. The one deliberate fake is MOCK_MODE, which exists so the app is demoable with zero configuration.
3. **State, checkpoints and memory are three different things, in three collections.** Conflating them is the most likely way to break this app conceptually:
   - `kv` — where the claim *is* right now (`claims:active`, `claims:awaiting`, the lookup index).
   - `checkpoints` — the *sequence* of transitions, so a restart mid-claim resumes rather than cold-starts.
   - `agent_memory` — what *earlier* claims taught the agent, retrieved on the next one.
   `claim.workingMemory` is none of these: it is a per-claim string that dies with the claim. Do not treat it as long-term memory.

This replaced an earlier pure simulation (an in-memory `RedisSimulator` class, hardcoded templates, a manual "Execute Step" button that fired nothing), and then a real-Redis (`ioredis`) implementation. If you find docs or comments describing either — `REDIS_URL`, `__meta__:`/`__mutex__:`/`__seen__:` key prefixes, keyspace notifications, `RedisStore` — they are stale.

## Commands

- `npm run dev` — start dev server (`tsx server.ts`, Vite in middleware mode, HMR on). The normal way to run locally.
- `npm run build` — `vite build` (client bundle to `dist/`) then `esbuild` bundles `server.ts` to `dist/server.cjs`.
- `npm run start` — `node dist/server.cjs`; requires `npm run build` first, production mode (serves static `dist/` instead of Vite middleware).
- `npm run lint` — `tsc --noEmit` (type-check only; no test runner or ESLint is configured).
- `npm run clean` — removes `dist/` and `server.js`.

No test suite exists in this repo.

### Platform note

`node_modules` contains native binaries (esbuild, `@esbuild/*`). Never copy `node_modules` between machines/OSes — always run a fresh `npm install` per machine. `esbuild`/`protobufjs`/`mongodb-memory-server` postinstall scripts are gated by npm's allow-scripts and pre-approved in `package.json`'s `allowScripts` block; if `npm install` warns about pending scripts, run `npm approve-scripts --allow-scripts-pending`.

## Architecture

One Express process (`server.ts`) that either mounts Vite as middleware (dev) or serves built `dist/` static assets (prod). No separate API server, no build-time proxy.

```
UI / bottom dock (polls /api/*) -> Express -> orchestrator -> channel adapters -> vendors
                                                     ^                                    |
                                                     +---------- webhooks <---------------+
                                                     |
                              MongoDB: kv (state, reverse index, session snapshots)
                                       checkpoints (thread lineage, crash recovery)
                                       agent_memory (vector / keyword recall)
                                       locks · events · pubsub (capped, tailed)
```

Shipped vs next Atlas features (Search, hybrid `$rankFusion`, schema validation, transactions, time series `case_beats`, change streams, Stream Processing) are in `README.md` → **What else MongoDB can add here**. Do not add a second database.

### `server/mongo.ts` — the state layer

Real MongoDB over the `mongodb` driver. Exports a shared `store` instance (class `MongoStore`), plus `initDb()` / `isDbReady()`.

- **Connection resolution**, most explicit first: `MONGODB_URI` (or `MONGO_URL` — Railway's MongoDB plugin injects that name), then a `mongod` already on `127.0.0.1:27017`, then an ephemeral one via `mongodb-memory-server`. In production without a URI it **throws** rather than silently going ephemeral.
- **The ephemeral path pins its build.** `mongodb-memory-server` derives a download URL from the host OS/arch and the newest versions are not published for every distro/arch pair — linux-aarch64/debian12 404s. So the version is pinned (`MONGOMS_VERSION`, default `7.0.14`) and the OS is overridden to ubuntu 22.04 on Linux. If you bump it, verify the download exists for arm64. **State dies with the process**, and it is a *standalone* instance: no replica set, therefore no change streams, no transactions, no Vector Search.
- **Storage design**: one document per app key in `kv`, `_id` being the key string, with `type`/`value`/`locked`/`expiresAt`/`updatedAt`. `type` is the *logical* shape of `value` and BSON stores all four natively: `string`, `array` (head-first; index 0 is the LPUSH end), `set` (array with duplicates removed), and **`document` — a real nested subdocument**. That last one is the reason for the migration: a `Claim` is stored as the document it is, so `FIND kv {"value.status":"AWAITING_APPROVAL"}` reaches inside it. **Do not JSON-stringify structure into a string field.** The Redis version had to, and lost querying, indexing and partial updates in the process.
- `ignoreUndefined: true` is set on the client, so `undefined` fields are omitted rather than stored as `null` — matching what code written against `JSON.stringify` expects.
- **Bookkeeping lives in its own collections**, not a key prefix: `locks` (mutexes), `events` (webhook dedupe), `pubsub` (capped). Nothing has to be filtered out of `getKeysInfo()` or CLI `KEYS` any more. Keep it that way — a new bookkeeping concern gets a collection, not a `kv` key.
- **Expiry is deliberately two mechanisms.** A TTL index on `expiresAt` (`expireAfterSeconds: 0`) keeps the collection clean, but **mongod's TTL monitor only runs about once a minute** — far too coarse for `claims:lookup:*`, whose entire job is to stop matching once it lapses. So (1) every read filters expired documents out, making expiry exact from the app's view, and (2) a 1s in-process sweeper deletes lapsed documents and emits the `Key X expired by TTL` log line plus `KEY_EXPIRED:` on pub/sub. That sweeper is the replacement for Redis keyspace notifications, which MongoDB has no analogue of. Documents with `expiresAt: null` are ignored by both.
- **Pub/sub is a capped collection with a tailable, awaitData cursor.** Change streams would be the obvious fit but need a replica set, and the zero-config dev path is standalone. Two non-obvious properties: a tailable cursor over an *empty* capped collection dies immediately (hence the sentinel `init` document), and the tail loop resumes from the last `_id` seen so a dead cursor neither replays nor skips.
- **Two different "locks", do not confuse them**: `lock()`/`unlock()` set an *app-level advisory flag* on a `kv` document (a locked key rejects `set`/`del` unless `force`, and the dashboard shows a padlock). `acquireLock()`/`releaseLock()`/`withLock()` are a *real mutex* in the `locks` collection — insert-or-steal-if-lapsed via `findOneAndUpdate`, released by `deleteOne({_id, token})` so a caller can never release a lock it no longer owns.
- `markEventSeen(id)` is the webhook dedupe primitive: `true` the first time an id is seen, `false` after. Same insert-then-revive-if-lapsed shape as the mutex.
- `getLogs()` and `getPubSub()` are **synchronous by contract** — the dashboard REST handlers poll them. They are in-process rolling buffers (250 logs, 150 pub/sub messages, newest first) fed by the tail loop. Everything else on `MongoStore` is async.
- `collection<T>(name)` is the escape hatch out of the key/value facade, used by `memory.ts` and `checkpoints.ts`. Anything that needs indexes, aggregation or vector search should use it rather than being forced through `get`/`set`.
- `getKeysInfo()` reports the **real BSON size** of each document (`BSON.calculateObjectSize`) and `getStats()` uses `dbStats.dataSize`, rather than the Redis version's estimate. `serverStatus` is restricted on some managed tiers, so `connectedClients` falls back to 1 instead of failing.

### `server/memory.ts` — long-term agent memory

`agent_memory`: what the agent learned on *previous* claims, retrievable on the next one. This is what makes the app not cold-start.

- **Written on real outcomes only.** `remember()` is called after a negotiation moves the money (`negotiation`, with `facts: {quoteBefore, quoteAfter, concession}`), after a genuine inbound reply (`contact_outcome`), and at settlement (`settlement`). **A synthesized force-advance reply is never written** — that is the agent talking to itself, and storing it would poison future claims with invented precedent. This is the same reason `replySource` exists.
- **Structured `facts` ride along with the prose.** A recall has to change behaviour, not pad a prompt, so the numbers that produced the memory are stored next to it and are what get fed into the next negotiation brief.
- **Two retrieval modes, decided by what actually succeeds.** `vector` is `$vectorSearch` over an Atlas index that `initMemory()` auto-provisions; `keyword` is deterministic term-overlap scoring in process. The fallback covers local/ephemeral mongod, MOCK_MODE (no embeddings), and an Atlas index still building. The first `$vectorSearch` failure demotes the mode for the rest of the process. Every `RecalledMemory` carries the `mode` that served it — **do not report a keyword hit as semantic search.**
- **`$vectorSearch` only filters on paths declared as `filter` in the index definition** (`claimType`, `kind`). The session exclusion is a `$match` stage *after* it, not a pre-filter.
- **The "exclude the current run" filter is scoped to `sessionId`, not `claimId`, and that is load-bearing.** Claim ids come from templates and repeat across runs; excluding by claim id would hide exactly the memories that prove prior experience. The dedupe `key` is session-scoped for the same reason — a provider retry must not double-write, but tomorrow's run of the same template deserves its own memory.
- `memoryBlock()` returns `''` on an empty recall rather than a bare heading, because an empty "PRIOR EXPERIENCE:" invites the model to invent precedent. `memoryVariable()` flattens to a string for ElevenLabs dynamic variables (`prior_experience`), which is what stops the *voice* agent cold-starting too.
- Nothing here throws. A failed embedding still writes the memory unembedded; a failed write logs and returns false.

### `server/checkpoints.ts` — thread state and crash recovery

`checkpoints`: one document per transition, in LangGraph's MongoDB checkpointer shape — `threadId` (the claim id) + `checkpointId` + `parentCheckpointId`, appended and never overwritten.

- **This is not `sessions.ts`.** A session snapshot is the *latest* state, overwritten in place, and is what the UI history list reads. A checkpoint is the *sequence*. Both are written on every `persistClaim`.
- `persistClaim(claim, reason)` labels each checkpoint by what happened (`advance`, `contact_dispatched`, `reply_resolved`, `awaiting_approval`, `finalized`, `stopped`, `claim_loaded`, `restored`), so the lineage reads as agent actions rather than undifferentiated writes.
- **`recoverOnBoot()` runs before the listener opens.** It restores the newest non-terminal checkpoint *only when there is no live claim* — an existing `claims:active` is newer than any checkpoint by definition and must never be clobbered. It refuses to resume a thread whose newest checkpoint is a `stopped`, so an operator disconnect is not undone by a deploy.
- **Recovery re-sends nothing.** It restores the claim, `claims:awaiting`, and the channel reverse-index key (with its 48h TTL) so a reply arriving after the restart still resolves. Re-dialling a policyholder on every deploy would be the worst possible failure mode. Progression still waits for the webhook.
- `restoreCheckpoint(id)` is the same machinery pointed at an arbitrary transition — an auditable rewind. Also sends nothing.
- On the ephemeral dev mongod there is never anything to recover, because the database died with the process. The boot log says so explicitly rather than staying silent.

### `server/channels/*` — outbound adapters

All three follow the same contract: **they hold no claim state, never throw, and expose `isLive()`**. They return result objects and let the caller decide what to persist or retry. Persistence and orchestration are deliberately *not* their job. (They are not literally stateless — `email.ts` memoizes its MCP connection and `elevenlabs.ts` memoizes its SDK client — but that state is transport-level only, never per-claim.)

- `sendblue.ts` — SMS/iMessage. Exports `sendSms()`, `parseInboundWebhook()`, and `normalizePhone()`. **Every phone number on both the outbound and inbound side must pass through `normalizePhone()`** — the reverse index is keyed on the number, and Sendblue's reported `from_number` routinely differs from what you dialed in punctuation or country code. The dedupe key prefers the provider's `message_handle` when the payload carries one and only falls back to a hash of (sender, timestamp, content) when it does not — two identical messages in the same second would collide on that fallback path.
- `elevenlabs.ts` — outbound voice via ElevenLabs Conversational AI. Exports `placeCall()`, `getConversation()`, `verifyWebhookSignature()`, `parseCallWebhook()`. The Twilio number is bound *inside the ElevenLabs workspace*; this app never talks to Twilio. `conversationId` is the reverse-index key. Signature verification is Stripe-style `t=…,v0=…` HMAC-SHA256 over `<timestamp>.<rawBody>` with a 30-minute replay window, compared with `timingSafeEqual`. It **fails closed only when `ELEVENLABS_WEBHOOK_SECRET` is set** — unset means accept-and-warn, so the mock demo runs without a secret.
- `email.ts` — email through a remote **Composio MCP server**. There is no fixed REST contract: the adapter connects, lists tools, and picks a send-email tool by known name then fuzzy match, then maps `{to, subject, body}` onto whatever input schema it discovers. The connection is memoized; any failure clears the memo so the next send reconnects. Two `ASSUMPTION TO VERIFY` comments in this file (auth header form, field-name aliases) are unconfirmed against a live Composio account — the discovered input schema is logged on first connect so a human can correct `mapEmailArgs`.

### `server/llm.ts` — the language model

**OpenAI** via the `openai` SDK, Responses API, Structured Outputs in **strict mode**. This is the single shared model module: `server.ts` and `orchestrator.ts` both import from it, replacing the client factory and retry helper each of them used to carry privately. Do not add a third copy.

Exports `isLlmConfigured()`, `getLlmClient()`, `modelName()`, `generateJson()`, plus the schema builders `strictObject()` / `nullable()` / `arrayOf()` / `str` / `num` / `int`. Model comes from `OPENAI_MODEL`, defaulting to `gpt-5.6`.

**STRICT MODE HAS NO OPTIONAL KEYS — this is the trap.** Every property must appear in `required`, and `additionalProperties` must be `false`. Optionality is expressed as a *union with null*, not by omission. That is the entire reason `strictObject()` (which auto-fills `required` from the property list) and `nullable()` (which turns `type: 'string'` into `type: ['string','null']`) exist. It is also why `custom-create`'s schema declares `techType` and `chatLog` as `nullable(...)`: they are genuinely optional on `SubStep`, so strict mode requires them present-and-nullable, and you must expect `null` rather than absence when reading the result.

**A schema that violates strict mode fails quietly.** OpenAI rejects it at request time with a 400; `generateJson()` treats a 400 as non-transient, so it does not retry, logs to `console.error` (**not** to `store.log`, so it never appears on the dashboard), and returns `null`. Every caller treats `null` as "use the canned fallback". Net effect: synthesis silently degrades to pre-written text and the app looks like it is working. **If model output has mysteriously stopped being dynamic, check the server console for `[llm]` errors before anything else.**

`generateJson()` returns `null` on *every* failure path — no client, empty response, unparseable JSON, or exhausted retries (4 attempts, exponential backoff, retrying only 429/5xx/network). Callers must handle `null`; none of them should throw.

### MOCK_MODE

Every channel degrades to a logged synthetic send when its credentials are absent, so the app runs as a pure demo with zero configuration. `MOCK_MODE=true` forces mock even when credentials exist. `isLive()` per adapter is the single source of truth; it is surfaced to the UI as a `VendorStatus` object and rendered as per-channel LIVE/MOCK pills in the header. **A channel is live only when *all* of its credentials are present** (three for Sendblue, three for ElevenLabs, two for Composio).

**MOCK_MODE gates embeddings as well as generation.** `isLlmConfigured()` is what `memory.ts` checks before embedding, so under MOCK_MODE no memory text is sent to OpenAI and recall runs in keyword mode. Preserve that: a switch that promises nothing leaves the machine cannot make an exception for embeddings.

**MOCK_MODE gates the language model too, not just the outbound channels** — and that matters because claim text (claimant names, loss descriptions, dollar amounts) is sent to OpenAI on every synthesis call, so "nothing leaves this machine" would be false otherwise. `isLlmConfigured()` returns `false` under `MOCK_MODE`, and `getLlmClient()` checks it **before** consulting its memoized client, so flipping MOCK_MODE on takes effect even after a client already exists and the header pill can never disagree with the actual egress path. Preserve both properties if you touch `llm.ts`.

When touching a channel, assume the reader cannot tell which mode they are in — keep the `[Sendblue][MOCK]` / `[voice][MOCK]` / `[Email][MOCK]` log prefixes and the pills accurate.

### Claim progression model

The orchestrator walks the active claim's `timeline`, one `TimelineStep` at a time, and within a step one `SubStep` at a time:

`classifyChannel(sub)` decides which of the two a sub-step is, and it is **not a simple type lookup**:

1. `type === 'sms'` → `sms`; `type === 'phone'` → `call`.
2. Otherwise a **regex over `techType + systemName + description`** (`/\be-?mails?\b|\binbox\b|\bmailbox\b/`) → `email`. `SubStepType` has no `email` member, so this heuristic is the only way an email contact can be recognized.
3. Otherwise `null` → internal.

Consequences worth knowing: any type other than `sms`/`phone` — including `custom` — is internal *unless its text mentions mail*, so a `tool` sub-step described as "emails the authorization" becomes a **blocking** contact. The shipped `DEFAULT_CLAIMS` contain no such text, but model-authored timelines from `custom-create` are not constrained.

- **Internal sub-steps** (`classifyChannel` → `null`) resolve immediately and progression continues.
- **Contact sub-steps** (`sms` / `call` / `email`) fire the outbound send, set `contactStatus: 'awaiting_reply'`, write the `claims:awaiting` key plus a `claims:lookup:{channel}:{value}` reverse index, and then **stop**. Nothing advances until an inbound webhook resolves that lookup. Note there is **no inbound email webhook**, so an `email` contact can only ever be cleared by force-advance.
- **The settlement is gated on a human.** The final payout does not auto-fire: the claim parks in status `AWAITING_APPROVAL` until an adjuster calls `POST /api/claims/approve-payout`. Do not add a code path that pays out without that call.

`POST /api/claims/process-step` **changed meaning**: it is now a force-advance / skip-the-wait override for demos and testing, not the normal path. Do not treat it as the progression mechanism.

### Reply provenance (`SubStep.replySource`)

The timeline is a **record of what the agent actually did**, so a reply's origin has to be visible. `replySource` is `'inbound' | 'synthesized' | 'fixture'`:

- `'inbound'` — a real provider webhook delivered it. **May only be passed by a genuine webhook handler.**
- `'synthesized'` — invented by the model or the canned fallback on the force-advance path. Nobody was contacted.
- `'fixture'` — authored `chatLog` content that shipped with the claim template. `markFixtureProvenance()` stamps these on first advance, guarded on `version === 0` so a real dispatch can never be relabelled a fixture on a later pass.
- **Absent means untrusted, and the UI renders it as not-real.** This is deliberate: the field is optional with *no default*, because defaulting to `'inbound'` would let a caller that forgot to say silently over-claim that a real person replied — the exact error the field exists to prevent. `resolveAwaitingSubStep` logs an ERROR when a caller omits it.

This existed because template `chatLog` fixtures previously rendered identically to real inbound replies, which made a pure demo indistinguishable from a live run. When adding any new path that writes a `chatLog`, set `replySource` explicitly.

### Idempotency and concurrency invariants

Webhooks arrive more than once, and a webhook can land while a human is clicking. Two mechanisms, both required:

1. **Dedupe** — every webhook event carries a stable `eventId`; `store.markEventSeen(eventId)` returning `false` means drop it. The `eventId` derivations are deliberately deterministic (no `Date.now()`), because a vendor's retry of the same delivery must hash to the same id. **They must also be unique per run**: the force-advance id includes `claim.sessionId`, because claim ids come from templates and `claim.version` restarts at 0 on every load, so without it a second run of the same template regenerates run 1's ids and every force-advance 409s.
2. **Mutex** — claim mutations run inside `orchestrator.withClaimLock(claimId, fn)`, which wraps `store.withLock()` on `claims:lock:{claimId}` (a document in the `locks` collection). **`withLock` returns `null` without running the function when the lock is held** — callers must handle that, not assume success.
**`Claim.version` is NOT a third mechanism.** `persistClaim` (`orchestrator.ts`) bumps it on every write, but **nothing ever reads or compares it** — there is no compare-and-set, and `store.set(..., force=true)` overwrites unconditionally. It is a monotonic write counter (and an entropy source for force-advance `eventId`s), useful for debugging and for the UI to notice staleness. It is *not* a concurrency guard, so **the mutex is the only thing preventing a clobber** — never skip the lock on the assumption that version will catch it.

### API surface

- `/api/mongo/keys` `/logs` `/pubsub` `/stats` `/cmd` — the debug dashboard. `/cmd` runs `executeCLI()`, which keeps the key/value vocabulary the Redis-era dashboard had (`PING GET SET(EX) DEL KEYS TTL EXPIRE LPUSH LRANGE PUBLISH LOCK UNLOCK FLUSHALL INFO`) and adds three MongoDB-native verbs: `COLLECTIONS`, `COUNT <collection> [{filter}]`, `FIND <collection> [{filter}] [limit]`. Its output strings (`(nil)`, `(empty array)`, `(integer) N`, `(error) ERR …`) are rendered raw by the frontend — do not reformat them.
  **`COUNT`/`FIND` parse their filter off the raw command line, not from `args`.** The CLI's quote parser strips double quotes, which would turn `{"reason":"restored"}` into `{reason:restored}`; `parseQueryCommand()` takes everything between the first `{` and the last `}` instead. Don't route them back through `args`.
- `/api/agent/memory` (GET; returns `{status, memories}`) and `/api/agent/memory/forget` (POST). **Forget is deliberately separate from `FLUSHALL`** — clearing claim state and making the agent forget everything it has ever learned are different decisions.
- `/api/agent/checkpoints` (GET, optional `threadId`) and `POST /api/claims/checkpoints/:checkpointId/restore`.
- `/api/claims/templates` `/active` `/load` `/process-step` `/custom-create` — claim UI. `/active` returns the claim plus `awaiting` and `vendorStatus`. `custom-create` asks the model to synthesize a whole new timeline and 400s without `OPENAI_API_KEY`; it has **no UI client** (see Known gaps).
- `POST /api/claims/approve-payout` — the human approval gate.
- Webhooks, registered by `registerWebhookRoutes(app)` in `server/webhooks.ts`: `POST /webhooks/sendblue/inbound`, `POST /webhooks/elevenlabs/call-started` (both `express.json()`), and `POST /webhooks/elevenlabs/transcript` + `POST /webhooks/elevenlabs/callback` (both `express.raw`, both HMAC-verified).
  **MOUNT ORDER IS LOAD-BEARING.** The verified routes HMAC over the exact request bytes, and Express body parsers are first-one-wins. `registerWebhookRoutes(app)` must be called **before** `app.use(express.json())` in `server.ts`, or the raw body is gone and no signature can ever match. Do not reorder those two lines.

### Client (`src/`)

- `App.tsx` — single stateful root: holds the active `Claim`, polls `/api/mongo/*` + `/api/claims/active` every 2.5s, renders the vendor LIVE/MOCK pills, and switches between the claim list and the timeline view.
- `components/ClaimList.tsx` — template picker.
- `components/ClaimTimeline.tsx` — timeline, sub-steps, chat logs, waiting/approval states.
- `components/MongoDashboard.tsx` — documents/TTL/locks, command log, pub/sub feed, stats, a CLI input hitting `/api/mongo/cmd`, plus the agent-memory panel (with a VECTOR/KEYWORD pill reporting which recall path is live) and the checkpoint lineage with per-transition restore.
- `types.ts` — shared contracts used by **both** server and client (`server.ts` imports from `./src/types.js`). Changing a type here changes the wire format; check both sides.
- Path alias `@/*` maps to the repo root (`tsconfig.json` / `vite.config.ts`).

## Gotchas

- **`retry.ts`** (`withRetry`) exists but is unused. Model retries now live in `llm.ts`'s `generateJson()`, and each channel adapter still has its own backoff. Consolidating the remaining copies is fine; just do it deliberately.
- **`vite.config.ts` disables HMR and file watching when `DISABLE_HMR=true`.** This is intentional, set by the AI Studio environment to prevent flickering during agent-driven edits. Do not "fix" or remove it.
- **Sendblue free tier forbids cold outbound.** The recipient must have texted the Sendblue number first. A failed live send with no obvious cause is usually this, not a bug in the adapter.
- **The ephemeral MongoDB loses everything on restart.** If state "randomly resets", if checkpoint recovery never finds anything, or if memory recall is always empty across runs, check whether `MONGODB_URI` is set. All three symptoms have that one cause.
- **Never commit `.env`.** It is gitignored (`.env*` with `!.env.example`). Rotate any credential that has been pasted into a chat or terminal transcript.

## Deliberate scope limits

These are cuts, not bugs. Don't "fix" them without asking:

- **Exactly one active claim** (`claims:active`) with **one outstanding contact at a time**. There is no per-claim keyspace and no concurrent-contact fan-out.
- **No retry/reminder scheduler.** If a reply never arrives, the claim sits in `awaiting_reply` indefinitely until someone force-advances it via `/api/claims/process-step`. Adding timeouts means adding a scheduler, which does not exist yet.
- **Memory is never pruned or consolidated.** `agent_memory` only grows; `recallCount`/`lastRecalledAt` are tracked but nothing acts on them. Forgetting is a manual `POST /api/agent/memory/forget`.
- **Checkpoints are trimmed to 200 per thread**, oldest first. Enough to rewind a whole claim, bounded so the collection cannot grow forever — but it means a very long thread's earliest transitions are not restorable.
- **No change streams.** The zero-config dev path is a standalone mongod, so pub/sub is the capped-collection tail instead. Moving to change streams means requiring a replica set everywhere.
- **Claim data is still fictional.** There is no policy system of record behind it.

## Known gaps

- **`PUBLIC_WEBHOOK_BASE` is read by no code at all.** It exists in `.env.example` as a place to record your tunnel URL, nothing more. Nothing builds callback URLs from it: `sendSms()` accepts a `statusCallback` the orchestrator never passes, and the ElevenLabs webhook target is configured in that vendor's dashboard rather than sent per-call. **Setting it has zero runtime effect** — pasting the URL into each vendor's dashboard is what actually makes inbound work.
- **`POST /api/agent/memory/forget` has no UI client.** The memory and checkpoint panels on the MongoDB page are read-only apart from checkpoint restore; forgetting everything the agent has learned is curl-only on purpose.
- **`POST /api/claims/custom-create` has no UI client.** `grep -rn custom-create src/` returns nothing — it is reachable only by curl. This was a deliberate omission, not an oversight; don't assume a button exists somewhere.
