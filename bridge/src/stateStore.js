// One document store, two collections: pending tier-3 approvals and the
// /triage job queue. Both need the same thing - survive a pod restart, and be
// correct if this ever runs more than one replica.
//
// In-memory when MONGO_URI is unset, MongoDB when it's set. The Mongo comes
// from mongostate-crossplane's connection secret; see the chart's mongoState
// block. Nothing here assumes which, so the bridge behaves identically either
// way apart from durability.

import { MongoClient } from "mongodb";

function inMemoryCollection() {
  const docs = new Map();
  return {
    async set(id, value) {
      docs.set(id, { ...value });
    },
    async get(id) {
      const v = docs.get(id);
      return v ? { ...v } : undefined;
    },
    async delete(id) {
      docs.delete(id);
    },
    async list(filter = {}) {
      return [...docs.entries()]
        .filter(([, v]) => Object.entries(filter).every(([k, want]) => v[k] === want))
        .map(([id, v]) => ({ id, ...v }));
    },
    // Atomically take the oldest doc matching `from` and move it to `to`.
    // Returns the claimed doc or undefined. Single-threaded in this
    // implementation, so "atomic" is free.
    async claimOldest(from, to, patch = {}) {
      const candidates = [...docs.entries()]
        .filter(([, v]) => Object.entries(from).every(([k, want]) => v[k] === want))
        .sort((a, b) => String(a[1].createdAt).localeCompare(String(b[1].createdAt)));
      const [id, value] = candidates[0] || [];
      if (!id) return undefined;
      const next = { ...value, ...to, ...patch };
      docs.set(id, next);
      return { id, ...next };
    },
  };
}

function mongoCollection(clientReady, name) {
  const ready = clientReady.then((c) => c.db().collection(name));
  return {
    async set(id, value) {
      const col = await ready;
      await col.updateOne({ _id: id }, { $set: value }, { upsert: true });
    },
    async get(id) {
      const col = await ready;
      const doc = await col.findOne({ _id: id });
      if (!doc) return undefined;
      const { _id, ...value } = doc;
      return value;
    },
    async delete(id) {
      const col = await ready;
      await col.deleteOne({ _id: id });
    },
    async list(filter = {}) {
      const col = await ready;
      const docs = await col.find(filter).toArray();
      return docs.map(({ _id, ...value }) => ({ id: _id, ...value }));
    },
    // findOneAndUpdate is the whole reason this is worth doing in Mongo: two
    // replicas racing for the same job get exactly one winner. Without it,
    // scaling past one replica would run every triage twice.
    async claimOldest(from, to, patch = {}) {
      const col = await ready;
      const doc = await col.findOneAndUpdate(
        from,
        { $set: { ...to, ...patch } },
        { sort: { createdAt: 1 }, returnDocument: "after" }
      );
      const found = doc?.value ?? doc; // driver v5 vs v6 shape
      if (!found?._id) return undefined;
      const { _id, ...value } = found;
      return { id: _id, ...value };
    },
  };
}

/**
 * Point a connection string at a different host, for reaching the database
 * through a proxy.
 *
 * The subtle part is `directConnection`. The URI Crossplane writes carries
 * `replicaSet=rs0`, which puts the driver into replica-set discovery: it
 * connects, asks the server for the set's members, and then talks to the
 * hostnames the server advertises - which are the controller-internal ones.
 * Through a tailnet egress proxy those are unreachable, so the driver would
 * connect successfully and then immediately fail server selection, which
 * looks like the proxy is broken when it isn't.
 *
 * Forcing a direct connection skips discovery and talks to the proxy address
 * only. Safe here because the set is a single member; it would need revisiting
 * for a real multi-member set, where the answer is exposing each member.
 */
export function rewriteMongoHost(uri, host) {
  if (!uri || !host) return uri;
  const parsed = new URL(uri);
  parsed.host = host;
  parsed.searchParams.delete("replicaSet");
  parsed.searchParams.set("directConnection", "true");
  return parsed.toString();
}

