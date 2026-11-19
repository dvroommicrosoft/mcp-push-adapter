#!/usr/bin/env node
// Node port of the "Full webhook.ts with permission relay" example from
// https://code.claude.com/docs/en/channels-reference. Nothing here is specific to
// push-adapter: the same file works with `claude --dangerously-load-development-channels`.
//
//   POST /        inbound message (header X-Sender must be allowlisted)
//   GET  /events  SSE stream of replies and permission prompts
import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const PORT = Number(process.env.WEBHOOK_PORT ?? 8788);
const allowed = new Set((process.env.WEBHOOK_ALLOWED_SENDERS ?? "dev").split(","));

const listeners = new Set();
function send(text) {
  const chunk = text.split("\n").map((l) => `data: ${l}\n`).join("") + "\n";
  for (const res of listeners) res.write(chunk);
}

const mcp = new Server(
  { name: "webhook", version: "0.0.1" },
  {
    capabilities: {
      experimental: { "claude/channel": {}, "claude/channel/permission": {} },
      tools: {},
    },
    instructions:
      'Messages arrive as <channel source="webhook" chat_id="...">. Reply with the reply tool, passing the chat_id from the tag.',
  },
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description: "Send a message back over this channel",
      inputSchema: {
        type: "object",
        properties: {
          chat_id: { type: "string", description: "The conversation to reply in" },
          text: { type: "string", description: "The message to send" },
        },
        required: ["chat_id", "text"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "reply") {
    const { chat_id, text } = req.params.arguments;
    send(`Reply to ${chat_id}: ${text}`);
    return { content: [{ type: "text", text: "sent" }] };
  }
  throw new Error(`unknown tool: ${req.params.name}`);
});

const PermissionRequestSchema = z.object({
  method: z.literal("notifications/claude/channel/permission_request"),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
});

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  send(
    `Agent wants to run ${params.tool_name}: ${params.description}\n` +
      `${params.input_preview}\n\n` +
      `Reply "yes ${params.request_id}" or "no ${params.request_id}"`,
  );
});

await mcp.connect(new StdioServerTransport());

const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;
let nextId = 1;

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "GET" && url.pathname === "/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    res.write(": connected\n\n");
    listeners.add(res);
    req.on("close", () => listeners.delete(res));
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }
  let body = "";
  for await (const chunk of req) body += chunk;

  if (!allowed.has(req.headers["x-sender"] ?? "")) {
    res.writeHead(403).end("forbidden");
    return;
  }

  const m = PERMISSION_REPLY_RE.exec(body);
  if (m) {
    await mcp.notification({
      method: "notifications/claude/channel/permission",
      params: { request_id: m[2].toLowerCase(), behavior: m[1].toLowerCase().startsWith("y") ? "allow" : "deny" },
    });
    res.end("verdict recorded");
    return;
  }

  await mcp.notification({
    method: "notifications/claude/channel",
    params: { content: body, meta: { chat_id: String(nextId++), path: url.pathname, method: req.method } },
  });
  res.end("ok");
}).listen(PORT, "127.0.0.1");
