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
  const executor = createExecutor({ policy, backends, slackWebhookUrl: config.slackWebhookUrl, notifySlack, approvalsStore, resultChecks: config.resultChecks });

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

  const worker = startWorker({
    jobs,
    handle: (job) => runTriage({ text: job.text }),
    onResult: async (job) => {
      // Where a completed job gets delivered back to whoever asked. Slack
      // Socket Mode plugs in here; until then a job's result is read from
      // GET /triage/:id.
      if (job.source) {
        console.log(`[jobs] ${job.id} ${job.status} for source ${job.source.type || "unknown"}`);
      }
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
  app.post("/actions/:verb", async (req, res) => {
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
  app.post("/approvals/:id/approve", async (req, res) => {
    try {
      const result = await executor.approve(req.params.id);
      res.json({ result });
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
      server.close();
      await state.close();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error(`[fatal] ${err.stack}`);
  process.exit(1);
});
