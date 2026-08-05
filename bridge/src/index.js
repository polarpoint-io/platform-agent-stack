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
import { createApprovalsStore } from "./approvalsStore.js";
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

  const approvalsStore = createApprovalsStore(config.mongoUri);
  const executor = createExecutor({ policy, backends, slackWebhookUrl: config.slackWebhookUrl, notifySlack, approvalsStore, resultChecks: config.resultChecks });

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  app.get("/status", async (_req, res) => {
    res.json({
      agents: (config.swarm.agents || []).map((a) => a.id),
      backends: backends.status(),
      itsmProvider: config.actionMappings?.provider || null,
      pendingApprovals: await executor.listPending(),
    });
  });

  // The single front door. triage-router classifies, then hands off.
  app.post("/triage", async (req, res) => {
    const text = req.body?.text;
    if (!text) return res.status(400).json({ error: "body.text is required" });

    try {
      const lane = await classify(config.llmProvider, text);
      if (lane === "infra_incident") {
        const result = await handleInfraRequest({ holmesUrl: config.holmesUrl, executor, text });
        return res.json({ lane, ...result });
      }
      if (lane === "itsm_ticket") {
        const result = await handleItsmRequest({ llmProvider: config.llmProvider, actionMappings: config.actionMappings, executor, policy, backends, text });
        return res.json({ lane, ...result });
      }
      return res.json({ lane: "unknown", reply: "Could not classify this request as an infra incident or an ITSM ticket." });
    } catch (err) {
      console.error(`[triage] ${err.stack}`);
      res.status(502).json({ error: err.message });
    }
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

  app.listen(config.port, "0.0.0.0", () => {
    console.log(`platform-agent-bridge listening on 0.0.0.0:${config.port}`);
  });
}

main().catch((err) => {
  console.error(`[fatal] ${err.stack}`);
  process.exit(1);
});
