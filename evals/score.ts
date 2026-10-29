import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  DECISION_KINDS,
  PARTIES,
  PlanSchema,
  replay,
  verifyAgreementFile,
  type Decision,
  type DecisionKind,
  type Envelope,
  type Party,
  type Plan,
} from '@cma/protocol';

export const SCENARIO_DIR = resolve(import.meta.dir, 'scenarios');

export type Source = 'decisions' | 'open_items' | 'action_items' | 'disagreements' | 'sections';
const SOURCES: readonly Source[] = ['decisions', 'open_items', 'action_items', 'disagreements', 'sections'];

export type ProcessCheck =
  | 'checkpoint_answered_per_side'
  | 'disagreements_resolved'
  | 'no_assumed_checkpoint_decisions'
  | 'signatures_verify';
const CHECKS: readonly ProcessCheck[] = [
  'checkpoint_answered_per_side',
  'disagreements_resolved',
  'no_assumed_checkpoint_decisions',
  'signatures_verify',
];

export interface Requirement {
  label: string;
  in: Source[];
  /** Every group must match the same item; a group matches when any of its patterns does. */
  all: RegExp[][];
  /** The item is disqualified when any of these match it. */
  none: RegExp[];
  /** Only decisions attributed to a human count. */
  humanDecided: boolean;
}

interface BaseCriterion {
  id: string;
  title: string;
  required: boolean;
  weight: number;
}
export interface ContentCriterion extends BaseCriterion {
  type: 'content';
  requirements: Requirement[];
}
export interface ProcessCriterion extends BaseCriterion {
  type: 'process';
  check: ProcessCheck;
}
export type Criterion = ContentCriterion | ProcessCriterion;

export interface Scenario {
  id: string;
  title: string;
  passThreshold: number;
  defaultCheckpointKinds: DecisionKind[];
  criteria: Criterion[];
}

export interface CriterionResult {
  id: string;
  title: string;
  type: 'content' | 'process';
  required: boolean;
  weight: number;
  pass: boolean;
  detail: string;
}

export interface EvalReport {
  scenario: string;
  verified: { ok: true; planHash: string } | { ok: false; reason: string };
  logUsed: boolean;
  results: CriterionResult[];
  earned: number;
  total: number;
  score: number;
  threshold: number;
  requiredFailed: string[];
  pass: boolean;
}

// ---------------------------------------------------------------- scenario loading

