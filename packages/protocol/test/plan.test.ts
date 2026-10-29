import { describe, expect, test } from 'bun:test';
import { hashObject } from '../src/canonical.ts';
import { PlanSchema, applyProposal, checkPlan, planHash, type ApplyResult } from '../src/plan.ts';
import { createPlanV0 } from '../src/templates.ts';
import type { CallType, Decision, JsonPatchOp, Plan } from '../src/types.ts';
import { artifact, fixtureCharter, versionTest } from './fixtures/transcript.ts';

const charter = fixtureCharter();
const budgets = charter.budgets;
const v0 = (): Plan => createPlanV0(charter, hashObject(charter), charter.invitee_label);

function withDecisions(decisions: Decision[]): Plan {
  return { ...v0(), decisions };
}

function apply(patch: JsonPatchOp[], by: 'A' | 'B' = 'A', plan: Plan = v0()) {
  return applyProposal(plan, patch, by, budgets);
}

function codeOf(result: ApplyResult): string {
  return result.ok ? 'ok' : result.code;
}

function expectCode(result: ApplyResult, code: string): void {
  expect(codeOf(result)).toBe(code);
}

describe('createPlanV0', () => {
  test('contract plans get context, interface, both impl notes, rollout and risks', () => {
    expect(v0().sections.map((s) => [s.id, s.owner, s.type])).toEqual([
      ['context', 'joint', 'prose'],
      ['interface', 'joint', 'interface'],
      ['a.impl_notes', 'A', 'prose'],
      ['b.impl_notes', 'B', 'prose'],
      ['rollout', 'joint', 'rollout'],
      ['risks', 'joint', 'risks'],
    ]);
  });

  test('other call types get context and notes', () => {
    for (const type of ['impact', 'plan', 'question'] satisfies CallType[]) {
      const plan = createPlanV0({ ...charter, type }, hashObject(charter), 'bob');
      expect(plan.sections.map((s) => [s.id, s.owner, s.type])).toEqual([
        ['context', 'joint', 'prose'],
        ['notes', 'joint', 'prose'],
      ]);
      expect(plan.meta.type).toBe(type);
    }
  });

  test('sync call type seeds goal, per-party findings, shared model and risks with empty md', () => {
    const plan = createPlanV0({ ...charter, type: 'sync' }, hashObject(charter), 'bob');
    expect(plan.meta.type).toBe('sync');
    expect(plan.sections).toEqual([
      { id: 'goal', title: 'Goal', type: 'prose', owner: 'joint', md: '' },
      { id: 'a.findings', title: 'Findings (A)', type: 'prose', owner: 'A', md: '' },
      { id: 'b.findings', title: 'Findings (B)', type: 'prose', owner: 'B', md: '' },
      { id: 'shared_model', title: 'Shared model', type: 'prose', owner: 'joint', md: '' },
      { id: 'risks', title: 'Risks', type: 'risks', owner: 'joint', md: '' },
    ]);
  });

  test('plan v0 is version 0 of the charter with both party labels fixed', () => {
    const plan = v0();
    expect(plan).toMatchObject({
      schema: 'cma-plan/1',
      session: charter.session,
      version: 0,
      parent: null,
      meta: { title: charter.topic, type: 'contract', parties: { A: charter.inviter.human, B: 'billing team' }, charter_hash: hashObject(charter) },
      decisions: [],
      disagreements: [],
      open_items: [],
      action_items: { A: [], B: [] },
    });
    expect(PlanSchema.safeParse(plan).success).toBe(true);
  });

  test('each plan v0 is a fresh object', () => {
    const a = v0();
    a.sections[0]!.md = 'changed';
    expect(v0().sections[0]!.md).toBe('');
  });
});

