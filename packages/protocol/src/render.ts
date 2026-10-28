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

function cell(text: string): string {
  return inline(text).replace(/\|/g, '\\|');
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
  return [first === undefined ? label : `${label} ${first}`, ...rest];
}

function listItem(label: string, text: string, extra: string[] = []): string[] {
  const [head, ...tail] = [...labelled(label, text), ...extra];
  return [`- ${head}`, ...tail.map((line) => `  ${line}`)];
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
  return owner === 'joint' ? 'joint' : `${owner} (${inline(plan.meta.parties[owner])})`;
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
  const lines = [`## ${inline(s.title) || inline(s.id)}`, '', `_Section ${code(s.id)} · ${inline(s.type)} · owner: ${ownerLabel(s.owner, plan)}_`, ''];
  const md = blockLines(s.md);
  lines.push(...(md.length > 0 ? md : ['_No content._']), '');
  for (const a of s.artifacts ?? []) {
    lines.push(`**Artifact ${code(a.name)}** · ${inline(a.format)} · ${code(a.sha256)}`, '', ...fenced(a.format, a.content), '');
  }
  return lines;
}

function itemsOrNone(items: string[][]): string[] {
  return items.length === 0 ? ['_None._'] : items.flat();
}

/** Deterministic Markdown rendering of a plan (§2.8): `\n` line endings, no trailing whitespace, one final newline. */
export function renderMarkdown(plan: Plan): string {
  const lines: string[] = [
    `# ${inline(plan.meta.title)}`,
    '',
    `${inline(plan.meta.type)} · version ${plan.version} · session ${code(plan.session)} · A: ${inline(plan.meta.parties.A)} · B: ${inline(plan.meta.parties.B)} · charter ${code(plan.meta.charter_hash)}`,
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
    lines.push(`### ${party} · ${inline(plan.meta.parties[party])}`, '', ...itemsOrNone(plan.action_items[party].map((a) => listItem(`**${cell(a.id)}**:`, a.text))), '');
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
