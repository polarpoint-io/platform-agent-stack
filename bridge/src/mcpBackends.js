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

export class Backend {
  constructor(name) {
    this.name = name;
    this.client = null;
    this.ready = false;
    this.tools = [];
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

  async connectHttp(url) {
    this._open = () => new StreamableHTTPClientTransport(new URL(url));
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
      return await this.client.callTool({ name, arguments: args || {} });
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
      this.backends.set(backendName, backend);
      try {
        await backend.connectStdio(def.command, def.args, def.env);
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

  async callTool(backendName, toolName, args) {
    const backend = this.backends.get(backendName);
    if (!backend) {
      throw new Error(`backend "${backendName}" is not connected`);
    }
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
