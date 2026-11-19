#!/usr/bin/env node
// push-adapter ACP host: run any Agent Client Protocol agent with Claude Code-style channels.
//
//   push-adapter-acp [--config push-adapter.json] [--cwd DIR] [--yolo] -- copilot --acp
//   push-adapter-acp -- gemini --experimental-acp
//
// The host is the ACP client. Channel events (and lines you type on stdin) become
// session/prompt turns; events that arrive while the agent is busy are batched into
// the next turn. Permission requests are shown locally and relayed to channels that
// declare claude/channel/permission; whichever answer arrives first wins.
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import * as acp from "@agentclientprotocol/sdk";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ChannelHub } from "../src/channel-hub.mjs";
import { loadConfig } from "../src/config.mjs";
import { buildToolServer, hubToolList } from "../src/tool-server.mjs";

const USAGE = "usage: push-adapter-acp [--config FILE] [--cwd DIR] [--yolo] [--verbose] -- <agent command> [args...]";
const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string" },
    cwd: { type: "string", default: process.cwd() },
    yolo: { type: "boolean", default: false },
    verbose: { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  },
});
if (opts.help || !positionals.length) {
  console.error(USAGE);
  process.exit(opts.help ? 0 : 2);
}

const dim = (s) => (process.stderr.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const info = (s) => process.stderr.write(`${dim(s)}\n`);

const config = loadConfig({ cwd: opts.cwd, path: opts.config });
if (!config?.channels.length) {
  console.error("push-adapter: no channels configured (push-adapter.json or .github/push-adapter.json)");
  process.exit(2);
}

// --- channels -----------------------------------------------------------------
const hub = new ChannelHub({ channels: config.channels, permissionRelay: config.permissionRelay });
hub.on("log", ({ level, message }) => {
  if (level !== "debug" || opts.verbose) info(`push-adapter ${level}: ${message}`);
});
const queue = [];
hub.on("event", (ev) => {
  info(ev.summary);
  enqueue(ev.tag);
});
await hub.start();
if (!hub.channels.size) {
  console.error("push-adapter: no channel connected");
  process.exit(1);
}

// --- tool bridge (agent -> host) ------------------------------------------------
// Channel tools are served from this process so each channel server runs once:
// /mcp is a stateless Streamable-HTTP MCP endpoint (preferred; Copilot's ACP only accepts
// http/sse servers), and /info, /tools, /call back the stdio tool-bridge fallback.
const token = randomBytes(24).toString("hex");
const callAndLog = (name, args) => {
  info(`→ ${name}`);
  return hub.callTool(name, args);
};
const bridge = createServer(async (req, res) => {
  const auth = Buffer.from(req.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
    res.writeHead(401).end();
    return;
  }
  const json = (status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  try {
    if (req.url === "/mcp") {
      const server = buildToolServer({
        instructions: hub.instructions(),
        listTools: async () => hubToolList(hub),
        callTool: callAndLog,
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      return await transport.handleRequest(req, res);
    }
    if (req.method === "GET" && req.url === "/info") return json(200, { instructions: hub.instructions() });
    if (req.method === "GET" && req.url === "/tools") return json(200, { tools: hubToolList(hub) });
    if (req.method === "POST" && req.url === "/call") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { name, arguments: args } = JSON.parse(body);
      return json(200, await callAndLog(name, args));
    }
    json(404, { error: "not found" });
  } catch (e) {
    if (res.headersSent) res.end();
    else json(200, { text: e.message, isError: true });
  }
});
await new Promise((r) => bridge.listen(0, "127.0.0.1", r));
const bridgeUrl = `http://127.0.0.1:${bridge.address().port}`;

// --- local input: prompts and permission answers --------------------------------
let localAnswer; // set while a permission prompt is waiting for y/n
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  if (localAnswer) return localAnswer(line.trim());
  if (line.trim()) enqueue(line);
});

// --- agent ------------------------------------------------------------------------
const [cmd, ...cmdArgs] = positionals;
const agent = spawn(cmd, cmdArgs, { cwd: opts.cwd, stdio: ["pipe", "pipe", opts.verbose ? "inherit" : "ignore"] });
agent.on("exit", (code) => {
  info(`agent exited (${code})`);
  shutdown(code ?? 1);
});
const stream = acp.ndJsonStream(Writable.toWeb(agent.stdin), Readable.toWeb(agent.stdout));

function pickOption(options, allow) {
  const kinds = allow ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  for (const k of kinds) {
    const o = options.find((x) => x.kind === k);
    if (o) return { outcome: { outcome: "selected", optionId: o.optionId } };
  }
  return { outcome: { outcome: "cancelled" } };
}

async function requestPermission({ toolCall, options }) {
  const title = toolCall?.title ?? "tool call";
  if (opts.yolo) return pickOption(options, true);

  const relay = hub.relayPermission({
    toolName: toolCall?.kind ?? "tool",
    description: title,
    inputPreview: JSON.stringify(toolCall?.rawInput ?? {}),
  });
  process.stderr.write(`\n🔐 ${title}${relay ? ` (relayed as ${relay.requestId})` : ""} — allow? [y/n] `);
  const local = new Promise((resolve) => {
    localAnswer = (a) => resolve({ behavior: /^y(es)?$/i.test(a) ? "allow" : "deny", channel: "terminal" });
  });
  const verdict = await Promise.race(relay ? [local, relay.verdict] : [local]);
  localAnswer = undefined;
  if (relay) hub.cancelPermission(relay.requestId);
  process.stderr.write(`${verdict.behavior} (${verdict.channel})\n`);
  return pickOption(options, verdict.behavior === "allow");
}

let atLineStart = true;
function onUpdate({ update }) {
  if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
    process.stdout.write(update.content.text);
    atLineStart = update.content.text.endsWith("\n");
  } else if (update.sessionUpdate === "tool_call") {
    if (!atLineStart) process.stdout.write("\n");
    atLineStart = true;
    info(`🔧 ${update.title ?? update.kind ?? "tool"}`);
  }
}

