// Connects to whatever MCP servers this deployment has been told about -
// the ITSM provider (+ anything else in .mcp.json, best-effort) over
// stdio, and holmesgpt-runbook-mcp over streamable-http - and gives the
// rest of the app one place to call a tool by {backend, tool}. Built on
// the official @modelcontextprotocol/sdk client.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

class Backend {
  constructor(name) {
    this.name = name;
    this.client = null;
    this.ready = false;
    this.tools = [];
  }

  async connectStdio(command, args, env) {
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
    await this._connect(transport);
  }

  async connectHttp(url) {
    const transport = new StreamableHTTPClientTransport(new URL(url));
    await this._connect(transport);
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

  async callTool(name, args) {
    if (!this.ready) throw new Error(`backend "${this.name}" is not connected`);
    return this.client.callTool({ name, arguments: args || {} });
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
    if (!backend || !backend.ready) {
      throw new Error(`backend "${backendName}" is not connected`);
    }
    return backend.callTool(toolName, args);
  }

  status() {
    return Object.fromEntries(
      [...this.backends.entries()].map(([name, b]) => [name, { ready: b.ready, tools: b.tools.map((t) => t.name) }])
    );
  }
}
