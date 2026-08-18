// Connects to whatever MCP servers this deployment has been told about -
// the ITSM provider (+ anything else in .mcp.json, best-effort) over
// stdio, and holmesgpt-runbook-mcp over streamable-http - and gives the
// rest of the app one place to call a tool by {backend, tool}. Built on
// the official @modelcontextprotocol/sdk client.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// A backend restarting leaves us holding a transport the server has forgotten.
// The server rejects the call BEFORE running the tool - streamable-http answers
// with a missing/unknown session, stdio with a closed pipe - so retrying it is
// safe: nothing happened on the far side.
//
// This deliberately does NOT retry on every error. A call that failed partway
// through may well have executed, and blind retry would run a tier_2 write
// twice - the same double-execution risk the policy exists to prevent. Only
// these pre-execution signals are treated as retryable.
const RETRYABLE = [
  /session/i,                       // "No valid session ID", "Session not found"
  /-32600/,                         // Invalid Request - what a stale session returns
  /not connected|connection closed/i,
  /ECONNREFUSED|ECONNRESET|EPIPE|socket hang up/i,
  /fetch failed/i,
];

export function isRetryable(err) {
  const msg = String(err?.message || err);
  return RETRYABLE.some((re) => re.test(msg));
}

// The SDK defaults to a 60s request timeout, which is far too short for the
// tools that call an LLM and then a git forge. runbook_draft generates a whole
// runbook and opens a PR; it timed out at 60s having ALREADY created the PR, so
// the caller was told the action failed when it had succeeded - no tier_2
// notification fired, and a real write went unrecorded.
//
// Note a timeout is deliberately absent from RETRYABLE above. It's ambiguous by
// nature: the call may have completed, so retrying it could open a second PR or
// write a second ticket comment. Better to report it and let a human look.
const CALL_TIMEOUT_MS = parseInt(process.env.MCP_TOOL_TIMEOUT_MS || "180000", 10);
const CALL_OPTIONS = { timeout: CALL_TIMEOUT_MS };

export class Backend {
  constructor(name) {
    this.name = name;
    this.client = null;
    this.ready = false;
    this.tools = [];
    // Deployment facts merged into every call to this backend - see
    // BackendRegistry.applyInjected.
    this.injectArgs = null;
    // How to rebuild this connection from scratch. Set by connect*(), used by
    // reconnect() - without it a dropped backend stays dropped until the pod
    // is restarted by hand.
    this._open = null;
  }

  async connectStdio(command, args, env) {
    this._open = () => {
      const transport = new StdioClientTransport({
        command,
        args: args || [],
        env: { ...process.env, ...(env || {}) },
        stderr: "pipe",
      });
      transport.stderr?.on?.("data", (chunk) => {
        const msg = chunk.toString().trim();
        if (msg) console.error(`[${this.name}] ${msg}`);
      });
      return transport;
    };
    await this._connect(this._open());
  }

  /**
   * @param headers static request headers, e.g. an Authorization for a hosted
   *        server that authenticates by API key rather than OAuth.
   *
   * Atlassian's Rovo MCP Server is the reason this takes headers at all. Its
   * OAuth 2.1 flow is an interactive browser consent, which a pod cannot
   * complete; a service-account API key sent as `Authorization: Bearer <key>`
   * is the supported non-interactive path.
   */
  async connectHttp(url, headers = {}) {
    const init = Object.keys(headers).length ? { requestInit: { headers } } : undefined;
    this._open = () => new StreamableHTTPClientTransport(new URL(url), init);
    await this._connect(this._open());
  }

  async _connect(transport) {
    const client = new Client({ name: "platform-agent-bridge", version: "0.1.0" }, { capabilities: {} });
    await client.connect(transport);
    const { tools } = await client.listTools();
    this.client = client;
    this.tools = tools;
    this.ready = true;
    console.log(`[${this.name}] connected, ${tools.length} tool(s): ${tools.map((t) => t.name).join(", ")}`);
  }

  async reconnect() {
    if (!this._open) throw new Error(`backend "${this.name}" has no connection recipe`);
    this.ready = false;
    try {
      await this.client?.close?.();
    } catch {
      // already gone; that's why we're here
    }
    await this._connect(this._open());
  }

  async callTool(name, args) {
    // A backend that isn't connected gets one attempt to come back before the
    // call is refused - covers a backend that was down at boot and has since
    // recovered, which previously stayed dead for the pod's lifetime.
    if (!this.ready) {
      console.warn(`[${this.name}] not connected, attempting reconnect before "${name}"`);
      await this.reconnect();
    }

    try {
      return await this.client.callTool({ name, arguments: args || {} }, undefined, CALL_OPTIONS);
    } catch (err) {
      if (!isRetryable(err)) {
        throw err;
      }
      console.warn(`[${this.name}] "${name}" failed with a recoverable transport error (${err.message}); reconnecting and retrying once`);
      this.ready = false;
      await this.reconnect();
      return this.client.callTool({ name, arguments: args || {} });
    }
  }
}

