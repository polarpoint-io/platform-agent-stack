#!/usr/bin/env python3
"""Print the live tools/list of an ITSM provider's MCP server.

itsm-providers/action-mappings/*.yaml maps generic policy verbs to tool
names on the provider's server. A verb mapped to a tool that does not
exist does NOT error - executor.js calls it, the backend rejects it, and
the failure looks like a backend problem rather than a policy one. Worse,
a verb mapped to the WRONG existing tool executes under the wrong tier
silently. Both mappings were written by reading the server's source, so
they need checking against a running server.

This spawns the server exactly the way mcpBackends.js does (stdio) and
does the same initialize + tools/list handshake, then diffs the result
against the action mapping.

    python3 list-provider-tools.py freshservice

No credentials required: tools/list is served before any API call is
made. Values for the server's env vars are read from the environment if
present and stubbed otherwise.
"""
import json
import os
import subprocess
import sys
import pathlib
import re

HERE = pathlib.Path(__file__).resolve().parent
CHART = HERE.parent


def load_provider(name):
    p = CHART / "itsm-providers" / "providers" / f"{name}.mcp.json"
    if not p.exists():
        sys.exit(f"no provider file at {p}")
    return json.loads(p.read_text())["itsm"]


def load_mapping(name):
    """Minimal 'verb: tool' reader - avoids a pyyaml dependency."""
    p = CHART / "itsm-providers" / "action-mappings" / f"{name}.yaml"
    if not p.exists():
        sys.exit(f"no action mapping at {p}")
    actions, in_actions = {}, False
    for line in p.read_text().splitlines():
        if re.match(r"^actions:\s*$", line):
            in_actions = True
            continue
        if in_actions:
            if line and not line[0].isspace():
                break
            m = re.match(r"^\s+([a-z0-9_]+):\s*([a-z0-9_]+)\s*$", line)
            if m:
                actions[m.group(1)] = m.group(2)
    return actions


def rpc(proc, method, params, msg_id):
    proc.stdin.write(json.dumps(
        {"jsonrpc": "2.0", "id": msg_id, "method": method, "params": params}
    ) + "\n")
    proc.stdin.flush()
    while True:
        line = proc.stdout.readline()
        if not line:
            sys.exit("server closed the connection before replying - "
                     "run it by hand to see its stderr")
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue          # server logging to stdout, not a JSON-RPC frame
        if msg.get("id") == msg_id:
            return msg


def main():
    name = sys.argv[1] if len(sys.argv) > 1 else "freshservice"
    provider = load_provider(name)
    mapping = load_mapping(name)

    env = dict(os.environ)
    for k, v in (provider.get("env") or {}).items():
        ref = re.fullmatch(r"\$\{([A-Z0-9_]+)\}", v or "")
        env[k] = env.get(ref.group(1), "unset-for-tools-list") if ref else v

    proc = subprocess.Popen(
        [provider["command"], *provider.get("args", [])],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        text=True, env=env,
    )
    try:
        rpc(proc, "initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "list-provider-tools", "version": "1"},
        }, 1)
        proc.stdin.write(json.dumps(
            {"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
        proc.stdin.flush()
        reply = rpc(proc, "tools/list", {}, 2)
    finally:
        proc.terminate()

    tools = sorted(t["name"] for t in reply.get("result", {}).get("tools", []))
    print(f"{name}: {len(tools)} tools\n")
    for t in tools:
        print(f"  {t}")

    print("\naction-mappings check:")
    bad = 0
    for verb, tool in sorted(mapping.items()):
        ok = tool in tools
        bad += not ok
        print(f"  {'OK  ' if ok else 'MISSING'}  {verb} -> {tool}")
    if bad:
        print(f"\n{bad} mapped verb(s) point at a tool this server does not "
              f"expose. They cannot execute, and nothing will say so at "
              f"runtime beyond a backend error.")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