function fail(where: string, message: string): never {
  throw new Error(`scenario ${where}: ${message}`);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function compile(where: string, pattern: string): RegExp {
  try {
    return new RegExp(pattern, 'i');
  } catch (e) {
    return fail(where, `invalid pattern ${JSON.stringify(pattern)}: ${(e as Error).message}`);
  }
}

function parseRequirement(where: string, raw: unknown): Requirement {
  if (typeof raw !== 'object' || raw === null) fail(where, 'requirement must be an object');
  const r = raw as Record<string, unknown>;
  if (typeof r.label !== 'string' || r.label === '') fail(where, 'requirement needs a label');
  if (!isStringArray(r.in) || r.in.length === 0 || !r.in.every((s) => (SOURCES as readonly string[]).includes(s))) {
    fail(where, `"in" must list sources from ${SOURCES.join(', ')}`);
  }
  if (!Array.isArray(r.all) || r.all.length === 0 || !r.all.every((g) => isStringArray(g) && g.length > 0)) {
    fail(where, '"all" must be a non-empty list of non-empty pattern lists');
  }
  if (r.none !== undefined && !isStringArray(r.none)) fail(where, '"none" must be a list of patterns');
  if (r.human_decided !== undefined && typeof r.human_decided !== 'boolean') fail(where, '"human_decided" must be a boolean');
  if (r.human_decided && !(r.in.length === 1 && r.in[0] === 'decisions')) fail(where, '"human_decided" needs "in": ["decisions"]');
  return {
    label: r.label,
    in: r.in as Source[],
    all: (r.all as string[][]).map((group) => group.map((p) => compile(where, p))),
    none: (r.none ?? []).map((p) => compile(where, p)),
    humanDecided: r.human_decided === true,
  };
}

/** Validates and compiles a scenario object; throws naming the first problem. */
export function parseScenario(raw: unknown): Scenario {
  if (typeof raw !== 'object' || raw === null) fail('?', 'must be a JSON object');
  const s = raw as Record<string, unknown>;
  if (typeof s.id !== 'string' || s.id === '') fail('?', 'needs an id');
  const at = s.id;
  if (typeof s.pass_threshold !== 'number' || s.pass_threshold < 0 || s.pass_threshold > 1) fail(at, 'pass_threshold must be a number in [0, 1]');
  const kinds = s.default_checkpoint_kinds ?? [];
  if (!isStringArray(kinds) || !kinds.every((k) => (DECISION_KINDS as readonly string[]).includes(k))) {
    fail(at, `default_checkpoint_kinds must list kinds from ${DECISION_KINDS.join(', ')}`);
  }
  if (!Array.isArray(s.criteria) || s.criteria.length === 0) fail(at, 'needs criteria');
  const seen = new Set<string>();
  const criteria = s.criteria.map((rawC, i): Criterion => {
    if (typeof rawC !== 'object' || rawC === null) fail(`${at} criterion ${i}`, 'must be an object');
    const c = rawC as Record<string, unknown>;
    if (typeof c.id !== 'string' || c.id === '' || seen.has(c.id)) fail(`${at} criterion ${i}`, 'needs a unique id');
    seen.add(c.id);
    const where = `${at}/${c.id}`;
    if (typeof c.title !== 'string') fail(where, 'needs a title');
    if (c.weight !== undefined && (typeof c.weight !== 'number' || !(c.weight > 0))) fail(where, 'weight must be a positive number');
    const base = { id: c.id, title: c.title, required: c.required === true, weight: (c.weight as number | undefined) ?? 1 };
    if (c.type === 'content') {
      if (!Array.isArray(c.requirements) || c.requirements.length === 0) fail(where, 'content criterion needs requirements');
      return { ...base, type: 'content', requirements: c.requirements.map((r) => parseRequirement(where, r)) };
    }
    if (c.type === 'process') {
      if (!(CHECKS as readonly unknown[]).includes(c.check)) fail(where, `check must be one of ${CHECKS.join(', ')}`);
      return { ...base, type: 'process', check: c.check as ProcessCheck };
    }
    return fail(where, 'type must be "content" or "process"');
  });
  return {
    id: s.id,
    title: typeof s.title === 'string' ? s.title : s.id,
    passThreshold: s.pass_threshold,
    defaultCheckpointKinds: kinds as DecisionKind[],
    criteria,
  };
}

/** Loads `evals/scenarios/<name>.json`, or a path to a scenario file. */
export function loadScenario(nameOrPath: string): Scenario {
  const path = /[/\\]|\.json$/.test(nameOrPath) ? resolve(nameOrPath) : join(SCENARIO_DIR, `${nameOrPath}.json`);
  if (!existsSync(path)) throw new Error(`no scenario at ${path}`);
  return parseScenario(JSON.parse(readFileSync(path, 'utf8')));
}

// ---------------------------------------------------------------- plan items

interface Item {
  ref: string;
  source: Source;
  text: string;
  decision?: Decision;
}

const normalise = (text: string): string => text.replace(/`/g, '').replace(/\s+/g, ' ').trim();

/** Every decision, open item, action item and disagreement, plus each non-empty line of each section. */
function planItems(plan: Plan): Item[] {
  const items: Item[] = [];
  for (const d of plan.decisions) items.push({ ref: d.id, source: 'decisions', text: normalise(d.text), decision: d });
  for (const o of plan.open_items) items.push({ ref: o.id, source: 'open_items', text: normalise(o.text) });
  for (const party of PARTIES) {
    for (const a of plan.action_items[party]) items.push({ ref: a.id, source: 'action_items', text: normalise(a.text) });
  }
  for (const x of plan.disagreements) items.push({ ref: x.id, source: 'disagreements', text: normalise(`${x.text} ${x.resolution}`) });
  for (const s of plan.sections) {
    s.md.split('\n').forEach((line, i) => {
      if (line.trim() !== '') items.push({ ref: `${s.id}:${i + 1}`, source: 'sections', text: normalise(line) });
    });
  }
  return items;
}

const matchesTerms = (req: Requirement, item: Item): boolean => req.all.every((group) => group.some((re) => re.test(item.text)));

function checkRequirement(req: Requirement, items: Item[]): { pass: boolean; detail: string } {
  const candidates = items.filter((item) => req.in.includes(item.source) && matchesTerms(req, item));
  const negated = candidates.filter((item) => req.none.some((re) => re.test(item.text)));
  const assumed = candidates.filter((item) => req.humanDecided && item.decision?.decided_by === 'agent-assumed');
  const hits = candidates.filter((item) => !negated.includes(item) && !assumed.includes(item));
  if (hits.length > 0) return { pass: true, detail: `${req.label}: ${hits.slice(0, 3).map((h) => h.ref).join(', ')}` };
  const why = [
    ...(negated.length ? [`negated in ${negated.map((h) => h.ref).join(', ')}`] : []),
    ...(assumed.length ? [`agent-assumed in ${assumed.map((h) => h.ref).join(', ')}`] : []),
  ];
  return { pass: false, detail: `missing: ${req.label}${why.length ? ` (${why.join('; ')})` : ''}` };
}

// ---------------------------------------------------------------- process checks

const PLACEHOLDER_RESOLUTION = /^(tbd|tba|todo|n\/?a|none|pending|unresolved|-+|—|\?+)?$/i;

interface Context {
  plan: Plan | null;
  verdict: ReturnType<typeof verifyAgreementFile>;
  log: ReturnType<typeof replay> | null;
  checkpointKinds: DecisionKind[];
}

function checkpointsPerSide(ctx: Context): { pass: boolean; detail: string } {
  if (ctx.log) {
    const answered: Record<Party, number> = { A: 0, B: 0 };
    for (const c of Object.values(ctx.log.checkpoints)) if (c.answeredIn) answered[c.party] += 1;
    return { pass: answered.A > 0 && answered.B > 0, detail: `log: A answered ${answered.A}, B answered ${answered.B}` };
  }
  const plan = ctx.plan!;
  const by = (party: Party): string[] =>
    plan.decisions.filter((d) => d.decided_by === `human-${party}` && d.kind && ctx.checkpointKinds.includes(d.kind)).map((d) => d.id);
  const a = by('A');
  const b = by('B');
  return {
    pass: a.length > 0 && b.length > 0,
    detail: `plan proxy (no --log): checkpoint-kind decisions by human-A ${a.length}, by human-B ${b.length}`,
  };
}

function disagreementsResolved(plan: Plan): { pass: boolean; detail: string } {
  if (plan.disagreements.length === 0) return { pass: true, detail: 'no disagreements recorded' };
  const bad = plan.disagreements.filter((x) => PLACEHOLDER_RESOLUTION.test(x.resolution.trim()));
  if (bad.length > 0) return { pass: false, detail: `no resolution: ${bad.map((x) => x.id).join(', ')}` };
  return { pass: true, detail: `${plan.disagreements.length} resolved or open` };
}

function noAssumedCheckpointDecisions(ctx: Context): { pass: boolean; detail: string } {
  const bad = ctx.plan!.decisions.filter((d) => d.kind && ctx.checkpointKinds.includes(d.kind) && d.decided_by === 'agent-assumed');
  const from = ctx.log ? 'charter' : 'scenario default';
  if (bad.length > 0) return { pass: false, detail: `agent-assumed: ${bad.map((d) => d.id).join(', ')}` };
  return { pass: true, detail: `checkpoint kinds from ${from}; none agent-assumed` };
}

function runProcess(check: ProcessCheck, ctx: Context): { pass: boolean; detail: string } {
  if (check === 'signatures_verify') {
    return ctx.verdict.ok ? { pass: true, detail: `plan_hash ${ctx.verdict.planHash}` } : { pass: false, detail: ctx.verdict.reason };
  }
  if (check === 'checkpoint_answered_per_side' && ctx.log) return checkpointsPerSide(ctx);
  if (!ctx.plan) return { pass: false, detail: 'no readable plan in the file' };
  switch (check) {
    case 'checkpoint_answered_per_side':
      return checkpointsPerSide(ctx);
    case 'disagreements_resolved':
      return disagreementsResolved(ctx.plan);
    case 'no_assumed_checkpoint_decisions':
      return noAssumedCheckpointDecisions(ctx);
  }
}

// ---------------------------------------------------------------- scoring

/** The embedded cma-plan JSON, if it parses as a plan, whether or not the file verifies. */
function embeddedPlan(text: string): Plan | null {
  const marker = '\n<!-- cma-plan\n';
  const at = text.lastIndexOf(marker);
  const end = text.lastIndexOf('\n-->');
  if (at < 0 || end <= at) return null;
  try {
    const parsed = PlanSchema.safeParse(JSON.parse(text.slice(at + marker.length, end)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Parses JSONL call-log text (`log.jsonl` or `cma log --json`) into envelopes. */
export function parseLog(text: string): Envelope[] {
  const out: Envelope[] = [];
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    try {
      out.push(JSON.parse(line) as Envelope);
    } catch {
      throw new Error(`log line ${i + 1} is not JSON`);
    }
  });
  return out;
}

/** Scores an agreement file against a scenario. Throws when the log belongs to another call or plan. */
export function scoreAgreement(scenario: Scenario, text: string, log?: Envelope[]): EvalReport {
  const verdict = verifyAgreementFile(text);
  const plan = embeddedPlan(text);
  const replayed = log ? replay(log) : null;
  if (replayed) {
    if (!replayed.charter) throw new Error('log has no session_open; is it a call log?');
    if (plan && replayed.charter.session !== plan.session) {
      throw new Error(`log is for session ${replayed.charter.session}, the agreement is for ${plan.session}`);
    }
    if (verdict.ok && replayed.frozen && replayed.frozen.hash !== verdict.planHash) {
      throw new Error(`log froze plan ${replayed.frozen.hash}, the agreement is ${verdict.planHash}`);
    }
  }
  const ctx: Context = {
    plan,
    verdict,
    log: replayed,
    checkpointKinds: replayed?.charter?.checkpoint_kinds ?? scenario.defaultCheckpointKinds,
  };
  const items = plan ? planItems(plan) : [];

  const results = scenario.criteria.map((c): CriterionResult => {
    const base = { id: c.id, title: c.title, type: c.type, required: c.required, weight: c.weight };
    if (c.type === 'process') return { ...base, ...runProcess(c.check, ctx) };
    if (!plan) return { ...base, pass: false, detail: 'no readable plan in the file' };
    const checks = c.requirements.map((r) => checkRequirement(r, items));
    return { ...base, pass: checks.every((x) => x.pass), detail: checks.map((x) => x.detail).join('; ') };
  });

  const total = results.reduce((sum, r) => sum + r.weight, 0);
  const earned = results.reduce((sum, r) => sum + (r.pass ? r.weight : 0), 0);
  const score = total === 0 ? 0 : earned / total;
  const requiredFailed = results.filter((r) => r.required && !r.pass).map((r) => r.id);
  return {
    scenario: scenario.id,
    verified: verdict.ok ? { ok: true, planHash: verdict.planHash } : { ok: false, reason: verdict.reason },
    logUsed: replayed !== null,
    results,
    earned,
    total,
    score,
    threshold: scenario.passThreshold,
    requiredFailed,
    pass: requiredFailed.length === 0 && score >= scenario.passThreshold,
  };
}

/** Plain-text PASS/FAIL table plus the score line. */
export function formatReport(report: EvalReport): string {
  const rows = [['CRITERION', 'RESULT', 'WEIGHT', 'DETAIL']];
  for (const r of report.results) {
    rows.push([`${r.id}${r.required ? '*' : ''}`, r.pass ? 'PASS' : 'FAIL', String(r.weight), r.detail]);
  }
  const widths = [0, 1, 2].map((i) => Math.max(...rows.map((row) => row[i]!.length)));
  const lines = [
    `scenario ${report.scenario}${report.logUsed ? ' (with call log)' : ''}`,
    report.verified.ok ? `verified plan_hash ${report.verified.planHash}` : `UNVERIFIED: ${report.verified.reason}; content results below are not signed by anyone`,
    '',
    ...rows.map((row) => row.map((cell, i) => (i < 3 ? cell.padEnd(widths[i]!) : cell)).join('  ').trimEnd()),
    '',
    '* required',
    `score ${report.earned}/${report.total} (${report.score.toFixed(2)}), threshold ${report.threshold.toFixed(2)}${
      report.requiredFailed.length ? `, required failed: ${report.requiredFailed.join(', ')}` : ''
    }`,
    report.pass ? 'PASS' : 'FAIL',
  ];
  return lines.join('\n');
}