describe('PlanSchema', () => {
  test('rejects unknown fields at any level', () => {
    expect(PlanSchema.safeParse({ ...v0(), extra: 1 }).success).toBe(false);
    const plan = v0();
    expect(PlanSchema.safeParse({ ...plan, sections: [{ ...plan.sections[0]!, data: {} }] }).success).toBe(false);
  });

  test('rejects malformed hashes and enums', () => {
    expect(PlanSchema.safeParse(withDecisions([{ id: 'D1', text: 't', decided_by: 'agent-assumed', decided_in: 'sha256:nope' as never }])).success).toBe(false);
    expect(PlanSchema.safeParse(withDecisions([{ id: 'D1', text: 't', decided_by: 'someone' as never, decided_in: null }])).success).toBe(false);
  });

  test('rejects duplicate ids within a list', () => {
    const d: Decision = { id: 'D1', text: 't', decided_by: 'agent-assumed', decided_in: null };
    expect(PlanSchema.safeParse(withDecisions([d, d])).success).toBe(false);
    const plan = v0();
    expect(PlanSchema.safeParse({ ...plan, sections: [plan.sections[0]!, plan.sections[0]!] }).success).toBe(false);
  });

  test('accepts custom:<uri> section types and rejects unknown ones', () => {
    const plan = v0();
    expect(PlanSchema.safeParse({ ...plan, sections: [{ ...plan.sections[0]!, type: 'custom:https://example.com/s' }] }).success).toBe(true);
    expect(PlanSchema.safeParse({ ...plan, sections: [{ ...plan.sections[0]!, type: 'diagram' }] }).success).toBe(false);
  });
});

describe('planHash', () => {
  test('is the hash of the canonical plan, independent of key order', () => {
    const plan = v0();
    const reordered = Object.fromEntries(Object.entries(plan).reverse()) as unknown as Plan;
    expect(planHash(plan)).toBe(hashObject(plan));
    expect(planHash(reordered)).toBe(planHash(plan));
  });
});

