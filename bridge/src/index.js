// platform-agent-bridge - triage-router + itsm-support live here
// in-process; sre-investigator relays to HolmesGPT's own deployment.
// Hosts the agents, terminates MCP (every tool call for every backend
// goes through mcpBackends.js), and enforces the policy (every tool
// call for every backend goes through executor.js first).

import express from "express";
import { loadConfig } from "./config.js";
import { Policy, assertVerbsResolve } from "./policy.js";
import { BackendRegistry } from "./mcpBackends.js";
import { createExecutor } from "./executor.js";
import { createStateStore, rewriteMongoHost } from "./stateStore.js";
import { createJobs, startWorker, QUEUED, RUNNING } from "./jobs.js";
import { notifySlack } from "./notify.js";
import { classify } from "./llm.js";
import { handleInfraRequest } from "./sreAgent.js";
import { handleItsmRequest } from "./itsmAgent.js";
import { createChatAdapter } from "./chat/index.js";
import { startAlertPoller, createAlertWebhook } from "./alerts.js";
import { startLeaderElection } from "./leader.js";
import { requireApprovalToken } from "./auth.js";
import {
  collect as collectMetrics,
  CONTENT_TYPE as METRICS_CONTENT_TYPE,
  startProcessSampling,
  triageJobs,
  triageDuration,
  chatConnected,
} from "./metrics.js";

const BRIDGE_VERSION = process.env.BRIDGE_VERSION || "0.12.0";

