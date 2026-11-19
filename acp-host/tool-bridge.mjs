#!/usr/bin/env node
// Fallback for ACP agents without MCP-over-HTTP support (agentCapabilities.mcpCapabilities.http):
// a stdio MCP server that the agent spawns (passed via session/new mcpServers).
// It proxies channel tools back to the push-adapter ACP host over a localhost HTTP
// connection authenticated with a per-run token, so each channel server runs only
// once (inside the host) no matter how the agent manages MCP processes.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildToolServer } from "../src/tool-server.mjs";

const url = process.env.PUSH_ADAPTER_BRIDGE_URL;
const token = process.env.PUSH_ADAPTER_BRIDGE_TOKEN;
if (!url || !token) {
  process.stderr.write("tool-bridge: PUSH_ADAPTER_BRIDGE_URL and PUSH_ADAPTER_BRIDGE_TOKEN are required\n");
  process.exit(1);
}

async function call(path, body) {
  const res = await fetch(`${url}${path}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`push-adapter host ${path}: HTTP ${res.status}`);
  return res.json();
}

const server = buildToolServer({
  instructions: (await call("/info")).instructions,
  listTools: async () => (await call("/tools")).tools,
  callTool: (name, args) => call("/call", { name, arguments: args }),
});
await server.connect(new StdioServerTransport());