describe('applyProposal', () => {
  test('applies to a copy, bumps the version and links the parent', () => {
    const plan = v0();
    const before = structuredClone(plan);
    const result = apply([versionTest(0), { op: 'replace', path: '/sections/0/md', value: 'context' }], 'A', plan);
    expect(plan).toEqual(before);
    if (!result.ok) throw new Error(result.detail);
    expect(result.plan.version).toBe(1);
    expect(result.plan.parent).toBe(planHash(plan));
    expect(result.plan.sections[0]!.md).toBe('context');
    expect(result.hash).toBe(planHash(result.plan));
  });

  test('later mutation of the patch does not leak into the result', () => {
    const value = { id: 'A1', text: 'original' };
    const result = apply([versionTest(0), { op: 'add', path: '/action_items/A/-', value }]);
    value.text = 'mutated';
    if (!result.ok) throw new Error(result.detail);
    expect(result.plan.action_items.A[0]!.text).toBe('original');
  });

  test('a patch must begin with a test of /version', () => {
    expectCode(apply([]), 'BAD_PATCH');
    expectCode(apply([{ op: 'replace', path: '/sections/0/md', value: 'x' }]), 'BAD_PATCH');
    expectCode(apply([{ op: 'replace', path: '/sections/0/md', value: 'x' }, versionTest(0)]), 'BAD_PATCH');
  });

  test('a version test with the wrong value is STALE_BASE', () => {
    expectCode(apply([versionTest(1)]), 'STALE_BASE');
    expectCode(apply([{ op: 'test', path: '/version', value: '0' }]), 'STALE_BASE');
  });

  test('malformed operations are BAD_PATCH', () => {
    expectCode(apply([versionTest(0), { op: 'frobnicate' } as unknown as JsonPatchOp]), 'BAD_PATCH');
    expectCode(apply([versionTest(0), { op: 'replace', path: 'sections/0/md', value: 'x' }]), 'BAD_PATCH');
    expectCode(apply([versionTest(0), { op: 'add', path: '/sections/0/md' }]), 'BAD_PATCH');
    expectCode(apply('not a patch' as unknown as JsonPatchOp[]), 'BAD_PATCH');
  });

  test('protected paths, their children and their ancestors cannot be written', () => {
    const paths = ['/schema', '/session', '/version', '/parent', '/meta/charter_hash', '/meta/parties', '/meta/parties/B', '/meta', ''];
    for (const path of paths) {
      expect({ path, code: codeOf(apply([versionTest(0), { op: 'replace', path, value: 'x' }])) }).toEqual({ path, code: 'BAD_PATCH' });
    }
    expectCode(apply([versionTest(0), { op: 'remove', path: '/meta/parties/A' }]), 'BAD_PATCH');
    expectCode(apply([versionTest(0), { op: 'move', from: '/meta/parties/A', path: '/meta/title' }]), 'BAD_PATCH');
    expectCode(apply([versionTest(0), { op: 'copy', from: '/meta/title', path: '/meta/parties/A' }]), 'BAD_PATCH');
  });

  test('protected paths may be read by test and copy', () => {
    const plan = v0();
    const result = apply([
      versionTest(0),
      { op: 'test', path: '/meta/parties/A', value: plan.meta.parties.A },
      { op: 'copy', from: '/meta/parties/A', path: '/sections/0/md' },
    ]);
    if (!result.ok) throw new Error(result.detail);
    expect(result.plan.sections[0]!.md).toBe(plan.meta.parties.A);
  });

  test('a patch that does not apply is BAD_PATCH', () => {
    expectCode(apply([versionTest(0), { op: 'replace', path: '/sections/9/md', value: 'x' }]), 'BAD_PATCH');
    expectCode(apply([versionTest(0), { op: 'test', path: '/sections/0/md', value: 'not empty' }]), 'BAD_PATCH');
    expectCode(apply([versionTest(0), { op: 'add', path: '/__proto__/polluted', value: true }]), 'BAD_PATCH');
  });

  test('a result that fails PlanSchema is BAD_PATCH', () => {
    expectCode(apply([versionTest(0), { op: 'add', path: '/sections/0/extra', value: 1 }]), 'BAD_PATCH');
    expectCode(apply([versionTest(0), { op: 'replace', path: '/sections/0/owner', value: 'C' }]), 'BAD_PATCH');
  });

  test('an artifact whose sha256 does not match its content is BAD_PATCH', () => {
    const good = artifact('spec', 'openapi-3.1', 'openapi: 3.1.0\n');
    expect(apply([versionTest(0), { op: 'add', path: '/sections/1/artifacts', value: [good] }]).ok).toBe(true);
    expectCode(apply([versionTest(0), { op: 'add', path: '/sections/1/artifacts', value: [{ ...good, content: 'openapi: 3.0.0\n' }] }]), 'BAD_PATCH');
  });

  test('a result over max_plan_bytes is TOO_LARGE', () => {
    const result = apply([versionTest(0), { op: 'replace', path: '/sections/0/md', value: 'x'.repeat(budgets.max_plan_bytes) }]);
    expectCode(result, 'TOO_LARGE');
  });

  test('B cannot add, change or remove anything in an A-owned section', () => {
    expectCode(apply([versionTest(0), { op: 'replace', path: '/sections/2/md', value: 'x' }], 'B'), 'OWNER_VIOLATION');
    expectCode(apply([versionTest(0), { op: 'add', path: '/sections/2/artifacts', value: [] }], 'B'), 'OWNER_VIOLATION');
    expectCode(apply([versionTest(0), { op: 'remove', path: '/sections/2' }], 'B'), 'OWNER_VIOLATION');
    expectCode(apply([versionTest(0), { op: 'replace', path: '/sections/0/owner', value: 'A' }], 'B'), 'OWNER_VIOLATION');
    expectCode(apply([versionTest(0), { op: 'replace', path: '/sections/3/md', value: 'x' }], 'A'), 'OWNER_VIOLATION');
  });

  test('a party may edit its own and joint sections, and reorder sections', () => {
    expect(apply([versionTest(0), { op: 'replace', path: '/sections/2/md', value: 'x' }], 'A').ok).toBe(true);
    expect(apply([versionTest(0), { op: 'replace', path: '/sections/0/md', value: 'x' }], 'B').ok).toBe(true);
    expect(apply([versionTest(0), { op: 'move', from: '/sections/2', path: '/sections/0' }], 'B').ok).toBe(true);
  });

  test('a party cannot add or change a decision attributed to the other human', () => {
    const add = (decided_by: Decision['decided_by']): JsonPatchOp[] => [
      versionTest(0),
      { op: 'add', path: '/decisions/-', value: { id: 'D9', text: 'x', decided_by, decided_in: null } },
    ];
    expectCode(apply(add('human-B'), 'A'), 'OWNER_VIOLATION');
    expectCode(apply(add('human-A'), 'B'), 'OWNER_VIOLATION');
    const base = withDecisions([
      { id: 'D1', text: 'theirs', decided_by: 'human-B', decided_in: null },
      { id: 'D2', text: 'assumed', decided_by: 'agent-assumed', decided_in: null },
    ]);
    expectCode(apply([versionTest(0), { op: 'replace', path: '/decisions/0/text', value: 'edited' }], 'A', base), 'OWNER_VIOLATION');
    expectCode(apply([versionTest(0), { op: 'replace', path: '/decisions/1/decided_by', value: 'human-B' }], 'A', base), 'OWNER_VIOLATION');
  });

  test('a party may record its own human’s decisions and leave the other human’s untouched', () => {
    const base = withDecisions([{ id: 'D1', text: 'theirs', decided_by: 'human-B', decided_in: null }]);
    const result = apply(
      [
        versionTest(0),
        { op: 'add', path: '/decisions/-', value: { id: 'D2', text: 'mine', decided_by: 'human-A', decided_in: null } },
        { op: 'add', path: '/decisions/-', value: { id: 'D3', text: 'assumed', decided_by: 'agent-assumed', decided_in: null } },
        { op: 'replace', path: '/sections/0/md', value: 'context' },
      ],
      'A',
      base,
    );
    expect(codeOf(result)).toBe('ok');
  });

  test('effectiveKinds are the kinds of added, changed and removed decisions in canonical order', () => {
    const base = withDecisions([
      { id: 'D1', text: 'keep', kind: 'security_or_pii', decided_by: 'human-A', decided_in: null },
      { id: 'D2', text: 'change', kind: 'deadline_commitment', decided_by: 'human-A', decided_in: null },
      { id: 'D3', text: 'drop', kind: 'data_retention', decided_by: 'human-A', decided_in: null },
    ]);
    const result = apply(
      [
        versionTest(0),
        { op: 'add', path: '/decisions/-', value: { id: 'D4', text: 'new', kind: 'scope_change', decided_by: 'agent-assumed', decided_in: null } },
        { op: 'replace', path: '/decisions/1/text', value: 'changed' },
        { op: 'remove', path: '/decisions/2' },
      ],
      'A',
      base,
    );
    if (!result.ok) throw new Error(result.detail);
    expect(result.effectiveKinds).toEqual(['data_retention', 'deadline_commitment', 'scope_change']);
  });

  test('removing a kind from a decision still reports the old kind', () => {
    const base = withDecisions([{ id: 'D1', text: 'x', kind: 'breaking_change', decided_by: 'human-A', decided_in: null }]);
    const result = apply([versionTest(0), { op: 'remove', path: '/decisions/0/kind' }], 'A', base);
    if (!result.ok) throw new Error(result.detail);
    expect(result.effectiveKinds).toEqual(['breaking_change']);
  });

  test('patches that leave decisions alone have no effective kinds', () => {
    const base = withDecisions([{ id: 'D1', text: 'x', kind: 'breaking_change', decided_by: 'human-A', decided_in: null }]);
    const result = apply([versionTest(0), { op: 'replace', path: '/sections/0/md', value: 'y' }], 'A', base);
    if (!result.ok) throw new Error(result.detail);
    expect(result.effectiveKinds).toEqual([]);
  });
});

describe('checkPlan', () => {
  test('accepts plan v0 and enforces the size budget', () => {
    expect(checkPlan(v0(), budgets.max_plan_bytes).ok).toBe(true);
    expect(checkPlan(v0(), 10)).toMatchObject({ ok: false, code: 'TOO_LARGE' });
    expect(checkPlan({ ...v0(), version: -1 }, budgets.max_plan_bytes)).toMatchObject({ ok: false, code: 'BAD_PATCH' });
  });
});