/**
 * Compare-and-swap lease, used to elect one alert poller across replicas.
 *
 * Job claiming is already safe at any replica count - claimOldest is a single
 * atomic findOneAndUpdate. The POLLER is not: every replica would poll Grafana
 * on its own timer and race to enqueue the same firing, and seen_alerts dedupe
 * is a check-then-set, so two replicas can both miss and both enqueue.
 *
 * A lease is the smallest thing that fixes it. It is deliberately NOT a
 * general-purpose lock: losing it briefly costs at most a skipped poll, and the
 * next poll picks up whatever is still firing.
 */
function mongoLeases(ready) {
  return {
    async acquire(name, holder, ttlMs, now = Date.now()) {
      const col = await ready;
      try {
        await col.findOneAndUpdate(
          // Take it if we already hold it (renewal) or if the incumbent's lease
          // has expired. Anything else means someone live holds it.
          { _id: name, $or: [{ holder }, { expiresAt: { $lte: new Date(now) } }] },
          { $set: { holder, expiresAt: new Date(now + ttlMs) } },
          { upsert: true, returnDocument: "after" }
        );
        return true;
      } catch (err) {
        // Filter matched nothing so upsert tried to INSERT, and _id already
        // exists: a live lease is held elsewhere. That is a normal outcome for
        // a follower, not an error.
        if (err?.code === 11000) return false;
        throw err;
      }
    },
    async release(name, holder) {
      const col = await ready;
      await col.deleteOne({ _id: name, holder });
    },
  };
}

/** Single process - there is nobody to contend with, so it always leads. */
function inMemoryLeases() {
  return {
    async acquire() { return true; },
    async release() {},
  };
}

function inMemoryStore(reason) {
  return {
    approvals: inMemoryCollection(),
    jobs: inMemoryCollection(),
    alerts: inMemoryCollection(),
    leases: inMemoryLeases(),
    durable: false,
    degradedReason: reason || null,
    async close() {},
  };
}

/**
 * Durability is best-effort, and its absence is reported rather than fatal.
 *
 * An unreachable state store used to kill the process, so the bridge
 * crash-looped and took the ITSM and SRE lanes down with it - both of which
 * work perfectly well without durable queues. Losing persistence is not a
 * reason to stop answering.
 *
 * The failure is NOT swallowed: it's logged at error, /status reports
 * durableState:false with degradedReason, and the fallback is in-memory. That
 * distinction matters - the thing to avoid is claiming durability you don't
 * have, not degrading.
 */
export async function createStateStore(mongoUri, { connectTimeoutMs = 10000 } = {}) {
  if (!mongoUri) {
    console.log("[state] MONGO_URI not set - approvals and triage jobs are in-memory only (lost on restart)");
    return inMemoryStore("MONGO_URI not set");
  }

  const client = new MongoClient(mongoUri, {
    serverSelectionTimeoutMS: connectTimeoutMs,
    connectTimeoutMS: connectTimeoutMs,
  });

  try {
    const connected = await client.connect();
    // connect() resolves before a server has necessarily been selected, so
    // ping - otherwise the first real write is where we'd find out.
    await connected.db().command({ ping: 1 });
    console.log("[state] MongoDB reachable - approvals and triage jobs are durable");
    const ready = Promise.resolve(connected);
    return {
      approvals: mongoCollection(ready, "pending_approvals"),
      jobs: mongoCollection(ready, "triage_jobs"),
      // Which alerts have already been triaged. Durable on purpose: held only
      // in memory, a restart re-triages everything currently firing, which on a
      // bad morning is a burst of duplicate tickets.
      alerts: mongoCollection(ready, "seen_alerts"),
      leases: mongoLeases(ready.then((c) => c.db().collection("leader_leases"))),
      durable: true,
      degradedReason: null,
      async close() {
        await client.close();
      },
    };
  } catch (err) {
    console.error(
      `[state] MONGO_URI is set but MongoDB is unreachable (${err.message}). ` +
      `Falling back to in-memory: parked approvals and queued jobs will NOT survive a restart. ` +
      `Serving anyway - the ITSM and SRE lanes do not need durable state.`
    );
    await client.close().catch(() => {});
    return inMemoryStore(`MongoDB unreachable: ${err.message}`);
  }
}
