// @bun
// plugin/hooks/disclosure.ts
import { appendFileSync, existsSync } from "fs";
import { join as join2 } from "path";

// plugin/hooks/lib.ts
import { homedir } from "os";
import { join } from "path";
function cmaRoot(env = process.env) {
  return env.CMA_HOME || env.CLAUDE_PLUGIN_DATA || join(homedir(), ".call-my-agent");
}

// plugin/hooks/disclosure.ts
var MAX_FIELD_BYTES = 16 * 1024;
var ENTROPY_MIN_BITS = 4.2;
var RULES = [
  { name: "private-key", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/ },
  { name: "aws-access-key", re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b/ },
  { name: "gcp-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "gcp-service-account", re: /"type"\s*:\s*"service_account"/ },
  { name: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { name: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: "stripe-key", re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { name: "anthropic-or-openai-key", re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{32,}\b/ },
  {
    name: "secret-assignment",
    re: /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)["']?\s*(?::=|=)\s*["']?[^\s"',;]{8,}/i
  },
  {
    name: "secret-assignment",
    re: /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)["']?\s*:\s*["'][^"'\s]{8,}["']/i
  },
  { name: "env-assignment", re: /^[ \t]*(?:export[ \t]+)?[A-Z][A-Z0-9_]{2,}=[^\s=]{4,}/m }
];
function shannon(s) {
  const counts = new Map;
  for (const ch of s)
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}
var MAX_DEPTH = 64;
var MAX_NODES = 20000;
var HASH_KEYS = new Set(["hash", "result_hash", "checkpoint_ref", "proposal", "sha256", "charter_hash"]);
var FORMAT_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;
var PREFIXED_HASH = /sha256:[0-9a-f]{64}(?![0-9a-f])/gi;
var SPACED_OUT = /(?:\S[ \t]){7,}\S/g;
function highEntropyToken(text) {
  for (const m of text.matchAll(/[A-Za-z0-9+/_=-]{32,}/g)) {
    const t = m[0];
    if (/^[0-9a-fA-F]+$/.test(t))
      continue;
    if (!/[0-9]/.test(t) || !/[A-Za-z]/.test(t))
      continue;
    if (shannon(t) >= ENTROPY_MIN_BITS)
      return true;
  }
  return false;
}
function normalize(s) {
  return s.normalize("NFKC").replace(FORMAT_CHARS, "").replace(PREFIXED_HASH, " ");
}
function collect(root) {
  const out = { raw: [], values: [], joinable: [], overflow: false };
  const stack = [{ v: root, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const { v, depth, key } = stack.pop();
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) {
      out.overflow = true;
      return out;
    }
    if (typeof v === "string") {
      out.raw.push(v);
      if (key !== undefined && HASH_KEYS.has(key) && /^(?:sha256:)?[0-9a-f]{64}$/i.test(v))
        continue;
      if (key === "commit" && /^[0-9a-f]{40}$/i.test(v))
        continue;
      const n = normalize(v);
      out.values.push(n);
      out.joinable.push(n);
    } else if (typeof v === "number" || typeof v === "bigint") {
      out.values.push(String(v));
      out.joinable.push(String(v));
    } else if (Array.isArray(v)) {
      for (let i = v.length - 1;i >= 0; i--)
        stack.push({ v: v[i], depth: depth + 1, key });
    } else if (v && typeof v === "object") {
      const entries = Object.entries(v);
      for (let i = entries.length - 1;i >= 0; i--) {
        const [k, child] = entries[i];
        stack.push({ v: child, depth: depth + 1, key: k });
        stack.push({ v: k, depth: depth + 1 });
      }
    }
  }
  return out;
}
var UNBOUNDED_RULES = RULES.map((r) => ({ name: r.name, re: new RegExp(r.re.source.replaceAll("\\b", ""), r.re.flags) }));
function scanText(text, reasons, joined = false) {
  for (const rule of joined ? UNBOUNDED_RULES : RULES) {
    if (rule.re.test(text))
      reasons.add(rule.name);
  }
  if (!joined && highEntropyToken(text))
    reasons.add("high-entropy-string");
  if (/[0-9a-fA-F]{40,}/.test(text))
    reasons.add("long-hex-string");
  if (/[0-9]{24,}/.test(text))
    reasons.add("long-digit-run");
}
function scan(toolInput) {
  const reasons = new Set;
  const { raw, values, joinable, overflow } = collect(toolInput);
  if (overflow) {
    reasons.add(`input nested deeper than ${MAX_DEPTH} or larger than ${MAX_NODES} nodes`);
    return [...reasons];
  }
  for (const s of raw) {
    if (Buffer.byteLength(s, "utf8") > MAX_FIELD_BYTES)
      reasons.add(`a text field is larger than ${MAX_FIELD_BYTES / 1024} KB`);
  }
  const despaced = (v) => v.replace(SPACED_OUT, (m) => m.replace(/[ \t]/g, ""));
  for (const v of values) {
    scanText(v, reasons);
    scanText(despaced(v), reasons);
  }
  const collapsed = joinable.map(despaced);
  scanText(collapsed.join(`
`), reasons, true);
  scanText(collapsed.join(""), reasons, true);
  return [...reasons];
}
function audit(session, record) {
  if (typeof session !== "string" || !/^[A-Za-z0-9_-]+$/.test(session))
    return;
  const dir = join2(cmaRoot(), "calls", session);
  if (!existsSync(dir))
    return;
  appendFileSync(join2(dir, "audit.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), kind: "hook_verdict", hook: "disclosure", ...record })}
`);
}
function block(message) {
  console.error(message);
  process.exit(2);
}
async function main() {
  const input = JSON.parse(await Bun.stdin.text());
  const toolInput = input.tool_input ?? {};
  const reasons = scan(toolInput);
  const tool = input.tool_name ?? "unknown";
  if (reasons.length > 0) {
    audit(toolInput.session, { tool, verdict: "block", reasons });
    block(`Blocked by the call-my-agent disclosure policy: ${reasons.join(", ")}. Remove the sensitive or oversized content and send a short summary with a file:line reference instead. If it is needed, raise a checkpoint with your human; secrets can never be sent.`);
  }
  audit(toolInput.session, { tool, verdict: "allow" });
}
if (import.meta.main) {
  process.on("uncaughtException", () => process.exit(2));
  process.on("unhandledRejection", () => process.exit(2));
  try {
    await main();
  } catch (err) {
    block(`call-my-agent disclosure check failed (${err instanceof Error ? err.message : "unknown error"}); blocking the send.`);
  }
}
export {
  scan
};
