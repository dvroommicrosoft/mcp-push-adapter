// GitHub Copilot CLI / Copilot app extension: brings Claude Code "channels" to Copilot.
//
// Starts the channel servers listed in push-adapter.json, then:
//   • pushes each notifications/claude/channel event into the live session via session.send()
//   • exposes each channel's tools (e.g. reply) as extension tools named <channel>_<tool>
//   • relays permission prompts to channels that declare claude/channel/permission;
//     whichever answer lands first (terminal or remote) wins
import { joinSession } from "@github/copilot-sdk/extension";
import { ChannelHub } from "../src/channel-hub.mjs";
import { loadConfig } from "../src/config.mjs";

const config = loadConfig({ cwd: process.cwd() });
if (!config?.channels.length) {
  // Nothing configured for this workspace: stay dormant.
  await joinSession({});
} else {
  await run(config);
}

async function run(config) {
  const hub = new ChannelHub({ channels: config.channels, permissionRelay: config.permissionRelay });

  // The session doesn't exist until joinSession resolves, but tool definitions must be
  // passed to joinSession, so channels connect first and early logs/events are buffered.
  let session;
  const early = [];
  const log = (level, message) => {
    if (level === "debug") return;
    if (session) session.log(`push-adapter: ${message}`, level === "info" ? {} : { level }).catch(() => {});
    else early.push([level, message]);
  };
  hub.on("log", ({ level, message }) => log(level, message));

  const queued = [];
  hub.on("event", (ev) => (session ? deliver(ev) : queued.push(ev)));
  await hub.start();

  let instructionsDelivered = false;
  async function deliver(ev) {
    let prompt = ev.tag;
    if (!instructionsDelivered) {
      // Extensions can join after onSessionStart has fired (resume, /clear, reload).
      prompt = `${hub.instructions()}\n\n${prompt}`;
      instructionsDelivered = true;
    }
    try {
      await session.send({ prompt, displayPrompt: ev.summary, mode: config.deliveryMode });
    } catch (e) {
      log("error", `failed to deliver ${ev.channel} event: ${e.message}`);
    }
  }

  const tools = hub.tools.map((t) => ({
    name: t.qualifiedName,
    description: `[channel ${t.channel}] ${t.description ?? ""}`.trim(),
    parameters: t.inputSchema ?? { type: "object", properties: {} },
    handler: async (args) => {
      try {
        const { text, isError } = await hub.callTool(t.qualifiedName, args);
        return { textResultForLlm: text || (isError ? "error" : "ok"), resultType: isError ? "failure" : "success" };
      } catch (e) {
        return { textResultForLlm: e.message, resultType: "failure" };
      }
    },
  }));

  session = await joinSession({
    tools,
    hooks: {
      onSessionStart: async () => {
        const context = hub.instructions();
        if (!context) return;
        instructionsDelivered = true;
        return { additionalContext: context };
      },
      onSessionEnd: async () => {
        await hub.close();
      },
    },
  });

  for (const [level, message] of early.splice(0)) log(level, message);
  const names = [...hub.channels.keys()];
  if (names.length) log("info", `channels active: ${names.join(", ")} (events inject directly into this session)`);
  for (const ev of queued.splice(0)) deliver(ev);

  if (hub.hasPermissionRelay) wirePermissionRelay(session, hub, log);

  const shutdown = () => hub.close().finally(() => process.exit(0));
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

const PREVIEW_KEYS = ["fullCommandText", "fileName", "path", "url", "serverName", "toolName", "args", "arguments", "intention"];

function describePermission(req) {
  const toolName = req.toolName ?? req.kind ?? "tool";
  const description = req.intention ?? req.toolTitle ?? `Use ${toolName}`;
  const preview = {};
  for (const k of PREVIEW_KEYS) if (req[k] != null && k !== "intention") preview[k] = req[k];
  return { toolName, description, inputPreview: JSON.stringify(Object.keys(preview).length ? preview : req) };
}

function wirePermissionRelay(session, hub, log) {
  const open = new Map(); // copilot requestId -> channel request_id

  session.on("permission.requested", (event) => {
    const { requestId, permissionRequest } = event.data ?? {};
    if (!requestId || !permissionRequest) return;
    const relay = hub.relayPermission(describePermission(permissionRequest));
    if (!relay) return;
    open.set(requestId, relay.requestId);
    relay.verdict.then(async (v) => {
      open.delete(requestId);
      if (!v) return;
      const result =
        v.behavior === "allow"
          ? { kind: "approve-once", approvedInteractively: true }
          : { kind: "reject", feedback: `Denied remotely via channel ${v.channel}` };
      try {
        await session.rpc.permissions.handlePendingPermissionRequest({ requestId, result });
        log("info", `permission ${v.behavior === "allow" ? "approved" : "denied"} remotely via ${v.channel}`);
      } catch (e) {
        log("warning", `remote permission verdict not applied: ${e.message}`);
      }
    });
  });

  // Answered at the terminal (or auto-resolved): drop the remote request.
  session.on("permission.completed", (event) => {
    const id = open.get(event.data?.requestId);
    if (id) {
      open.delete(event.data.requestId);
      hub.cancelPermission(id);
    }
  });
}