let wake;
function enqueue(text) {
  queue.push(text);
  wake?.();
}

let busy = false;
let ctxRef;
let sessionId;
let stopping = false;
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  rl.close();
  bridge.close();
  await hub.close();
  agent.kill();
  process.exit(code);
}
process.on("SIGINT", () => {
  if (busy && ctxRef && sessionId) {
    info("\ncancelling turn (Ctrl-C again to quit)");
    ctxRef.notify?.(acp.methods.agent.session.cancel, { sessionId });
    busy = false;
  } else shutdown(0);
});
process.on("SIGTERM", () => shutdown(0));

await acp
  .client({ name: "push-adapter" })
  .onRequest(acp.methods.client.session.requestPermission, (ctx) => requestPermission(ctx.params))
  .onNotification(acp.methods.client.session.update, (ctx) => onUpdate(ctx.params))
  .connectWith(stream, async (ctx) => {
    ctxRef = ctx;
    const init = await ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "push-adapter", version: "0.1.0" },
    });
    const agentName = init.agentInfo?.title ?? init.agentInfo?.name ?? cmd;
    const toolServer = init.agentCapabilities?.mcpCapabilities?.http
      ? {
          type: "http",
          name: "push-adapter",
          url: `${bridgeUrl}/mcp`,
          headers: [{ name: "Authorization", value: `Bearer ${token}` }],
        }
      : {
          name: "push-adapter",
          command: process.execPath,
          args: [fileURLToPath(new URL("./tool-bridge.mjs", import.meta.url))],
          env: [
            { name: "PUSH_ADAPTER_BRIDGE_URL", value: bridgeUrl },
            { name: "PUSH_ADAPTER_BRIDGE_TOKEN", value: token },
          ],
        };
    if (opts.verbose) info(`push-adapter: tools via ${toolServer.type ?? "stdio"} MCP`);
    const session = await ctx.request(acp.methods.agent.session.new, { cwd: opts.cwd, mcpServers: [toolServer] });
    sessionId = session.sessionId;
    info(`push-adapter: ${agentName} session ${sessionId}; channels: ${[...hub.channels.keys()].join(", ")}`);
    info("Events inject directly into this session. Type to prompt; Ctrl-C cancels a turn.");

    let instructionsDelivered = false;
    for (;;) {
      if (!queue.length) await new Promise((r) => (wake = r));
      wake = undefined;
      // Events that piled up while the agent was busy are handled together.
      let text = queue.splice(0).join("\n\n");
      if (!instructionsDelivered) {
        text = `${hub.instructions()}\n\n${text}`;
        instructionsDelivered = true;
      }
      busy = true;
      try {
        const res = await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }] });
        if (!atLineStart) process.stdout.write("\n");
        atLineStart = true;
        info(`[${res.stopReason}]`);
      } catch (e) {
        info(`prompt failed: ${e.message}`);
      } finally {
        busy = false;
      }
    }
  });
