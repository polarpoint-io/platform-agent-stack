// Where pending tier-3 approvals live between being parked and being
// approved. In-memory by default - lost on pod restart, and only ever
// visible to the pod that created them (this chart runs replicaCount:
// 1 for exactly that reason). Set MONGO_URI to back this with
// mongostate-crossplane's connection secret instead - approvals then
// survive a restart, and would be visible across replicas if this
// chart ever runs more than one.

import { MongoClient } from "mongodb";

function createInMemoryStore() {
  const pending = new Map();
  return {
    async set(id, value) {
      pending.set(id, value);
    },
    async get(id) {
      return pending.get(id);
    },
    async delete(id) {
      pending.delete(id);
    },
    async list() {
      return [...pending.entries()].map(([id, v]) => ({ id, ...v }));
    },
    async close() {},
  };
}

function createMongoStore(mongoUri) {
  const client = new MongoClient(mongoUri);
  const ready = client.connect().then((c) => c.db().collection("pending_approvals"));

  return {
    async set(id, value) {
      const collection = await ready;
      await collection.updateOne({ _id: id }, { $set: value }, { upsert: true });
    },
    async get(id) {
      const collection = await ready;
      const doc = await collection.findOne({ _id: id });
      if (!doc) return undefined;
      const { _id, ...value } = doc;
      return value;
    },
    async delete(id) {
      const collection = await ready;
      await collection.deleteOne({ _id: id });
    },
    async list() {
      const collection = await ready;
      const docs = await collection.find().toArray();
      return docs.map(({ _id, ...value }) => ({ id: _id, ...value }));
    },
    async close() {
      await client.close();
    },
  };
}

export function createApprovalsStore(mongoUri) {
  if (mongoUri) {
    console.log("[approvalsStore] MONGO_URI set - pending approvals are MongoDB-backed");
    return createMongoStore(mongoUri);
  }
  console.log("[approvalsStore] MONGO_URI not set - pending approvals are in-memory only");
  return createInMemoryStore();
}
