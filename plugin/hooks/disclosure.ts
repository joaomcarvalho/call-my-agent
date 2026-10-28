import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { cmaRoot } from './lib.ts';

const MAX_FIELD_BYTES = 16 * 1024;
const ENTROPY_MIN_LEN = 32;
const ENTROPY_MIN_BITS = 4.2;

interface Rule {
  name: string;
  re: RegExp;
}

const RULES: Rule[] = [
  { name: 'private-key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/ },
  { name: 'aws-access-key', re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b/ },
  { name: 'gcp-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'gcp-service-account', re: /"type"\s*:\s*"service_account"/ },
  { name: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { name: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'stripe-key', re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { name: 'anthropic-or-openai-key', re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{32,}\b/ },
  {
    name: 'secret-assignment',
    re: /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)["']?\s*(?::=|=)\s*["']?[^\s"',;]{8,}/i,
  },
  {
    name: 'secret-assignment',
    re: /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)["']?\s*:\s*["'][^"'\s]{8,}["']/i,
  },
  { name: 'env-assignment', re: /^[ \t]*(?:export[ \t]+)?[A-Z][A-Z0-9_]{2,}=[^\s=]{4,}/m },
];

function shannon(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function highEntropyToken(text: string): boolean {
  for (const m of text.matchAll(/[A-Za-z0-9+/_=-]{32,}/g)) {
    const t = m[0];
    if (/^[0-9a-fA-F]+$/.test(t)) continue;
    if (!/[0-9]/.test(t) || !/[A-Za-z]/.test(t)) continue;
    if (shannon(t) >= ENTROPY_MIN_BITS) return true;
  }
  return false;
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      collectStrings(v, out);
    }
  }
}

export function scan(toolInput: unknown): string[] {
  const strings: string[] = [];
  collectStrings(toolInput, strings);
  const reasons = new Set<string>();
  for (const s of strings) {
    if (Buffer.byteLength(s, 'utf8') > MAX_FIELD_BYTES) reasons.add(`a text field is larger than ${MAX_FIELD_BYTES / 1024} KB`);
    for (const rule of RULES) {
      if (rule.re.test(s)) reasons.add(rule.name);
    }
    if (highEntropyToken(s)) reasons.add('high-entropy-string');
  }
  return [...reasons];
}

function audit(session: unknown, record: Record<string, unknown>): void {
  if (typeof session !== 'string' || !/^[A-Za-z0-9_-]+$/.test(session)) return;
  const dir = join(cmaRoot(), 'calls', session);
  if (!existsSync(dir)) return;
  appendFileSync(join(dir, 'audit.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), kind: 'hook_verdict', hook: 'disclosure', ...record })}\n`);
}

if (import.meta.main) {
  let input: { tool_name?: string; tool_input?: Record<string, unknown> };
  try {
    input = JSON.parse(await Bun.stdin.text());
  } catch {
    console.error('call-my-agent disclosure check: hook input was not valid JSON; blocking the send.');
    process.exit(2);
  }
  const toolInput = input.tool_input ?? {};
  const reasons = scan(toolInput);
  const tool = input.tool_name ?? 'unknown';
  if (reasons.length > 0) {
    audit(toolInput.session, { tool, verdict: 'block', reasons });
    console.error(
      `Blocked by the call-my-agent disclosure policy: ${reasons.join(', ')}. Remove the sensitive or oversized content and send a short summary with a file:line reference instead. If it is needed, raise a checkpoint with your human; secrets can never be sent.`,
    );
    process.exit(2);
  }
  audit(toolInput.session, { tool, verdict: 'allow' });
}
