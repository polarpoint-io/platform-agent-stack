// Leader election, for the one thing that must not run on every replica.
//
// Scaling the bridge out is nearly free: jobs.claim() is a single atomic
// findOneAndUpdate, so two replicas cannot take the same triage job. The ALERT
// POLLER is the exception. Every replica would poll Grafana on its own timer and
// race to enqueue the same firing - and the seen_alerts dedupe is a check-then-
// set, so both can miss and both enqueue. That turns one alert into N tickets,
// which is precisely the failure the opt-in label exists to prevent.
//
// So exactly one replica polls, chosen by a Mongo lease.
//
// Deliberately NOT a general-purpose distributed lock. The lease can be lost,
// double-held for a moment around expiry, or dropped entirely, and the worst
// outcome is a skipped poll or one duplicate - the next poll sees whatever is
// still firing. Anything that needs stronger guarantees than that should not be
// using this.

import { leaderStatus } from "./metrics.js";

/**
 * Hold a named lease, renewing until stopped.
 *
 * @param leases   store.leases - acquire(name, holder, ttlMs) => boolean
 * @param holder   who we are. The pod name, so a lost lease is traceable.
 * @param ttlMs    how long a lease survives without renewal
 * @param renewMs  how often to renew. Must be comfortably under ttlMs.
 */
export function startLeaderElection({
  leases,
  name = "alert-poller",
  holder,
  ttlMs = 30000,
  renewMs = 10000,
  onChange,
  now = Date.now,
}) {
  let leading = false;
  let stopped = false;
  let timer = null;

  async function attempt() {
    try {
      const got = await leases.acquire(name, holder, ttlMs, now());
      if (got !== leading) {
        leading = got;
        console.log(`[leader] ${holder} ${got ? "ACQUIRED" : "lost"} the "${name}" lease`);
        onChange?.(got);
      }
      leaderStatus.set({ lease: name }, got ? 1 : 0);
    } catch (err) {
      // A database blip must not leave a follower believing it leads. Failing
      // closed here means at worst nobody polls for a few seconds; failing open
      // would mean everybody does.
      if (leading) {
        console.warn(`[leader] ${holder} could not renew "${name}" (${err.message}) - standing down`);
        leading = false;
        onChange?.(false);
      }
      leaderStatus.set({ lease: name }, 0);
    } finally {
      if (!stopped) timer = setTimeout(attempt, renewMs);
    }
  }

  attempt();

  return {
    isLeader: () => leading,
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      // Hand the lease back rather than making the next replica wait out the
      // TTL. A rolling deploy should not cost 30s of unwatched alerts.
      if (leading) await leases.release?.(name, holder).catch(() => {});
      leading = false;
      leaderStatus.set({ lease: name }, 0);
    },
  };
}