async function main() {
  const config = loadConfig();
  const policy = new Policy({ riskTiers: config.riskTiers, actionMappings: config.actionMappings });
  const backends = new BackendRegistry();
  await backends.connectAll({ mcpServers: config.mcpServers, holmesRunbookMcpUrl: config.holmesRunbookMcpUrl });
  // Say so at boot if any verb points at a tool its backend does not have.
  assertVerbsResolve(policy, backends);

  const state = await createStateStore(
    rewriteMongoHost(config.mongoUri, config.mongoHostOverride)
  );
  const approvalsStore = state.approvals;
  const jobs = createJobs(state.jobs);
  const executor = createExecutor({ policy, backends, slackWebhookUrl: config.slackWebhookUrl, notifySlack, approvalsStore, decisionsStore: state.decisions, resultChecks: config.resultChecks });

  // Anything left RUNNING belongs to a worker that died. Requeue before
  // starting our own, or those jobs are lost silently.
  await jobs.requeueStale();

  // The work a queued /triage actually does - the same routing the endpoint
  // used to do inline.
  async function runTriage({ text }) {
    const lane = await classify(config.llmProvider, text);
    if (lane === "infra_incident") {
      return { lane, ...(await handleInfraRequest({ holmesUrl: config.holmesUrl, executor, text })) };
    }
    if (lane === "itsm_ticket") {
      return { lane, ...(await handleItsmRequest({ llmProvider: config.llmProvider, actionMappings: config.actionMappings, executor, policy, backends, text })) };
    }
    return { lane: "unknown", reply: "Could not classify this request as an infra incident or an ITSM ticket." };
  }

  const chat = createChatAdapter({
    provider: config.chat.provider,
    config: config.chat,
    deps: { jobs, executor },
  });

  const worker = startWorker({
    jobs,
    // Timed here rather than inside runTriage so the histogram measures what a
    // requester actually waits for, including classification.
    handle: async (job) => {
      const started = process.hrtime.bigint();
      let lane = "unknown";
      try {
        const result = await runTriage({ text: job.text });
        lane = result?.lane || "unknown";
        triageJobs.inc({ lane, status: "done" });
        return result;
      } catch (err) {
        triageJobs.inc({ lane, status: "failed" });
        throw err;
      } finally {
        triageDuration.observe({ lane }, Number(process.hrtime.bigint() - started) / 1e9);
      }
    },
    onResult: async (job) => {
      // Where a completed job gets delivered back to whoever asked. Slack
      // Socket Mode plugs in here; until then a job's result is read from
      // GET /triage/:id.
      if (!job.source) return;
      console.log(`[jobs] ${job.id} ${job.status} for source ${job.source.type || "unknown"}`);
      // Hand the finished job to whichever front door asked for it. Failures
      // are delivered too - a chat client showing nothing is worse than one
      // showing an error.
      await chat?.deliver?.(job).catch((e) =>
        console.error(`[chat] could not deliver ${job.id}: ${e.message}`)
      );
    },
  });

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  app.get("/status", async (_req, res) => {
    res.json({
      agents: (config.swarm.agents || []).map((a) => a.id),
      backends: backends.status(),
      itsmProvider: config.actionMappings?.provider || null,
      pendingApprovals: await executor.listPending(),
      // Say plainly whether a restart loses parked approvals and queued work.
      durableState: state.durable,
      degradedReason: state.degradedReason,
      triage: { queued: (await jobs.list(QUEUED)).length, running: (await jobs.list(RUNNING)).length },
    });
  });

  // The single front door. Accepts and queues; triage-router classifies and
  // hands off on a worker.
  //
  // 202 rather than the answer, because the answer takes too long to be an
  // HTTP response to a chat platform: Slack and Teams both want an ack inside
  // 3 seconds, and the infra lane runs ~29s. Poll GET /triage/:id, or let the
  // source adapter deliver the result.
  //
  // ?wait=true keeps the old synchronous behaviour for a CLI or a curl - handy
  // for testing a lane end to end, useless for a bot.
  app.post("/triage", async (req, res) => {
    const text = req.body?.text;
    if (!text) return res.status(400).json({ error: "body.text is required" });

    if (req.query.wait === "true") {
      try {
        return res.json(await runTriage({ text }));
      } catch (err) {
        console.error(`[triage] ${err.stack}`);
        return res.status(502).json({ error: err.message });
      }
    }

    try {
      const id = await jobs.enqueue({ text, source: req.body?.source || null });
      res.status(202).json({ id, status: QUEUED, poll: `/triage/${id}` });
    } catch (err) {
      console.error(`[triage] could not enqueue: ${err.stack}`);
      res.status(503).json({ error: `could not accept the request: ${err.message}` });
    }
  });

  app.get("/triage/:id", async (req, res) => {
    const job = await jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: `no triage job with id ${req.params.id}` });
    res.json(job);
  });

  app.get("/triage", async (_req, res) => {
    res.json({
      queued: (await jobs.list(QUEUED)).length,
      running: (await jobs.list(RUNNING)).length,
    });
  });

  // Direct, ungated-by-classification calls for a specific verb -
  // useful for testing a mapping/tier without going through the LLM
  // classifier, and for anything that already knows what it wants
  // (e.g. a Slack slash command bound to a specific action).
  // Guards the two routes that can change something. Declared once and applied
  // to both, so a future route cannot quietly land on the unguarded side.
  const requireToken = requireApprovalToken(config.approvalToken);

  app.post("/actions/:verb", requireToken, async (req, res) => {
    try {
      const result = await executor.execute(req.params.verb, req.body?.args || {}, { summary: req.body?.summary });
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  app.get("/approvals", async (_req, res) => res.json(await executor.listPending()));

  // 404 only means "no such approval". A backend that rejected the call
  // is a 502 and the approval stays pending - previously both came back
  // as 404, and a tool-level rejection came back as 200 with the error
  // buried in result.content, so an approver could not tell the
  // difference between done and not done.
  // WHO decided. The bearer token authorises the call but cannot say who sent
  // it, so the name is self-asserted - and required, because an audit row
  // reading "unknown" is barely an audit row. Recorded with actorVerified:false
  // so a reader can tell it from a Slack identity the platform actually
  // validated. Real attribution needs OIDC; this is the honest interim.
  function actorOf(req) {
    return String(req.body?.actor || req.get?.("x-approver") || "").trim();
  }
  function requireActor(req, res) {
    const actor = actorOf(req);
    if (!actor) {
      res.status(400).json({
        error:
          "an actor is required: send {\"actor\":\"you@example.com\"} or an X-Approver header. " +
          "The token says the call is allowed; it cannot say who made it, and a tier-3 decision " +
          "with nobody's name on it is not auditable.",
      });
      return null;
    }
    return actor;
  }

  // Declining is a decision, and until this existed the only way to clear an
  // unwanted approval was deleting it out of MongoDB - leaving no record that a
  // human had considered it and said no.
  app.post("/approvals/:id/reject", requireToken, async (req, res) => {
    const actor = requireActor(req, res);
    if (!actor) return;
    try {
      const out = await executor.reject(req.params.id, {
        actor,
        reason: req.body?.reason,
        channel: "http",
      });
      res.json(out);
    } catch (err) {
      if (err.code === "NO_SUCH_APPROVAL") return res.status(404).json({ error: err.message });
      console.error(`[reject] ${err.stack}`);
      res.status(500).json({ error: err.message });
    }
  });

  // The audit trail: what humans decided, approved and rejected alike.
  app.get("/approvals/decisions", requireToken, async (_req, res) => {
    res.json(await executor.listDecisions());
  });

  app.post("/approvals/:id/approve", requireToken, async (req, res) => {
    const actor = requireActor(req, res);
    if (!actor) return;
    try {
      const result = await executor.approve(req.params.id, {
        actor,
        reason: req.body?.reason,
        channel: "http",
      });
      res.json({ result, actor });
    } catch (err) {
      if (err.code === "NO_SUCH_APPROVAL") {
        return res.status(404).json({ error: err.message });
      }
      console.error(`[approve] ${err.stack}`);
      res.status(502).json({
        error: err.message,
        approvalId: req.params.id,
        stillPending: Boolean(err.stillPending),
      });
    }
  });

  // An adapter that has to be reachable from outside gets its OWN Express app
  // on its OWN port, and nothing else is ever mounted on it.
  //
  // Teams cannot dial out the way Slack's Socket Mode does - the Bot Framework
  // POSTs to an endpoint you host - so serving it means something public. If
  // that were this app, the public surface would also include /approvals/:id/
  // approve, which takes no credentials at all: anyone reaching it could
  // release a parked tier-3 action. The deny-all NetworkPolicy is the whole of
  // the access control today, and an Ingress in front of the pod makes it
  // irrelevant for anything it routes to.
  //
  // Splitting the listener is what lets an operator expose exactly one route.
  // /api/messages can be public because the Bot Framework validates a JWT on
  // every request; the rest of the bridge cannot.
  // TWO things may need it now - a chat adapter that cannot dial out, and the
  // Grafana alert webhook - so the app is built once if EITHER asks, and each
  // mounts only its own route. Still nothing else: no /triage, no /approvals.
  const alertWebhookWanted = config.alerts.webhook.enabled;
  const needsPublic = Boolean(chat?.needsPublicEndpoint) || alertWebhookWanted;

  let publicServer = null;
  let publicApp = null;
  if (needsPublic) {
    publicApp = express();
    publicApp.use(express.json({ limit: "1mb" }));
    // A health check so an Ingress or probe has something to hit without
    // being pointed at the private port.
    publicApp.get("/health", (_req, res) => res.json({ status: "ok" }));
  }

  if (chat) {
    if (chat.needsPublicEndpoint) {
      await chat.start({ app: publicApp });
    } else {
      // Slack dials out. It never needs a route, so it never gets an app.
      await chat.start();
    }
    console.log(`[chat] ${chat.name} front door active`);
    chatConnected.set({ provider: config.chat.provider }, 1);
  } else {
    chatConnected.set({ provider: config.chat.provider || "none" }, 0);
  }

  if (alertWebhookWanted) {
    // Authenticated, and FAILS CLOSED with no token. This route enqueues work
    // that costs LLM spend and can raise tickets; unauthenticated on a public
    // endpoint it would be an open invitation.
    if (!config.alerts.webhook.token) {
      console.error(
        "[alerts] webhook is enabled but ALERTS_WEBHOOK_TOKEN is not set - refusing to mount an " +
        "unauthenticated public route that enqueues triage work. Set externalSecrets.keys.alerts."
      );
    } else {
      publicApp.post(
        config.alerts.webhook.path,
        requireApprovalToken(config.alerts.webhook.token),
        createAlertWebhook({ config: config.alerts, jobs, store: state.alerts })
      );
      console.log(`[alerts] webhook mounted at ${config.alerts.webhook.path} on the PUBLIC listener`);
    }
  }

  if (needsPublic) {
    publicServer = publicApp.listen(config.publicPort, "0.0.0.0", () => {
      console.log(
        `[public] inbound endpoint on 0.0.0.0:${config.publicPort} - ` +
        `expose ONLY this port; ${config.port} has no authentication`
      );
    });
  }

  // Exactly one replica polls. Job claiming is atomic so the worker needs no
  // election, but the poller does: N replicas would each poll Grafana and race
  // to enqueue the same firing, turning one alert into N tickets.
  const election = startLeaderElection({
    leases: state.leases,
    name: "alert-poller",
    holder: config.leader.holder,
    ttlMs: config.leader.ttlMs,
    renewMs: config.leader.renewMs,
  });

  // Nothing else notices anything on its own - every other request is a human
  // typing in a chat client.
  const alertPoller = startAlertPoller({
    config: config.alerts,
    jobs,
    store: state.alerts,
    isLeader: () => election.isLeader(),
  });

  const sampler = startProcessSampling();

  // Metrics get their own listener, and nothing else is ever mounted on it.
  //
  // A scraper has to reach this pod from the monitoring namespace. The main port
  // carries /approvals/:id/approve, which takes no credentials at all - so
  // opening THAT port to wherever Prometheus or Alloy runs would make "release a
  // parked tier-3 action" reachable by anything scheduled there. Splitting the
  // listener is what lets the NetworkPolicy allow a scrape without allowing an
  // approval.
  let metricsServer = null;
  if (config.metrics.enabled) {
    const metricsApp = express();
    // Never 500s. A failed scrape is a monitoring problem; a scrape that can
    // crash the handler is an availability problem, and this exists to measure
    // availability.
    metricsApp.get(config.metrics.path, async (_req, res) => {
      try {
        const body = await collectMetrics({ backends, executor, jobs, state, version: BRIDGE_VERSION });
        res.set("Content-Type", METRICS_CONTENT_TYPE).send(body);
      } catch (err) {
        console.error(`[metrics] collect failed: ${err.message}`);
        res.set("Content-Type", METRICS_CONTENT_TYPE).send("# collect failed\n");
      }
    });
    metricsServer = metricsApp.listen(config.metrics.port, "0.0.0.0", () => {
      console.log(`[metrics] ${config.metrics.path} on 0.0.0.0:${config.metrics.port} - scrape ONLY this port`);
    });
  }

  const server = app.listen(config.port, "0.0.0.0", () => {
    console.log(`platform-agent-bridge listening on 0.0.0.0:${config.port}`);
  });

  // Stop taking new jobs and let the in-flight one finish rather than being
  // killed mid tool-call. A job cut off after its backend call has landed is
  // the ambiguous case we can't safely retry, so it's worth avoiding.
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, async () => {
      console.log(`[shutdown] ${signal} - draining`);
      worker.stop();
      alertPoller.stop();
      sampler.stop();
      // Hand back the lease so the next replica starts polling immediately
      // rather than waiting out the TTL.
      await election.stop().catch(() => {});
      await chat?.stop?.().catch(() => {});
      server.close();
      publicServer?.close();
      metricsServer?.close();
      await state.close();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error(`[fatal] ${err.stack}`);
  process.exit(1);
});
