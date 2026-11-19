// Formatting helpers shared by every harness adapter.

const META_KEY_RE = /^[A-Za-z0-9_]+$/;
// Same alphabet Claude Code uses: lowercase, no "l" so it never reads as 1/I.
const ID_ALPHABET = "abcdefghijkmnopqrstuvwxyz";
const UNSAFE_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Keep only identifier-shaped keys, matching Claude Code (other keys are dropped). */
export function filterMeta(meta) {
  const out = {};
  if (!meta || typeof meta !== "object") return out;
  for (const [k, v] of Object.entries(meta)) {
    if (META_KEY_RE.test(k) && k !== "source" && v != null) out[k] = String(v);
  }
  return out;
}

/** Render an event the way Claude Code shows it to the model: <channel source="x" k="v">body</channel>. */
export function formatChannelTag(source, content, meta) {
  const attrs = Object.entries({ source, ...filterMeta(meta) })
    .map(([k, v]) => `${k}="${escapeAttr(v)}"`)
    .join(" ");
  // Stop pushed text from closing the tag early and posing as harness content.
  const body = String(content ?? "").replace(/<(\/?channel\b)/gi, "&lt;$1");
  return `<channel ${attrs}>\n${body}\n</channel>`;
}

/** One-line timeline summary, e.g. "← webhook: build failed on main". */
export function summarize(source, content, max = 120) {
  const line = String(content ?? "").replace(/\s+/g, " ").trim();
  return `← ${source}: ${line.length > max ? `${line.slice(0, max - 1)}…` : line}`;
}

/** Fold whitespace, strip invisible/bidi characters, and elide the middle of long text. */
export function sanitizeForRelay(text, max = 3500) {
  const clean = String(text ?? "").replace(UNSAFE_CHARS_RE, "").replace(/\s+/g, " ").trim();
  const chars = [...clean];
  if (chars.length <= max) return clean;
  const keep = Math.floor((max - 40) / 2);
  const elided = chars.length - keep * 2;
  return `${chars.slice(0, keep).join("")} ⋯ ${elided} code points elided ⋯ ${chars.slice(-keep).join("")}`;
}

/** Five-letter permission request ID, unique within `used`. */
export function newRequestId(used) {
  for (;;) {
    let id = "";
    for (let i = 0; i < 5; i++) id += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
    if (!used.has(id)) {
      used.add(id);
      return id;
    }
  }
}

/** Channel tool names exposed to the harness: "<channel>_<tool>", sanitized. */
export function qualifyToolName(channel, tool) {
  return `${channel}_${tool}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}
