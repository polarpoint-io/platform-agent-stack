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

export function createStateStore(mongoUri) {
  if (!mongoUri) {
    console.log("[state] MONGO_URI not set - approvals and triage jobs are in-memory only (lost on restart)");
    const approvals = inMemoryCollection();
    const jobs = inMemoryCollection();
    return { approvals, jobs, durable: false, async close() {} };
  }

  console.log("[state] MONGO_URI set - approvals and triage jobs are MongoDB-backed");
  const client = new MongoClient(mongoUri);
  const connected = client.connect();
  return {
    approvals: mongoCollection(connected, "pending_approvals"),
    jobs: mongoCollection(connected, "triage_jobs"),
    durable: true,
    async close() {
      await client.close();
    },
  };
}
