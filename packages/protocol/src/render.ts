import { sha256Hash } from './canonical.ts';
import type { Decision, Hash, Party, Plan, SectionOwner } from './types.ts';
import { PARTIES } from './types.ts';

function normalize(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** One line of text: line breaks collapse to a space. */
function inline(text: string): string {
  return normalize(text).replace(/\n+/g, ' ').trim();
}

/** One line of text with `<` escaped, so it can never open an HTML tag or comment. */
function plain(text: string): string {
  return inline(text).replace(/</g, '&lt;');
}

function cell(text: string): string {
  return plain(text).replace(/\|/g, '\\|');
}

/** CommonMark code span that survives backticks inside the text. */
function code(text: string): string {
  const value = inline(text);
  const longest = Math.max(0, ...(value.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = value.startsWith('`') || value.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${value}${pad}${fence}`;
}

/** Lines of a block of text without leading or trailing blank lines. */
function blockLines(text: string): string[] {
  const lines = normalize(text).split('\n');
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === '') start++;
  while (end > start && lines[end - 1]!.trim() === '') end--;
  return lines.slice(start, end);
}

function labelled(label: string, text: string): string[] {
  const [first, ...rest] = blockLines(text);
  return [first === undefined ? label : `${label} ${first.replace(/</g, '&lt;')}`, ...rest.map(itemLine)];
}

function listItem(label: string, text: string, extra: string[] = []): string[] {
  const [head, ...tail] = [...labelled(label, text), ...extra];
  return [`- ${head}`, ...tail.map((line) => `  ${line}`)];
}

// ---------------------------------------------------------------- untrusted Markdown

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;
/** Leading indentation and container markers (block quotes, list items) before a line's own content. */
const CONTAINER_PREFIX = /^(?:[ \t]*(?:>|[-+*](?=[ \t])|\d{1,9}[.)](?=[ \t])))*[ \t]*/;
const ATX_HEADING = /^(#{1,6})(?=[ \t]|$)/;
const SETEXT_UNDERLINE = /^(?:=+|-+)[ \t]*$/;
/** A fence the renderer tracks: unindented, so it cannot belong to a list item or block quote. */
const FENCE_OPEN = /^(?:(`{3,})[^`]*|(~{3,}).*)$/;
/** A tilde fence opener; an indented backtick one is already defused by escaping its unmatched backticks. */
const TILDE_FENCE = /^~{3,}/;

function splitPrefix(line: string): [string, string] {
  const prefix = CONTAINER_PREFIX.exec(line)![0];
  return [prefix, line.slice(prefix.length)];
}

/** Start of the next backtick run of exactly `length` at or after `from`, or -1 (CommonMark code span closer). */
function codeSpanCloser(line: string, from: number, length: number): number {
  const runs = /`+/g;
  runs.lastIndex = from;
  for (let m = runs.exec(line); m; m = runs.exec(line)) {
    if (m[0].length === length) return m.index;
  }
  return -1;
}

/**
 * Escapes `<` outside code spans. A code span must close on the same line and contain no `|` (GFM splits table
 * cells before it finds code spans); any other backtick is escaped so a span cannot start on one line and close on
 * the next, which would put a raw `<` outside code.
 */
function escapeInline(line: string): string {
  let out = '';
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    const next = line[i + 1];
    if (ch === '\\' && next !== undefined && ASCII_PUNCTUATION.test(next)) {
      out += next === '<' ? '&lt;' : ch + next;
      i += 2;
    } else if (ch === '`') {
      let end = i;
      while (line[end] === '`') end++;
      const length = end - i;
      const close = codeSpanCloser(line, end, length);
      if (close >= 0 && !line.slice(end, close).includes('|')) {
        out += line.slice(i, close + length);
        i = close + length;
      } else {
        out += '\\`'.repeat(length);
        i = end;
      }
    } else {
      out += ch === '<' ? '&lt;' : ch;
      i++;
    }
  }
  return out;
}

/** Neutralises block syntax on one line outside a tracked fence: headings go to level 4 or deeper, no setext underline, no fence. */
function escapeBlockLine(line: string, previousBlank: boolean): string {
  const [prefix, rest] = splitPrefix(line);
  const heading = ATX_HEADING.exec(rest);
  if (heading) return escapeInline(`${prefix}${'#'.repeat(Math.min(6, heading[1]!.length + 3))}${rest.slice(heading[1]!.length)}`);
  if ((!previousBlank && SETEXT_UNDERLINE.test(rest)) || TILDE_FENCE.test(rest)) return escapeInline(`${prefix}\\${rest}`);
  return escapeInline(line);
}

/** A continuation line of a list item: block syntax neutralised and every `<` escaped. */
function itemLine(line: string): string {
  return escapeBlockLine(line, false).replace(/</g, '&lt;');
}

/**
 * Section Markdown that cannot hide or impersonate the rest of the document: `<` outside code becomes `&lt;`,
 * headings render at level 4 or deeper, and a fence left open is closed.
 */
function sanitizeMarkdown(lines: string[]): string[] {
  const out: string[] = [];
  let fence: { char: string; length: number } | null = null;
  let previousBlank = true;
  for (const line of lines) {
    if (fence) {
      out.push(line);
      const [, rest] = /^ {0,3}(.*)$/.exec(line)!;
      if (new RegExp(`^\\${fence.char}{${fence.length},}[ \\t]*$`).test(rest!)) fence = null;
    } else {
      const open = FENCE_OPEN.exec(line);
      if (open) {
        const run = open[1] ?? open[2]!;
        fence = { char: run[0]!, length: run.length };
        out.push(line);
      } else {
        out.push(escapeBlockLine(line, previousBlank));
      }
    }
    previousBlank = line.trim() === '';
  }
  if (fence) out.push(fence.char.repeat(fence.length));
  return out;
}

/** CommonMark fenced block; the fence is longer than any run of the fence character in the content. */
function fenced(info: string, content: string): string[] {
  const infoText = inline(info);
  const char = infoText.includes('`') ? '~' : '`';
  const body = normalize(content).replace(/\n+$/, '');
  const runs = body.match(char === '`' ? /`+/g : /~+/g) ?? [];
  const fence = char.repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
  return [`${fence}${infoText}`, ...(body === '' ? [] : body.split('\n')), fence];
}

/** Natural order on ids (D2 before D10), independent of locale. */
function compareIds(a: string, b: string): number {
  const ta = a.match(/\d+|\D+/g) ?? [];
  const tb = b.match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.min(ta.length, tb.length); i++) {
    const x = ta[i]!;
    const y = tb[i]!;
    if (x === y) continue;
    if (/^\d/.test(x) && /^\d/.test(y)) {
      const nx = x.replace(/^0+/, '');
      const ny = y.replace(/^0+/, '');
      if (nx.length !== ny.length) return nx.length - ny.length;
      if (nx !== ny) return nx < ny ? -1 : 1;
      continue;
    }
    return x < y ? -1 : 1;
  }
  if (ta.length !== tb.length) return ta.length - tb.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

function orderDecisions(decisions: Decision[]): Decision[] {
  return [...decisions].sort((a, b) => {
    const assumedA = a.decided_by === 'agent-assumed' ? 0 : 1;
    const assumedB = b.decided_by === 'agent-assumed' ? 0 : 1;
    return assumedA - assumedB || compareIds(a.id, b.id);
  });
}

function ownerLabel(owner: SectionOwner, plan: Plan): string {
  return owner === 'joint' ? 'joint' : `${owner} (${plain(plan.meta.parties[owner])})`;
}

function decisionsTable(plan: Plan): string[] {
  if (plan.decisions.length === 0) return ['_None._'];
  return [
    '| ID | Decision | Kind | Decided by | Decided in |',
    '| --- | --- | --- | --- | --- |',
    ...orderDecisions(plan.decisions).map(
      (d) => `| ${cell(d.id)} | ${cell(d.text)} | ${d.kind ?? '—'} | ${d.decided_by} | ${d.decided_in ? code(d.decided_in) : '—'} |`,
    ),
  ];
}

function sectionBlock(plan: Plan, index: number): string[] {
  const s = plan.sections[index]!;
  const lines = [`## ${plain(s.title) || plain(s.id)}`, '', `_Section ${code(s.id)} · ${plain(s.type)} · owner: ${ownerLabel(s.owner, plan)}_`, ''];
  const md = blockLines(s.md);
  lines.push(...(md.length > 0 ? sanitizeMarkdown(md) : ['_No content._']), '');
  for (const a of s.artifacts ?? []) {
    lines.push(`**Artifact ${code(a.name)}** · ${plain(a.format)} · ${code(a.sha256)}`, '', ...fenced(a.format, a.content), '');
  }
  return lines;
}

function itemsOrNone(items: string[][]): string[] {
  return items.length === 0 ? ['_None._'] : items.flat();
}

/** Deterministic Markdown rendering of a plan (§2.8): `\n` line endings, no trailing whitespace, one final newline. */
export function renderMarkdown(plan: Plan): string {
  const lines: string[] = [
    `# ${plain(plan.meta.title)}`,
    '',
    `${plain(plan.meta.type)} · version ${plan.version} · session ${code(plan.session)} · A: ${plain(plan.meta.parties.A)} · B: ${plain(plan.meta.parties.B)} · charter ${code(plan.meta.charter_hash)}`,
    '',
    '## Decisions',
    '',
    ...decisionsTable(plan),
    '',
  ];
  plan.sections.forEach((_, index) => lines.push(...sectionBlock(plan, index)));
  lines.push(
    '## Disagreements',
    '',
    ...itemsOrNone(plan.disagreements.map((d) => listItem(`**${cell(d.id)}**:`, d.text, labelled('Resolution:', d.resolution)))),
    '',
    '## Open items',
    '',
    ...itemsOrNone(
      plan.open_items.map((o) =>
        listItem(`**${cell(o.id)}** (${o.status}, ${o.blocking ? 'blocking' : 'non-blocking'}, owner: ${o.owner}):`, o.text),
      ),
    ),
    '',
    '## Action items',
    '',
  );
  for (const party of PARTIES as Party[]) {
    lines.push(`### ${party} · ${plain(plan.meta.parties[party])}`, '', ...itemsOrNone(plan.action_items[party].map((a) => listItem(`**${cell(a.id)}**:`, a.text))), '');
  }

  const out = normalize(lines.join('\n'))
    .split('\n')
    .map((line) => line.replace(/\s+$/u, ''));
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return `${out.join('\n')}\n`;
}

export function markdownHash(plan: Plan): Hash {
  return sha256Hash(renderMarkdown(plan));
}
