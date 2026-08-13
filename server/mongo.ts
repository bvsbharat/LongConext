/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Real MongoDB-backed state store. This replaced the earlier Redis (`ioredis`) store and
 * keeps the *same public method surface*, so `orchestrator.ts`, `sessions.ts`, `webhooks.ts`
 * and `server.ts` were unchanged apart from the import and the singleton's name.
 *
 * Storage design
 * --------------
 * One document per app key in the `kv` collection, `_id` being the key string:
 *
 *   { _id, type, value, locked, expiresAt, updatedAt }
 *
 * `type` is the *logical* shape of `value`, and unlike the Redis version it is not a
 * different physical storage per type -- BSON already stores all four natively:
 *   - `string`   -> a BSON string
 *   - `array`    -> a BSON array, head-first (index 0 is the LPUSH end)
 *   - `set`      -> a BSON array with duplicate members removed
 *   - `document` -> a real nested BSON subdocument
 *
 * `document` is the reason for the migration. Redis has no nested value type, so a `Claim`
 * had to be JSON-encoded into a Redis string and parsed back on every read. Here the claim
 * is stored as the document it actually is, which is also why `_id`-scoped queries can
 * reach into it (`FIND kv {"value.status":"AWAITING_APPROVAL"}`).
 *
 * The three bookkeeping concerns live in their own collections rather than a key prefix, so
 * they can never leak into the dashboard the way `__meta__:`/`__mutex__:`/`__seen__:` could:
 *   - `locks`  real mutexes  (acquireLock/releaseLock/withLock)
 *   - `events` webhook dedupe (markEventSeen)
 *   - `pubsub` a capped collection that is *tailed* to implement publish/subscribe
 *
 * Expiry
 * ------
 * Two mechanisms, deliberately overlapping. A TTL index on `expiresAt`
 * (`expireAfterSeconds: 0`) is what actually keeps the collection clean, but mongod's TTL
 * monitor only runs about once a minute -- far too coarse for `claims:lookup:*`, whose whole
 * job is to stop matching once it lapses. So:
 *   1. every read filters expired documents out, making expiry *exact* from the app's view;
 *   2. an in-process sweeper (1s) deletes lapsed documents and emits the
 *      "Key X expired by TTL" log line plus `KEY_EXPIRED:` on pub/sub. This is the direct
 *      replacement for Redis keyspace expiry notifications, which MongoDB has no analogue of.
 *
 * Pub/sub
 * -------
 * MongoDB change streams would be the obvious fit but they require a replica set, and the
 * zero-config dev path here is a *standalone* mongod. A capped collection with a tailable,
 * awaitData cursor works on both standalone and Atlas, so that is what `publish()` writes to
 * and what the tail loop reads. The tail loop is the equivalent of the old dedicated Redis
 * subscriber connection: it feeds the in-process log and pub/sub buffers.
 */

import { BSON, Collection, Db, MongoClient, ObjectId } from 'mongodb';
import { DbKeyInfo, DbLog, DbPubSubMsg, DbStats } from '../src/types.js';

const KV = 'kv';
const LOCKS = 'locks';
const EVENTS = 'events';
const PUBSUB = 'pubsub';

const PUBSUB_CHANNEL = 'claims:pubsub';
const PUBSUB_CAP_BYTES = 1024 * 1024;
const PUBSUB_CAP_DOCS = 5000;
const MAX_LOGS = 250;
const MAX_PUBSUB = 150;
const SWEEP_INTERVAL_MS = 1000;

/**
 * mongodb-memory-server resolves a download URL from the host OS, and the newest builds are
 * not published for every distro/arch pair (notably linux-aarch64/debian12, which 404s). Pin
 * a combination that is, and let a real deployment override it.
 */
const EPHEMERAL_VERSION = process.env.MONGOMS_VERSION || '7.0.14';

type KeyType = 'string' | 'array' | 'set' | 'document';
type LogLevel = 'INFO' | 'COMMAND' | 'ERROR' | 'PUB_SUB';

interface KvDoc {
  _id: string;
  type: KeyType;
  value: any;
  locked: boolean;
  expiresAt: Date | null;
  updatedAt: Date;
}

interface LockDoc {
  _id: string;
  token: string;
  expiresAt: Date;
}

interface SeenDoc {
  _id: string;
  expiresAt: Date;
}

interface PubSubDoc {
  _id: ObjectId;
  channel?: string;
  message?: string;
  init?: boolean;
}

const DUPLICATE_KEY = 11000;

const isDuplicateKey = (err: any): boolean => err?.code === DUPLICATE_KEY;

const expired = (doc: { expiresAt?: Date | null } | null, now = new Date()): boolean =>
  !!doc?.expiresAt && doc.expiresAt.getTime() <= now.getTime();