export class BackendRegistry {
  constructor() {
    this.backends = new Map();
  }

  get(name) {
    return this.backends.get(name);
  }

  // Best-effort: a backend that fails to connect (missing credentials,
  // package not installable, etc.) is logged and skipped rather than
  // taking the whole bridge down. Its tools simply resolve to "blocked"
  // at call time, same as an unmapped verb.
  async connectAll({ mcpServers, holmesRunbookMcpUrl }) {
    for (const [name, def] of Object.entries(mcpServers)) {
      const backendName = name === "itsm" ? "itsm" : name;
      const backend = new Backend(backendName);
      // Deployment facts the model must never choose - see injectArgs below.
      backend.injectArgs = def.injectArgs || null;
      this.backends.set(backendName, backend);
      try {
        // A provider is EITHER a local process or a hosted URL. Until now this
        // only ever called connectStdio, so a url-based provider silently
        // became connectStdio(undefined) - which is how the committed Jira
        // provider could look configured and never have worked.
        if (def.url) {
          await backend.connectHttp(def.url, def.headers || {});
        } else if (def.command) {
          await backend.connectStdio(def.command, def.args, def.env);
        } else {
          throw new Error("provider defines neither `command` (local process) nor `url` (hosted server)");
        }
      } catch (err) {
        console.error(`[${backendName}] failed to connect: ${err.message} (tools from this backend will report "not available")`);
      }
    }

    if (holmesRunbookMcpUrl) {
      const runbook = new Backend("runbook_mcp");
      this.backends.set("runbook_mcp", runbook);
      try {
        await runbook.connectHttp(holmesRunbookMcpUrl);
      } catch (err) {
        console.error(`[runbook_mcp] failed to connect: ${err.message}`);
      }
    }
  }

  /**
   * Deployment facts the model must not choose, merged into every call.
   *
   * Atlassian's API-key auth is NOT bound to a cloudId - Atlassian's own docs
   * say clients "must explicitly pass the cloudId where needed" - so every tool
   * takes it as a required argument. The model has no way to know it, and more
   * to the point it must not: a cloudId supplied by the model is a cloudId that
   * prompt injection can redirect, and writing a ticket into someone else's
   * Atlassian site is a bad failure. Same for projectKey, which is a deployment
   * decision, not a per-request one.
   *
   * So these OVERRIDE whatever the model produced rather than filling gaps.
   * A value the model must not choose is not a default.
   */
  static applyInjected(injectArgs, args, warn = console.warn) {
    if (!injectArgs) return args;
    const out = { ...(args || {}) };
    for (const [k, v] of Object.entries(injectArgs)) {
      // config.js leaves an unset ${VAR} in place and warns. Injecting that
      // literal would send Atlassian the eight characters "${ATLASSIAN_CLOUD_ID}"
      // as a cloudId - a confusing 400 at best, and at worst a value that reads
      // as present. Drop it and say so: an unset deployment fact should look
      // like a missing argument, which is a clear error, not like a supplied one.
      if (typeof v === "string" && /\$\{[A-Z0-9_]+\}/.test(v)) {
        warn(`[mcp] not injecting "${k}": its value is still an unresolved placeholder (${v})`);
        continue;
      }
      out[k] = v;
    }
    return out;
  }

  /**
   * What the args WILL look like when this backend is called.
   *
   * Used to show an approver the real target of a parked tier-3 action -
   * injection happens at call time, so without this a parked record showed
   * cloudId and projectKey as undefined and a human approved blind. Purely a
   * preview: callTool injects again regardless, so a config change between
   * park and approve cannot be staged by a stale record.
   */
  injectedArgsFor(backendName, args) {
    const backend = this.backends.get(backendName);
    if (!backend) return args;
    return BackendRegistry.applyInjected(backend.injectArgs, args, () => {});
  }

  async callTool(backendName, toolName, args) {
    const backend = this.backends.get(backendName);
    if (!backend) {
      throw new Error(`backend "${backendName}" is not connected`);
    }
    args = BackendRegistry.applyInjected(backend.injectArgs, args);
    // Deliberately NOT short-circuiting on !backend.ready. Backend.callTool
    // tries a reconnect first, so a backend that was down at boot or has since
    // been restarted can recover on the next call instead of staying dead for
    // the lifetime of this pod. It still throws if the reconnect fails.
    try {
      return await backend.callTool(toolName, args);
    } catch (err) {
      if (!backend.ready) {
        throw new Error(`backend "${backendName}" is not connected: ${err.message}`);
      }
      throw err;
    }
  }

  status() {
    return Object.fromEntries(
      [...this.backends.entries()].map(([name, b]) => [name, { ready: b.ready, tools: b.tools.map((t) => t.name) }])
    );
  }
}
