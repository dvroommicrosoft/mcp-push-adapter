// MCP server that exposes the hub's channel tools (e.g. webhook_reply) to an agent.
// Used by the ACP host over Streamable HTTP and by the stdio tool-bridge fallback.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export function buildToolServer({ instructions, listTools, callTool }) {
  const server = new Server(
    { name: "push-adapter", version: "0.1.0" },
    { capabilities: { tools: {} }, instructions: instructions || undefined },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await listTools() }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { text, isError } = await callTool(req.params.name, req.params.arguments ?? {});
    return { content: [{ type: "text", text: text || (isError ? "error" : "ok") }], isError };
  });
  return server;
}

export function hubToolList(hub) {
  return hub.tools.map((t) => ({
    name: t.qualifiedName,
    description: `[channel ${t.channel}] ${t.description ?? ""}`.trim(),
    inputSchema: t.inputSchema ?? { type: "object", properties: {} },
  }));
}
