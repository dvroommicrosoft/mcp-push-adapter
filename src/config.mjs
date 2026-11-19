import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * Config file shape (relative paths resolve against the config file's directory):
 * {
 *   "channels": {
 *     "webhook":  { "command": "node", "args": ["./examples/webhook-channel.mjs"], "env": {} },
 *     "fakechat": { "plugin": "~/src/claude-plugins-official/external_plugins/fakechat" }
 *   },
 *   "deliveryMode": "enqueue",   // or "immediate" (Copilot only: interject mid-turn)
 *   "permissionRelay": true      // forward permission prompts to channels that opt in
 * }
 */
export function findConfigPath(cwd = process.cwd()) {
  const candidates = [
    process.env.PUSH_ADAPTER_CONFIG,
    join(cwd, ".github", "push-adapter.json"),
    join(cwd, "push-adapter.json"),
    join(homedir(), ".copilot", "push-adapter.json"),
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p));
}

function expandHome(p) {
  return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
}

function resolvePath(base, p) {
  const expanded = expandHome(p);
  return isAbsolute(expanded) ? expanded : resolve(base, expanded);
}

function substitute(value, vars) {
  return String(value).replace(/\$\{(\w+)\}/g, (m, name) => vars[name] ?? process.env[name] ?? m);
}

/** Load a Claude Code channel plugin's server definition from its .mcp.json. */
function loadPluginServer(name, pluginDir, serverName) {
  const mcpPath = join(pluginDir, ".mcp.json");
  if (!existsSync(mcpPath)) throw new Error(`channel "${name}": no .mcp.json in plugin ${pluginDir}`);
  const servers = JSON.parse(readFileSync(mcpPath, "utf8")).mcpServers ?? {};
  const key = serverName ?? (servers[name] ? name : Object.keys(servers)[0]);
  const server = servers[key];
  if (!server?.command) throw new Error(`channel "${name}": plugin has no stdio server "${key}"`);
  const vars = {
    CLAUDE_PLUGIN_ROOT: pluginDir,
    CLAUDE_PLUGIN_DATA: join(homedir(), ".push-adapter", "plugin-data", name),
  };
  return {
    command: substitute(server.command, vars),
    args: (server.args ?? []).map((a) => substitute(a, vars)),
    env: Object.fromEntries(Object.entries(server.env ?? {}).map(([k, v]) => [k, substitute(v, vars)])),
    cwd: pluginDir,
  };
}

export function loadConfig({ cwd = process.cwd(), path } = {}) {
  const configPath = path ? resolve(cwd, path) : findConfigPath(cwd);
  if (!configPath) return undefined;
  const raw = JSON.parse(readFileSync(configPath, "utf8"));
  const base = dirname(configPath);
  // Optional per-run opt-in, like `claude --channels a b`.
  const only = process.env.PUSH_ADAPTER_CHANNELS?.split(",").map((s) => s.trim()).filter(Boolean);

  const channels = [];
  for (const [name, def] of Object.entries(raw.channels ?? {})) {
    if (def.enabled === false) continue;
    if (only && !only.includes(name)) continue;
    if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`invalid channel name "${name}"`);
    let server;
    if (def.plugin) {
      server = loadPluginServer(name, resolvePath(base, def.plugin), def.server);
    } else {
      if (!def.command) throw new Error(`channel "${name}" needs "command" or "plugin"`);
      const args = (def.args ?? []).map((a) => (/^\.\.?\//.test(a) ? resolve(base, a) : a));
      server = { command: def.command, args, env: def.env ?? {}, cwd: def.cwd ? resolvePath(base, def.cwd) : base };
    }
    channels.push({ name, ...server });
  }

  return {
    path: configPath,
    channels,
    deliveryMode: raw.deliveryMode === "immediate" ? "immediate" : "enqueue",
    permissionRelay: raw.permissionRelay !== false,
  };
}