export class MongoStore {
  private client!: MongoClient;
  private database!: Db;
  private kv!: Collection<KvDoc>;
  private locks!: Collection<LockDoc>;
  private events!: Collection<SeenDoc>;
  private pubsubCol!: Collection<PubSubDoc>;

  private ephemeral: { stop(): Promise<boolean> } | null = null;
  private ready = false;
  private initPromise: Promise<void> | null = null;
  private dbName = 'conquer';
  private sweeper: NodeJS.Timeout | null = null;
  private lastPubSubId: ObjectId | null = null;

  // Rolling in-process buffers. The REST handlers poll these synchronously, so they
  // must never become promises. They are fed by the capped-collection tail loop.
  private logs: DbLog[] = [];
  private pubsub: DbPubSubMsg[] = [];

  private stats = {
    uptimeStart: Date.now(),
    operationsProcessed: 0,
  };

  // ---------------------------------------------------------------- lifecycle

  /** Connects, creates indexes and starts the tail loop. Safe to call more than once. */
  async initDb(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.connect().catch(err => {
        this.initPromise = null; // allow a later retry
        throw err;
      });
    }
    return this.initPromise;
  }

  isReady(): boolean {
    return this.ready;
  }

  /** Quick liveness probe. Fails fast rather than hanging on a closed port. */
  private static async probe(uri: string, timeoutMs = 1200): Promise<boolean> {
    const probe = new MongoClient(uri, {
      serverSelectionTimeoutMS: timeoutMs,
      connectTimeoutMS: timeoutMs,
    });
    try {
      await probe.connect();
      await probe.db('admin').command({ ping: 1 });
      return true;
    } catch {
      return false;
    } finally {
      await probe.close().catch(() => {});
    }
  }

  /**
   * Resolution order, most explicit first:
   *   1. MONGODB_URI (MONGO_URL is accepted too -- Railway's MongoDB plugin injects that name)
   *   2. a mongod already running locally on 27017
   *   3. an ephemeral one via mongodb-memory-server
   *
   * (3) downloads a mongod build for the current OS/arch on first use, so it needs network
   * access once and is the last resort rather than the default. Its failure produces an
   * actionable message rather than a stack trace.
   */
  private async connect(): Promise<void> {
    const uri = process.env.MONGODB_URI || process.env.MONGO_URL;
    const options = { ignoreUndefined: true };

    if (uri) {
      this.client = new MongoClient(uri, options);
      await this.client.connect();
      this.dbName = resolveDbName(uri);
      console.log(`Mongo: connected to MONGODB_URI (database "${this.dbName}")`);
    } else if (await MongoStore.probe('mongodb://127.0.0.1:27017')) {
      this.client = new MongoClient('mongodb://127.0.0.1:27017', options);
      await this.client.connect();
      this.dbName = process.env.MONGODB_DB || 'conquer';
      console.log(`Mongo: connected to the local mongod on 127.0.0.1:27017 (database "${this.dbName}")`);
    } else if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'MONGODB_URI is required in production - refusing to start an ephemeral in-memory MongoDB'
      );
    } else {
      try {
        const { MongoMemoryServer } = await import('mongodb-memory-server');
        const server = await MongoMemoryServer.create({
          binary: {
            version: EPHEMERAL_VERSION,
            // linux-aarch64 has no debian12 build for recent versions; ubuntu 22.04 does.
            ...(process.platform === 'linux'
              ? { os: { os: 'linux', dist: 'ubuntu', release: '22.04' } }
              : {}),
          },
        });
        this.ephemeral = server;
        const ephemeralUri = server.getUri();
        this.client = new MongoClient(ephemeralUri, options);
        await this.client.connect();
        this.dbName = process.env.MONGODB_DB || 'conquer';
        console.log(
          `Mongo: started an ephemeral dev instance at ${ephemeralUri} (database "${this.dbName}"). ` +
            'State is lost when this process exits - set MONGODB_URI, or run a local mongod, to keep it.'
        );
      } catch (err: any) {
        throw new Error(
          `Could not obtain a MongoDB to connect to.\n\n` +
            `  Fix, in order of preference:\n` +
            `    1. Point MONGODB_URI at any reachable MongoDB (Atlas free tier works):\n` +
            `         MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/conquer\n` +
            `    2. Run a local mongod and the app will find it on 127.0.0.1:27017:\n` +
            `         macOS:  brew tap mongodb/brew && brew install mongodb-community && brew services start mongodb-community\n` +
            `         Docker: docker run -d -p 27017:27017 mongo:7\n` +
            `    3. Let mongodb-memory-server download a mongod (needs network access once;\n` +
            `       pin a published build with MONGOMS_VERSION if the download 404s).\n\n` +
            `  Options 1 and 2 are also what you want long term: an ephemeral MongoDB loses\n` +
            `  every claim when the process exits.\n\n` +
            `  Underlying error: ${err?.message || err}\n`
        );
      }
    }

    this.client.on('error', err => {
      console.error('[Mongo] connection error:', (err as any)?.message || err);
    });

    this.database = this.client.db(this.dbName);
    this.kv = this.database.collection<KvDoc>(KV);
    this.locks = this.database.collection<LockDoc>(LOCKS);
    this.events = this.database.collection<SeenDoc>(EVENTS);

    await this.ensureSchema();

    this.ready = true;
    this.startTail();
    this.startSweeper();
    await this.seedDefaults();
  }

  /**
   * TTL indexes plus the capped pub/sub collection. `expireAfterSeconds: 0` means "delete
   * when `expiresAt` has passed"; documents whose `expiresAt` is null are ignored by the TTL
   * monitor, which is exactly what a persistent key needs.
   */
  private async ensureSchema(): Promise<void> {
    await Promise.all([
      this.kv.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      this.locks.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      this.events.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    ]);

    try {
      await this.database.createCollection(PUBSUB, {
        capped: true,
        size: PUBSUB_CAP_BYTES,
        max: PUBSUB_CAP_DOCS,
      });
    } catch (err: any) {
      // NamespaceExists (48) just means a previous run already created it.
      if (err?.code !== 48) throw err;
    }
    this.pubsubCol = this.database.collection<PubSubDoc>(PUBSUB);

    // A tailable cursor over an *empty* capped collection dies immediately, so keep one
    // sentinel document in there. The tail loop skips it.
    if ((await this.pubsubCol.estimatedDocumentCount()) === 0) {
      await this.pubsubCol.insertOne({ _id: new ObjectId(), init: true });
    }
    const newest = await this.pubsubCol.find({}).sort({ _id: -1 }).limit(1).next();
    this.lastPubSubId = newest?._id ?? null;
  }

  /** Closes the client (and the ephemeral server, if we started one). */
  async close(): Promise<void> {
    this.ready = false;
    this.initPromise = null;
    if (this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
    await this.client?.close().catch(() => {});
    if (this.ephemeral) {
      await this.ephemeral.stop();
      this.ephemeral = null;
    }
  }

  // ------------------------------------------------------------ tail + sweeper

  /**
   * The subscriber half of pub/sub: a tailable, awaitData cursor over the capped `pubsub`
   * collection, resumed from the last `_id` seen so a dead cursor never replays or skips.
   */
  private startTail(): void {
    void (async () => {
      while (this.ready) {
        try {
          const filter = this.lastPubSubId ? { _id: { $gt: this.lastPubSubId } } : {};
          const cursor = this.pubsubCol.find(filter, {
            tailable: true,
            awaitData: true,
            maxAwaitTimeMS: 1000,
          });
          for await (const doc of cursor) {
            this.lastPubSubId = doc._id;
            if (doc.init || !doc.channel) continue;
            this.onMessage(doc.channel, doc.message ?? '');
          }
        } catch (err: any) {
          if (!this.ready) return;
          this.log('ERROR', `pub/sub tail restarting: ${err?.message || err}`);
        }
        await sleep(250);
      }
    })();
  }

  /**
   * Exact expiry. mongod's own TTL monitor runs roughly once a minute, which would leave a
   * lapsed `claims:lookup:*` matching for up to a minute; this closes that window and emits
   * the log/pub-sub lines that Redis keyspace notifications used to provide.
   */
  private startSweeper(): void {
    this.sweeper = setInterval(() => {
      void this.sweepExpired();
    }, SWEEP_INTERVAL_MS);
    this.sweeper.unref?.();
  }

  private async sweepExpired(): Promise<void> {
    if (!this.ready) return;
    try {
      const now = new Date();
      const lapsed = await this.kv
        .find({ expiresAt: { $ne: null, $lte: now } }, { projection: { _id: 1 } })
        .toArray();
      for (const doc of lapsed) {
        const removed = await this.kv.deleteOne({ _id: doc._id, expiresAt: { $lte: now } });
        if (removed.deletedCount === 0) continue;
        this.log('INFO', `Key ${doc._id} expired by TTL`);
        await this.publish(PUBSUB_CHANNEL, `KEY_EXPIRED:${doc._id}`);
      }
    } catch (err: any) {
      if (this.ready) this.log('ERROR', `TTL sweep failed: ${err?.message || err}`);
    }
  }

  private onMessage(channel: string, message: string): void {
    this.pubsub.unshift({
      timestamp: new Date().toLocaleTimeString(),
      channel,
      message,
    });
    if (this.pubsub.length > MAX_PUBSUB) this.pubsub.pop();
    this.log('PUB_SUB', `Channel [${channel}] published message: "${message}"`);
  }

  private assertReady(): void {
    if (!this.ready) throw new Error('MongoDB is not connected - call initDb() first');
  }

  /**
   * Escape hatch out of the key/value facade, for the layers that want MongoDB as MongoDB:
   * `memory.ts` (semantic recall over `agent_memory`) and `checkpoints.ts` (thread-scoped
   * state lineage). Those are queried and indexed as real collections, so wrapping them in
   * `get`/`set` would throw away exactly the capability they exist to use.
   */
  collection<T extends object = any>(name: string): Collection<T> {
    this.assertReady();
    return this.database.collection<T>(name);
  }

  dbLabel(): string {
    return this.dbName;
  }

  /**
   * Whether the connection points at Atlas. Vector Search and `createSearchIndex` only exist
   * there, so the memory layer uses this to decide whether to even attempt them.
   */
  isAtlas(): boolean {
    const uri = process.env.MONGODB_URI || process.env.MONGO_URL || '';
    return uri.startsWith('mongodb+srv://') || uri.includes('mongodb.net');
  }

  // ------------------------------------------------------------ observability

  log(level: LogLevel, msg: string): void {
    this.logs.unshift({
      timestamp: new Date().toLocaleTimeString(),
      level,
      msg,
    });
    // Keep logs size reasonable
    if (this.logs.length > MAX_LOGS) this.logs.pop();
  }

  /** Fire-and-forget friendly: callers may `await` it or not. */
  async publish(channel: string, message: string): Promise<void> {
    if (!this.ready) return;
    try {
      await this.pubsubCol.insertOne({ _id: new ObjectId(), channel, message });
    } catch (err: any) {
      this.log('ERROR', `PUBLISH ${channel} failed: ${err?.message || err}`);
    }
  }

  getLogs(): DbLog[] {
    return this.logs;
  }

  getPubSub(): DbPubSubMsg[] {
    return this.pubsub;
  }

  // ------------------------------------------------------------- value shaping

  /** Coerces an incoming value into the BSON shape its logical type promises. */
  private static encode(value: any, type: KeyType): any {
    if (type === 'array' || type === 'set') {
      const members = (Array.isArray(value) ? value : [value]).map(v =>
        typeof v === 'string' ? v : JSON.stringify(v)
      );
      return type === 'set' ? Array.from(new Set(members)) : members;
    }
    if (type === 'document') return value;
    // 'string' keeps real strings verbatim; anything else is JSON so it round-trips.
    return typeof value === 'string' ? value : JSON.stringify(value);
  }

  /** Reads a live (non-expired) document, or null. */
  private async read(key: string): Promise<KvDoc | null> {
    const doc = await this.kv.findOne({ _id: key });
    return doc && !expired(doc) ? doc : null;
  }

  // ------------------------------------------------------------- core commands

  async set(
    key: string,
    value: any,
    type: KeyType = 'string',
    ttlSeconds?: number,
    force: boolean = false
  ): Promise<string> {
    this.assertReady();
    this.stats.operationsProcessed++;

    const live = await this.read(key);
    if (live?.locked && !force) {
      throw new Error(`KEY LOCKED - State "${key}" is currently locked by a live transaction`);
    }

    // Force-writing a locked key leaves it locked; any other write clears the flag.
    const keepLocked = live && force ? !!live.locked : false;

    await this.kv.replaceOne(
      { _id: key },
      {
        type,
        value: MongoStore.encode(value, type),
        locked: keepLocked,
        expiresAt: ttlSeconds ? new Date(Date.now() + ttlSeconds * 1000) : null,
        updatedAt: new Date(),
      } as KvDoc,
      { upsert: true }
    );

    this.log('COMMAND', `SET ${key} -> Type: ${type}`);
    await this.publish(PUBSUB_CHANNEL, `KEY_SET:${key}:${type}`);
    return 'OK';
  }

  async get(key: string): Promise<any> {
    this.assertReady();
    this.stats.operationsProcessed++;
    const doc = await this.read(key);
    return doc ? (doc.value ?? null) : null;
  }

  async lock(key: string): Promise<boolean> {
    this.assertReady();
    const res = await this.kv.updateOne({ _id: key }, { $set: { locked: true } });
    if (res.matchedCount === 0) return false;
    this.log('COMMAND', `LOCK ${key}`);
    await this.publish(PUBSUB_CHANNEL, `KEY_LOCKED:${key}`);
    return true;
  }

  async unlock(key: string): Promise<boolean> {
    this.assertReady();
    const res = await this.kv.updateOne({ _id: key }, { $set: { locked: false } });
    if (res.matchedCount === 0) return false;
    this.log('COMMAND', `UNLOCK ${key}`);
    await this.publish(PUBSUB_CHANNEL, `KEY_UNLOCKED:${key}`);
    return true;
  }

  async del(key: string): Promise<boolean> {
    this.assertReady();
    this.stats.operationsProcessed++;

    const live = await this.read(key);
    if (live?.locked) {
      throw new Error(`KEY LOCKED - Cannot delete locked key "${key}"`);
    }

    const removed = await this.kv.deleteOne({ _id: key });
    const existed = removed.deletedCount > 0;
    if (existed) {
      this.log('COMMAND', `DEL ${key}`);
      await this.publish(PUBSUB_CHANNEL, `KEY_DELETED:${key}`);
    }
    return existed;
  }

  /** Prepends to an `array` key, creating it if absent. Index 0 is the newest member. */
  async lpush(key: string, val: string): Promise<number> {
    this.assertReady();
    this.stats.operationsProcessed++;

    const live = await this.read(key);
    if (live && live.type !== 'array') {
      throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
    }

    const members = Array.isArray(live?.value) ? (live!.value as string[]) : [];
    members.unshift(val);

    await this.kv.replaceOne(
      { _id: key },
      {
        type: 'array',
        value: members,
        locked: live?.locked ?? false,
        expiresAt: live?.expiresAt ?? null,
        updatedAt: new Date(),
      } as KvDoc,
      { upsert: true }
    );

    this.log('COMMAND', `LPUSH ${key} -> Length: ${members.length}`);
    await this.publish(PUBSUB_CHANNEL, `KEY_LPUSH:${key}`);
    return members.length;
  }

  // ------------------------------------------------------------- introspection

  /** All live app keys. Bookkeeping lives in other collections, so nothing to filter. */
  private async liveDocs(): Promise<KvDoc[]> {
    const now = new Date();
    return this.kv.find({ $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] }).toArray();
  }

  private async scanKeys(): Promise<string[]> {
    const now = new Date();
    const docs = await this.kv
      .find({ $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] }, { projection: { _id: 1 } })
      .toArray();
    return docs.map(d => d._id);
  }

  async getKeysInfo(): Promise<DbKeyInfo[]> {
    this.assertReady();
    const now = Date.now();
    const docs = await this.liveDocs();

    const list: DbKeyInfo[] = docs.map(doc => ({
      key: doc._id,
      type: normalizeType(doc.type),
      value: stringifyValue(doc.value, doc.type),
      ttl: doc.expiresAt ? Math.max(0, Math.round((doc.expiresAt.getTime() - now) / 1000)) : null,
      // Real on-disk weight of the document, rather than the Redis version's estimate.
      size: BSON.calculateObjectSize(doc as any),
      locked: !!doc.locked,
    }));

    // Sort alphabetically by key
    return list.sort((a, b) => a.key.localeCompare(b.key));
  }

  async getStats(): Promise<DbStats> {
    this.assertReady();
    const uptimeSeconds = Math.round((Date.now() - this.stats.uptimeStart) / 1000);
    const [totalKeys, dataSize, connectedClients] = await Promise.all([
      this.kv.countDocuments({ $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] }),
      this.dataSize(),
      this.connectedClients(),
    ]);

    return {
      usedMemory: dataSize,
      totalKeys,
      uptimeSeconds,
      operationsProcessed: this.stats.operationsProcessed,
      connectedClients,
    };
  }

  /** Real `dbStats.dataSize`, falling back to summing BSON sizes if the command is denied. */
  private async dataSize(): Promise<number> {
    try {
      const stats: any = await this.database.command({ dbStats: 1 });
      return Math.round(stats?.dataSize ?? 0);
    } catch {
      const docs = await this.liveDocs();
      return docs.reduce((acc, d) => acc + BSON.calculateObjectSize(d as any), 0);
    }
  }

  /** `serverStatus` is restricted on some managed tiers, so treat a failure as "just us". */
  private async connectedClients(): Promise<number> {
    try {
      const status: any = await this.database.admin().command({ serverStatus: 1 });
      return status?.connections?.current ?? 1;
    } catch {
      return 1;
    }
  }

  // ------------------------------------------------------------ distributed primitives

  /**
   * Real mutex (distinct from the app-level `lock()` flag). Returns an ownership token, or
   * null when someone else holds the lock.
   *
   * The insert is the fast path; a duplicate key means a document exists, which is only
   * *actually* a held lock if it has not lapsed. `findOneAndUpdate` then steals a lapsed one
   * atomically, so two racing callers cannot both win it.
   */
  async acquireLock(name: string, ttlMs = 5000): Promise<string | null> {
    this.assertReady();
    this.stats.operationsProcessed++;
    const token = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const expiresAt = new Date(Date.now() + ttlMs);

    try {
      await this.locks.insertOne({ _id: name, token, expiresAt });
      return token;
    } catch (err: any) {
      if (!isDuplicateKey(err)) throw err;
      const stolen = await this.locks.findOneAndUpdate(
        { _id: name, expiresAt: { $lte: new Date() } },
        { $set: { token, expiresAt } }
      );
      return stolen ? token : null;
    }
  }

  /** Compare-and-delete, so a caller can never release a mutex it no longer owns. */
  async releaseLock(name: string, token: string): Promise<boolean> {
    this.assertReady();
    this.stats.operationsProcessed++;
    const res = await this.locks.deleteOne({ _id: name, token });
    return res.deletedCount === 1;
  }

  /** Runs `fn` under `name`, or returns null without running it if the lock is taken. */
  async withLock<T>(name: string, fn: () => Promise<T>, ttlMs = 5000): Promise<T | null> {
    const token = await this.acquireLock(name, ttlMs);
    if (!token) return null;
    try {
      return await fn();
    } finally {
      await this.releaseLock(name, token);
    }
  }

  /** Webhook-retry dedupe: true the first time `eventId` is seen, false afterwards. */
  async markEventSeen(eventId: string, ttlSeconds = 86400): Promise<boolean> {
    this.assertReady();
    this.stats.operationsProcessed++;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    try {
      await this.events.insertOne({ _id: eventId, expiresAt });
      return true;
    } catch (err: any) {
      if (!isDuplicateKey(err)) throw err;
      // Present but lapsed (the TTL monitor had not got to it yet) counts as unseen.
      const revived = await this.events.findOneAndUpdate(
        { _id: eventId, expiresAt: { $lte: new Date() } },
        { $set: { expiresAt } }
      );
      return !!revived;
    }
  }

  // ------------------------------------------------------------------ seeding

  private async writeDefault(key: string, value: string): Promise<void> {
    await this.kv.replaceOne(
      { _id: key },
      { type: 'string', value, locked: false, expiresAt: null, updatedAt: new Date() } as KvDoc,
      { upsert: true }
    );
  }

  private defaults(): Array<[string, string]> {
    return [
      ['claims:config:deductible', '500'],
      ['claims:config:automatic_approval_limit', '10000'],
      ['claims:config:sla_limit_hours', '72'],
      ['claims:locks:database', 'unlocked'],
      ['claims:active_id', 'null'],
    ];
  }

  /** Startup seeding: fills in missing config keys without touching existing state. */
  private async seedDefaults(): Promise<void> {
    for (const [key, value] of this.defaults()) {
      if ((await this.kv.countDocuments({ _id: key }, { limit: 1 })) === 0) {
        await this.writeDefault(key, value);
      }
    }
    this.log('INFO', `MongoDB "${this.dbName}" initialized with default configurations`);
  }

  /** Explicit reset (FLUSHALL / dashboard reset): wipes app state and re-seeds. */
  async resetToDefaults(): Promise<void> {
    this.assertReady();
    await Promise.all([
      this.kv.deleteMany({}),
      this.locks.deleteMany({}),
      this.events.deleteMany({}),
    ]);
    this.logs = [];
    this.pubsub = [];

    for (const [key, value] of this.defaults()) {
      await this.writeDefault(key, value);
    }

    this.log('INFO', `MongoDB "${this.dbName}" initialized with default configurations`);
  }

  // ---------------------------------------------------------------------- CLI
  //
  // The verb set is deliberately the same key/value vocabulary the Redis-era dashboard had
  // (GET/SET/DEL/KEYS/TTL/EXPIRE/LPUSH/LRANGE/PUBLISH/LOCK/UNLOCK/FLUSHALL/INFO/PING), plus
  // three MongoDB-native ones -- COLLECTIONS, COUNT, FIND -- so the collections underneath
  // the facade are actually inspectable. Output strings are rendered raw by the frontend, so
  // the `(nil)` / `(empty array)` / `(integer) N` / `(error) ERR ...` forms are load-bearing.

  async executeCLI(commandLine: string): Promise<string> {
    const trimmed = commandLine.trim();
    if (!trimmed) return '';

    // Simple quote parser for CLI arguments
    const args: string[] = [];
    let current = '';
    let inQuotes = false;
    let quoteChar = '';

    for (let i = 0; i < trimmed.length; i++) {
      const char = trimmed[i];
      if ((char === '"' || char === "'") && (i === 0 || trimmed[i - 1] !== '\\')) {
        if (inQuotes && char === quoteChar) {
          inQuotes = false;
        } else if (!inQuotes) {
          inQuotes = true;
          quoteChar = char;
        } else {
          current += char;
        }
      } else if (char === ' ' && !inQuotes) {
        if (current) {
          args.push(current);
          current = '';
        }
      } else {
        current += char;
      }
    }
    if (current) {
      args.push(current);
    }

    if (args.length === 0) return '(error) ERR empty command';

    const cmd = args[0].toUpperCase();
    this.stats.operationsProcessed++;

    try {
      switch (cmd) {
        case 'PING':
          await this.database.command({ ping: 1 });
          return 'PONG';

        case 'GET': {
          if (args.length < 2) return '(error) ERR wrong number of arguments for \'get\' command';
          const val = await this.get(args[1]);
          if (val === null) return '(nil)';
          return typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val);
        }

        case 'SET': {
          if (args.length < 3) return '(error) ERR wrong number of arguments for \'set\' command';
          const key = args[1];
          const value = args[2];
          let ttl: number | undefined;

          if (args.length >= 5 && args[3].toUpperCase() === 'EX') {
            ttl = parseInt(args[4], 10);
            if (isNaN(ttl)) return '(error) ERR value is not an integer or out of range';
          }

          await this.set(key, value, 'string', ttl);
          return 'OK';
        }

        case 'DEL': {
          if (args.length < 2) return '(error) ERR wrong number of arguments for \'del\' command';
          let count = 0;
          for (let i = 1; i < args.length; i++) {
            if (await this.del(args[i])) count++;
          }
          return `(integer) ${count}`;
        }

        case 'KEYS': {
          if (args.length < 2) return '(error) ERR wrong number of arguments for \'keys\' command';
          const pattern = args[1];
          const allKeys = await this.scanKeys();
          const filtered = allKeys.filter(k => {
            if (pattern === '*') return true;
            const regexStr = pattern.replace(/\*/g, '.*');
            return new RegExp(`^${regexStr}$`, 'i').test(k);
          }).sort((a, b) => a.localeCompare(b));

          if (filtered.length === 0) return '(empty array)';
          return filtered.map((k, idx) => `${idx + 1}) "${k}"`).join('\n');
        }

        case 'TTL': {
          if (args.length < 2) return '(error) ERR wrong number of arguments for \'ttl\' command';
          const doc = await this.read(args[1]);
          if (!doc) return '(integer) -2'; // missing
          if (!doc.expiresAt) return '(integer) -1'; // persistent
          return `(integer) ${Math.max(0, Math.round((doc.expiresAt.getTime() - Date.now()) / 1000))}`;
        }

        case 'EXPIRE': {
          if (args.length < 3) return '(error) ERR wrong number of arguments for \'expire\' command';
          const key = args[1];
          const seconds = parseInt(args[2], 10);
          if (isNaN(seconds)) return '(error) ERR value is not an integer or out of range';

          const applied = await this.kv.updateOne(
            { _id: key },
            { $set: { expiresAt: new Date(Date.now() + seconds * 1000) } }
          );
          if (applied.matchedCount === 0) return '(integer) 0';

          this.log('COMMAND', `EXPIRE ${key} -> TTL: ${seconds}s`);
          await this.publish(PUBSUB_CHANNEL, `KEY_EXPIRE:${key}`);
          return '(integer) 1';
        }

        case 'LPUSH': {
          if (args.length < 3) return '(error) ERR wrong number of arguments for \'lpush\' command';
          const len = await this.lpush(args[1], args[2]);
          return `(integer) ${len}`;
        }

        case 'LRANGE': {
          if (args.length < 4) return '(error) ERR wrong number of arguments for \'lrange\' command';
          const key = args[1];
          const start = parseInt(args[2], 10);
          const end = parseInt(args[3], 10);

          if (isNaN(start) || isNaN(end)) return '(error) ERR value is not an integer or out of range';

          const doc = await this.read(key);
          if (doc && doc.type !== 'array' && doc.type !== 'set') {
            return '(error) WRONGTYPE Operation against a key holding the wrong kind of value';
          }
          const members: string[] = Array.isArray(doc?.value) ? doc!.value : [];
          const slice = rangeSlice(members, start, end);
          if (slice.length === 0) return '(empty array)';
          return slice.map((v, idx) => `${idx + 1}) "${v}"`).join('\n');
        }

        case 'PUBLISH': {
          if (args.length < 3) return '(error) ERR wrong number of arguments for \'publish\' command';
          await this.publish(args[1], args[2]);
          return '(integer) 1';
        }

        case 'LOCK': {
          if (args.length < 2) return '(error) ERR wrong number of arguments for \'lock\' command';
          const locked = await this.lock(args[1]);
          return locked ? 'OK (KEY LOCKED)' : '(error) Key does not exist';
        }

        case 'UNLOCK': {
          if (args.length < 2) return '(error) ERR wrong number of arguments for \'unlock\' command';
          const unlocked = await this.unlock(args[1]);
          return unlocked ? 'OK (KEY UNLOCKED)' : '(error) Key does not exist';
        }

        case 'FLUSHALL':
          await this.resetToDefaults();
          return 'OK';

        case 'COLLECTIONS': {
          const names = await this.database.listCollections({}, { nameOnly: true }).toArray();
          const sorted = names.map(n => n.name).sort((a, b) => a.localeCompare(b));
          if (sorted.length === 0) return '(empty array)';
          const counts = await Promise.all(
            sorted.map(name => this.database.collection(name).estimatedDocumentCount())
          );
          return sorted.map((name, idx) => `${idx + 1}) "${name}" (${counts[idx]} docs)`).join('\n');
        }

        // COUNT and FIND take a JSON filter, so they are parsed off the RAW line rather
        // than from `args`: the quote parser above strips the double quotes that JSON needs,
        // which would turn {"reason":"restored"} into {reason:restored}.
        case 'COUNT': {
          const parsed = parseQueryCommand(trimmed, cmd);
          if (parsed instanceof Error) return `(error) ERR ${parsed.message}`;
          return `(integer) ${await this.database.collection(parsed.collection).countDocuments(parsed.filter)}`;
        }

        case 'FIND': {
          const parsed = parseQueryCommand(trimmed, cmd);
          if (parsed instanceof Error) return `(error) ERR ${parsed.message}`;
          const docs = await this.database
            .collection(parsed.collection)
            .find(parsed.filter)
            .limit(Math.min(Math.max(parsed.limit, 1), 50))
            .toArray();
          if (docs.length === 0) return '(empty array)';
          return JSON.stringify(docs, null, 2);
        }

        case 'INFO': {
          const stats = await this.getStats();
          const version = await this.serverVersion();
          return `# Server\nmongodb_version:${version}\ndatabase:${this.dbName}\nuptime_in_seconds:${stats.uptimeSeconds}\n\n# Clients\nconnected_clients:${stats.connectedClients}\n\n# Storage\ndata_size:${stats.usedMemory}\ndata_size_human:${(stats.usedMemory / 1024).toFixed(2)}K\n\n# Stats\ntotal_connections_received:1\ntotal_commands_processed:${stats.operationsProcessed}\n\n# Keyspace\n${KV}:keys=${stats.totalKeys}`;
        }

        default:
          return `(error) ERR unknown command '${cmd}'`;
      }
    } catch (err: any) {
      return `(error) ${err.message || 'System error'}`;
    }
  }

  private async serverVersion(): Promise<string> {
    try {
      const info: any = await this.database.admin().command({ buildInfo: 1 });
      return info?.version ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** The database name from a connection string's path, if it carries one. */
function resolveDbName(uri: string): string {
  if (process.env.MONGODB_DB) return process.env.MONGODB_DB;
  const withoutQuery = uri.split('?')[0];
  const path = withoutQuery.replace(/^mongodb(\+srv)?:\/\//, '').split('/')[1];
  return path && path.length > 0 ? decodeURIComponent(path) : 'conquer';
}

function normalizeType(type: string | undefined): KeyType {
  if (type === 'string' || type === 'array' || type === 'set' || type === 'document') return type;
  return 'string';
}

/** Dashboard rendering: strings stay raw, everything else becomes JSON text. */
function stringifyValue(value: any, type: KeyType): string {
  if (type === 'string') return typeof value === 'string' ? value : String(value ?? '');
  return JSON.stringify(value ?? null);
}

/** LRANGE semantics: inclusive bounds, negative indices counted from the end. */
function rangeSlice(members: string[], start: number, end: number): string[] {
  const len = members.length;
  let from = start < 0 ? Math.max(len + start, 0) : start;
  let to = end < 0 ? len + end : Math.min(end, len - 1);
  if (from > to || from >= len) return [];
  return members.slice(from, to + 1);
}

/**
 * `FIND <collection> [{json filter}] [limit]` / `COUNT <collection> [{json filter}]`.
 *
 * Reads the filter straight out of the untokenized line, taking everything between the first
 * `{` and the last `}` so nested objects and spaces inside the JSON both survive. Returns an
 * Error rather than throwing, so the caller can format it as a `(error) ERR ...` reply.
 */
function parseQueryCommand(
  line: string,
  cmd: string
): { collection: string; filter: Record<string, any>; limit: number } | Error {
  const rest = line.slice(cmd.length).trim();
  if (!rest) return new Error(`wrong number of arguments for '${cmd.toLowerCase()}' command`);

  const collection = rest.split(/\s+/)[0].replace(/^["']|["']$/g, '');
  const open = rest.indexOf('{');
  const close = rest.lastIndexOf('}');

  let filter: Record<string, any> = {};
  if (open >= 0 && close > open) {
    try {
      const parsed = JSON.parse(rest.slice(open, close + 1));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return new Error('filter must be a JSON object');
      }
      filter = parsed;
    } catch {
      return new Error('filter is not valid JSON');
    }
  } else if (open >= 0 || close >= 0) {
    return new Error('filter is not valid JSON');
  }

  const tail = (close >= 0 ? rest.slice(close + 1) : rest.slice(collection.length)).trim();
  if (!tail) return { collection, filter, limit: 5 };
  const limit = parseInt(tail.split(/\s+/)[0], 10);
  if (isNaN(limit)) return new Error('value is not an integer or out of range');
  return { collection, filter, limit };
}

/** Shared instance used by the server. */
export const store = new MongoStore();

/** Convenience re-exports so callers need not reach into the instance. */
export const initDb = (): Promise<void> => store.initDb();
export const isDbReady = (): boolean => store.isReady();
