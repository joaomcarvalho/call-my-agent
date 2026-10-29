import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createSignoff,
  generateSigningKey,
  hashObject,
  markdownHash,
  renderAgreementFile,
  type Charter,
  type Decision,
  type Identity,
  type Party,
  type Plan,
  type SignoffBody,
} from '@cma/protocol';
import { callPaths } from '../plugin/server/store.ts';
import { Harness, connect, freezeSimplePlan, signAndClose, type Side } from '../plugin/test/fixtures/harness.ts';
import { loadScenario, parseLog, parseScenario, scoreAgreement, type EvalReport } from '../evals/score.ts';

setDefaultTimeout(30_000);

const ROOT = resolve(import.meta.dir, '..');
const CMA = join(ROOT, 'bin', 'cma');
const SAMPLE = readFileSync(join(ROOT, 'docs', 'examples', 'sample-agreement.md'), 'utf8');
const scenario = loadScenario('orders-billing');

const tmpDirs: string[] = [];
function tmpFile(name: string, text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cma-eval-'));
  tmpDirs.push(dir);
  const file = join(dir, name);
  writeFileSync(file, text);
  return file;
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function cmaEval(args: string[]): Promise<Run> {
  const proc = Bun.spawn([CMA, 'eval', ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

const results = (report: EvalReport): Record<string, boolean> => Object.fromEntries(report.results.map((r) => [r.id, r.pass]));
const detail = (report: EvalReport, id: string): string => report.results.find((r) => r.id === id)!.detail;

function samplePlan(): Plan {
  const marker = '\n<!-- cma-plan\n';
  const at = SAMPLE.lastIndexOf(marker);
  return JSON.parse(SAMPLE.slice(at + marker.length, SAMPLE.lastIndexOf('\n-->'))) as Plan;
}

/** A verifying agreement file for `plan`, signed by fresh demo human keys. */
function signedAgreement(plan: Plan): string {
  const charter = { mode: 'org', created_at: '2026-10-28T00:00:00.000Z' } as Charter;
  const frozen = { version: plan.version, hash: hashObject(plan), mdHash: markdownHash(plan) };
  const identities = {} as Record<Party, Identity>;
  const signoffs = {} as Record<Party, SignoffBody>;
  for (const party of ['A', 'B'] as const) {
    const human = generateSigningKey();
    identities[party] = { agent_key: generateSigningKey().keyId, human_key: human.keyId, human: plan.meta.parties[party], assurance: 'self_asserted' };
    signoffs[party] = createSignoff({
      session: plan.session,
      charterHash: plan.meta.charter_hash,
      mode: 'org',
      party,
      human: plan.meta.parties[party],
      frozen,
      decision: 'approve',
      humanSecretKey: human.secretKey,
      ts: '2026-10-28T12:00:00.000Z',
    });
  }
  return renderAgreementFile({ plan, charter, identities, signoffs });
}

const isPhoneDecision = (d: Decision): boolean => d.id.includes('phone');

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

describe('the committed sample agreement', () => {
  test('passes pagination, PII, ship_to and every process check, fails retries, and fails overall on the required retries criterion', () => {
    const report = scoreAgreement(scenario, SAMPLE);
    expect(results(report)).toEqual({
      pagination: true,
      pii: true,
      'ship-to': true,
      retries: false,
      'checkpoints-both-sides': true,
      'disagreements-resolved': true,
      'no-assumed-checkpoint-decisions': true,
      signatures: true,
    });
    expect(report.verified.ok).toBe(true);
    expect([report.earned, report.total]).toEqual([7, 8]);
    expect(report.requiredFailed).toEqual(['retries']);
    expect(report.pass).toBe(false);
    expect(detail(report, 'pii')).toContain('d-b-phone-masked');
    expect(detail(report, 'ship-to')).toContain('d-a-ship-to-window');
    expect(detail(report, 'checkpoints-both-sides')).toContain('plan proxy');
  });

  test('cma eval prints a PASS/FAIL row per criterion and the score, and exits 1', async () => {
    const run = await cmaEval([join(ROOT, 'docs', 'examples', 'sample-agreement.md')]);
    expect(run.code).toBe(1);
    expect(run.stdout).toMatch(/^pii\*\s+PASS\s/m);
    expect(run.stdout).toMatch(/^retries\*\s+FAIL\s/m);
    expect(run.stdout).toContain('score 7/8 (0.88), threshold 0.85, required failed: retries');
    expect(run.stdout.trimEnd().endsWith('FAIL')).toBe(true);
  });
});

describe('synthetic agreements', () => {
  test('dropping the phone decisions fails PII even though the sections still mention masking', () => {
    const plan = samplePlan();
    plan.decisions = plan.decisions.filter((d) => !isPhoneDecision(d));
    expect(plan.sections.some((s) => /never receive raw phone/.test(s.md))).toBe(true);
    const report = scoreAgreement(scenario, signedAgreement(plan));
    expect(report.verified.ok).toBe(true);
    expect(results(report).pii).toBe(false);
    expect(detail(report, 'pii')).toStartWith('missing:');
    expect(report.requiredFailed).toContain('pii');
  });

  test('a phone decision left agent-assumed fails PII and the agent-assumed process check', () => {
    const plan = samplePlan();
    for (const d of plan.decisions) if (isPhoneDecision(d)) d.decided_by = 'agent-assumed';
    const report = scoreAgreement(scenario, signedAgreement(plan));
    expect(results(report).pii).toBe(false);
    expect(detail(report, 'pii')).toMatch(/\(agent-assumed in [^)]*d-a-phone-all-responses/);
    expect(results(report)['no-assumed-checkpoint-decisions']).toBe(false);
  });

  test('a phone decision that negates masking does not count', () => {
    const plan = samplePlan();
    plan.decisions = plan.decisions.filter((d) => !isPhoneDecision(d));
    plan.decisions.push({ id: 'd-b-phone-raw', text: 'customer_phone is returned to billing and will not be masked by default.', kind: 'security_or_pii', decided_by: 'human-B', decided_in: null });
    const report = scoreAgreement(scenario, signedAgreement(plan));
    expect(results(report).pii).toBe(false);
    expect(detail(report, 'pii')).toContain('negated in d-b-phone-raw');
  });

  test('the sample plus a retry open item passes every criterion and cma eval exits 0', async () => {
    const plan = samplePlan();
    plan.open_items.push({
      id: 'oi-retry-idempotency',
      text: 'B retries POST /v2/orders on timeout up to 3 times; A has no idempotency key yet, so a retry can create a duplicate adjustment.',
      blocking: true,
      owner: 'A',
      status: 'open',
    });
    const text = signedAgreement(plan);
    const report = scoreAgreement(scenario, text);
    expect(report.results.every((r) => r.pass)).toBe(true);
    expect(report.pass).toBe(true);
    const run = await cmaEval([tmpFile('agreement.md', text)]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('score 8/8 (1.00)');
  });

  test('a disagreement with an empty resolution fails the disagreements check', () => {
    const plan = samplePlan();
    plan.disagreements.push({ id: 'x-count', text: 'Whether total_count stays in the list response.', resolution: 'TBD' });
    plan.disagreements.push({ id: 'x-date', text: 'The ship date for shipping_address.', resolution: 'open' });
    const report = scoreAgreement(scenario, signedAgreement(plan));
    expect(results(report)['disagreements-resolved']).toBe(false);
    expect(detail(report, 'disagreements-resolved')).toBe('no resolution: x-count');
  });
});

describe('tampered files', () => {
  test('a flipped body character fails the signatures check and the eval as a whole', async () => {
    const at = SAMPLE.indexOf('masked to the last 2 digits by default');
    const tampered = `${SAMPLE.slice(0, at)}unmasked${SAMPLE.slice(at + 'masked'.length)}`;
    const report = scoreAgreement(scenario, tampered);
    expect(results(report).signatures).toBe(false);
    expect(detail(report, 'signatures')).toBe('body differs from the rendered plan');
    expect(report.pass).toBe(false);
    const run = await cmaEval([tmpFile('tampered.md', tampered)]);
    expect(run.code).toBe(1);
    expect(run.stdout).toContain('UNVERIFIED: body differs from the rendered plan');
  });

  test('a retry item added to the embedded plan without re-signing still fails overall', () => {
    const plan = samplePlan();
    plan.open_items.push({ id: 'oi-retry', text: 'Idempotency key for POST /v2/orders retries.', blocking: true, owner: 'A', status: 'open' });
    const marker = '\n<!-- cma-plan\n';
    const tampered = `${SAMPLE.slice(0, SAMPLE.lastIndexOf(marker))}${marker}${JSON.stringify(plan)}\n-->\n`;
    const report = scoreAgreement(scenario, tampered);
    expect(results(report).retries).toBe(true);
    expect(results(report).signatures).toBe(false);
    expect(report.requiredFailed).toEqual(['signatures']);
    expect(report.pass).toBe(false);
  });
});

describe('with a call log', () => {
  let h: Harness;
  let alice: Side;
  let bob: Side;
  let agreementFile: string;
  let logFile: string;

  beforeAll(async () => {
    h = new Harness();
    alice = await h.side('alice');
    bob = await h.side('bob');
    const { session } = await connect(alice, bob);
    await freezeSimplePlan(alice, bob, session);
    const { a } = await signAndClose(alice, bob, session);
    agreementFile = a.path as string;
    logFile = callPaths(alice.home, session).log;
  });

  afterAll(async () => {
    await h.cleanup();
  });

  test('checkpoint answers are counted from the log, not the plan proxy', () => {
    const report = scoreAgreement(scenario, readFileSync(agreementFile, 'utf8'), parseLog(readFileSync(logFile, 'utf8')));
    expect(report.logUsed).toBe(true);
    expect(results(report).signatures).toBe(true);
    expect(results(report)['checkpoints-both-sides']).toBe(false);
    expect(detail(report, 'checkpoints-both-sides')).toBe('log: A answered 0, B answered 0');
    expect(detail(report, 'no-assumed-checkpoint-decisions')).toContain('from charter');
  });

  test('a log from another call is refused', async () => {
    const run = await cmaEval([join(ROOT, 'docs', 'examples', 'sample-agreement.md'), '--log', logFile]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('the agreement is for ses_uu7iflfnfva5qjob');
  });
});

describe('scenario files', () => {
  const minimal = (criterion: Record<string, unknown>): Record<string, unknown> => ({ id: 's', pass_threshold: 1, criteria: [criterion] });

  test('an invalid pattern, an unknown check and human_decided outside decisions are rejected', () => {
    expect(() => parseScenario(minimal({ id: 'c', title: 't', type: 'content', requirements: [{ label: 'l', in: ['decisions'], all: [['(']] }] }))).toThrow(
      'invalid pattern',
    );
    expect(() => parseScenario(minimal({ id: 'c', title: 't', type: 'process', check: 'vibes' }))).toThrow('check must be one of');
    expect(() =>
      parseScenario(minimal({ id: 'c', title: 't', type: 'content', requirements: [{ label: 'l', in: ['sections'], all: [['x']], human_decided: true }] })),
    ).toThrow('"human_decided" needs');
  });

  test('cma eval --scenario with an unknown name exits 1', async () => {
    const run = await cmaEval([join(ROOT, 'docs', 'examples', 'sample-agreement.md'), '--scenario', 'nope']);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('no scenario at');
  });
});
