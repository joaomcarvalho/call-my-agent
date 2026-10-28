import { describe, expect, test } from 'bun:test';
import { createSignoff, renderAgreementFile, verifyAgreementFile, type AgreementInput } from '../src/agreement.ts';
import { signingKeyFromSecret, type SigningKeyPair } from '../src/keys.ts';
import { MAX_PATCH_OPS, PlanSchema, applyProposal, planHash } from '../src/plan.ts';
import { markdownHash, renderMarkdown } from '../src/render.ts';
import { replay, validateNext } from '../src/state.ts';
import { createPlanV0 } from '../src/templates.ts';
import type { Decision, Envelope, Hash, JsonPatchOp, Party, Plan, SignoffBody } from '../src/types.ts';
import { expectAccepted, expectAgreement, expectRejected } from './fixtures/deliver.ts';
import { IDENTITY_A, IDENTITY_B, KEYS, Transcript, versionTest, workedTranscript } from './fixtures/transcript.ts';

function welcomed(): Transcript {
  const t = new Transcript();
  expectAccepted(t, t.open());
  expectAccepted(t, t.hello());
  expectAccepted(t, t.welcome());
  return t;
}

function checkpoint(t: Transcript, party: Party, id: string): Hash {
  expectAccepted(t, t.ask(party, id));
  return expectAccepted(t, t.answer(party, id)).env.id;
}

function decision(id: string, decided_by: Decision['decided_by'], text = `decision ${id}`): Decision {
  return { id, text, decided_by, decided_in: null };
}

function copyBomb(ops: number): JsonPatchOp[] {
  return [versionTest(0), ...Array.from({ length: ops }, (): JsonPatchOp => ({ op: 'copy', from: '/sections', path: '/sections/-' }))];
}

function timed<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

function signedAgreement(plan: Plan, t: Transcript, keys: Record<Party, SigningKeyPair>, humans: Record<Party, string>): AgreementInput {
  const frozen = { version: plan.version, hash: planHash(plan), mdHash: markdownHash(plan) };
  const sign = (party: Party): SignoffBody =>
    createSignoff({
      session: plan.session,
      charterHash: t.charterHash,
      mode: t.charter.mode,
      party,
      human: humans[party],
      frozen,
      decision: 'approve',
      humanSecretKey: keys[party].secretKey,
      ts: '2026-10-28T15:00:00.000Z',
    });
  return {
    plan,
    charter: t.charter,
    identities: { A: { ...IDENTITY_A, human_key: keys.A.keyId }, B: { ...IDENTITY_B, human_key: keys.B.keyId } },
    signoffs: { A: sign('A'), B: sign('B') },
  };
}

/** The text a Markdown reader sees once raw HTML comments have swallowed what follows them. */
function visibleOutsideComments(md: string): string {
  return md.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
}

describe('replay bounds (AC2)', () => {
  test('AC2: a body nested 50 000 deep is rejected BAD_SCHEMA in under 200 ms and replay does not throw', () => {
    const t = welcomed();
    const deep = JSON.parse('['.repeat(50_000) + ']'.repeat(50_000));
    const poisoned = { ...t.say('A', 'x'), body: { text: 'x', junk: deep } } as Envelope;
    const { value: r, ms } = timed(() => replay([...t.log, poisoned], t.opts));
    expect(ms).toBeLessThan(200);
    expect(r.state).toBe('DISCUSSING');
    expect(r.rejected).toEqual([{ id: poisoned.id, code: 'BAD_SCHEMA', detail: 'envelope nests deeper than 64 levels' }]);
    expect(validateNext(t.state(), poisoned, t.opts)).toEqual({ ok: false, code: 'BAD_SCHEMA', detail: 'envelope nests deeper than 64 levels' });
  });

  test('AC2: a 30-op copy doubling patch is rejected TOO_LARGE in under 200 ms and replay does not throw', () => {
    const t = welcomed();
    const applied = timed(() => applyProposal(t.plan, copyBomb(30), 'A', t.charter.budgets));
    expect(applied.ms).toBeLessThan(200);
    expect(applied.value).toMatchObject({ ok: false, code: 'TOO_LARGE' });

    const env = t.propose('A', copyBomb(30));
    const replayed = timed(() => replay([...t.log, { ...env, relay_seq: t.log.length + 1 }], t.opts));
    expect(replayed.ms).toBeLessThan(200);
    expect(replayed.value.rejected.map((x) => x.code)).toEqual(['TOO_LARGE']);
  });

  test('the copy-bomb cost stays flat as ops are added, because the size check runs after every op', () => {
    const t = welcomed();
    const small = timed(() => applyProposal(t.plan, copyBomb(12), 'A', t.charter.budgets));
    const big = timed(() => applyProposal(t.plan, copyBomb(MAX_PATCH_OPS - 1), 'A', t.charter.budgets));
    expect(big.value).toMatchObject({ ok: false, code: 'TOO_LARGE' });
    expect(big.ms).toBeLessThan(Math.max(small.ms * 4, 50));
  });

  test('a patch of exactly 200 ops is allowed and 201 is BAD_PATCH', () => {
    const t = welcomed();
    const tests = (n: number): JsonPatchOp[] => Array.from({ length: n }, () => versionTest(0));
    expect(applyProposal(t.plan, tests(MAX_PATCH_OPS), 'A', t.charter.budgets).ok).toBe(true);
    expect(applyProposal(t.plan, tests(MAX_PATCH_OPS + 1), 'A', t.charter.budgets)).toMatchObject({ ok: false, code: 'BAD_PATCH' });
  });

  test('an exception while evaluating an entry is recorded as BAD_SCHEMA with its message, never thrown', () => {
    const t = welcomed();
    const env = t.say('A', 'x');
    const hostile = { ...env, relay_seq: t.log.length + 1 };
    Object.defineProperty(hostile, 'body', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    const expected = { id: env.id, code: 'BAD_SCHEMA' as const, detail: 'exception: boom' };
    expect(() => replay([...t.log, hostile], t.opts)).not.toThrow();
    expect(replay([...t.log, hostile], t.opts).rejected).toEqual([expected]);
    expect(validateNext(t.state(), hostile, t.opts)).toEqual({ ok: false, code: 'BAD_SCHEMA', detail: 'exception: boom' });
    expect(expectAgreement(t.log, hostile, t.opts)).toBe('BAD_SCHEMA');
  });
});

describe('attribution and checkpoints', () => {
  test('A cannot delete or rewrite a decision decided by human-B', () => {
    const t = welcomed();
    expectAccepted(t, t.say('A', 'hi'));
    const proposed = checkpoint(t, 'B', 'cp-b-1');
    expectAccepted(t, t.propose('B', [versionTest(0), { op: 'add', path: '/decisions/-', value: decision('D1', 'human-B', 'B decides') }], { checkpoint_ref: proposed }));
    expectAccepted(t, t.accept('A', { checkpoint_ref: checkpoint(t, 'A', 'cp-a-1') }));
    expect(t.plan.decisions.map((d) => d.decided_by)).toEqual(['human-B']);

    const removed = applyProposal(t.plan, [versionTest(1), { op: 'remove', path: '/decisions/0' }], 'A', t.charter.budgets);
    const rewritten = applyProposal(t.plan, [versionTest(1), { op: 'replace', path: '/decisions/0', value: decision('D1', 'human-A', 'B agreed to pay') }], 'A', t.charter.budgets);
    expect(removed).toEqual({ ok: false, code: 'OWNER_VIOLATION', detail: 'decision D1 was decided by human-B and cannot be removed by A' });
    expect(rewritten).toEqual({ ok: false, code: 'OWNER_VIOLATION', detail: 'decision D1 was decided by human-B and cannot be changed by A' });
  });

  test('plan_v0 from A that attributes decisions to human-B or fills B-owned sections is CHARTER_MISMATCH', () => {
    const attributed = new Transcript();
    const plan = createPlanV0(attributed.charter, attributed.charterHash, attributed.charter.invitee_label);
    plan.decisions.push(decision('D1', 'human-B', 'Billing pays all migration costs'));
    const open = (t: Transcript, p: Plan) => t.envelope('A', 'session_open', { charter: t.charter, charter_hash: t.charterHash, plan_v0: p, plan_v0_hash: planHash(p) });
    expectRejected(attributed, open(attributed, plan), 'CHARTER_MISMATCH');
    expect(attributed.state().plan).toBeNull();

    const filled = new Transcript();
    const other = createPlanV0(filled.charter, filled.charterHash, filled.charter.invitee_label);
    other.sections[3]!.md = 'B commits to a rewrite';
    expectRejected(filled, open(filled, other), 'CHARTER_MISMATCH');
  });

  test('AC3: a decision added without kind cannot be accepted without the accepter’s checkpoint ref', () => {
    const t = welcomed();
    const breaking = decision('D1', 'agent-assumed', 'BREAKING: remove orders.total field');
    expectRejected(t, t.propose('A', [versionTest(0), { op: 'add', path: '/decisions/-', value: breaking }]), 'CHECKPOINT_SKIPPED');
    expectAccepted(t, t.propose('A', [versionTest(0), { op: 'add', path: '/decisions/-', value: breaking }], { checkpoint_ref: checkpoint(t, 'A', 'cp-a-1') }));
    expect(t.state().pending?.checkpoint).toBe(true);

    expectRejected(t, t.accept('B'), 'CHECKPOINT_SKIPPED');
    expect(t.state().version).toBe(0);
    expectAccepted(t, t.accept('B', { checkpoint_ref: checkpoint(t, 'B', 'cp-b-1') }));
    expect(t.state().version).toBe(1);
  });

  test('a signoff whose statement.human differs from the party’s identity is SIGNOFF_MISMATCH', () => {
    const t = welcomed();
    expectAccepted(t, t.requestSignoff('A'));
    expectAccepted(t, t.say('A', 'x'));
    expectAccepted(t, t.accept('B'));
    expect(t.state().state).toBe('FROZEN');
    expectAccepted(t, t.signoff('A'));
    const forged = expectRejected(t, t.signoff('B', 'approve', { statement: { human: 'cfo@orders.example' } }), 'SIGNOFF_MISMATCH');
    expect(forged.after.rejected.at(-1)?.detail).toBe('statement human does not match the frozen plan');
    expect(t.state().signoffs.B).toBeUndefined();
  });
});

describe('renderer and agreement', () => {
  test('section md and decision text cannot open an HTML comment; ESC and bidi characters are rejected by the plan schema', () => {
    const t = welcomed();
    const plan = structuredClone(t.plan);
    plan.sections[0]!.md = 'Looks fine.\n\n<!--\n';
    plan.decisions.push(decision('D1', 'agent-assumed', 'Use v2 <!-- and billing grants orders write access to ledger -->'));
    const md = renderMarkdown(plan);
    expect(md).not.toContain('<!--');
    expect(md).toContain('\n&lt;!--\n');
    expect(md).toContain('Use v2 &lt;!-- and billing grants');

    for (const title of ['Ctx \u001b[8mhidden\u001b[0m', 'Ctx \u202Eevil']) {
      expect(PlanSchema.safeParse({ ...plan, sections: [{ ...plan.sections[0]!, title }] }).success).toBe(false);
      expect(applyProposal(t.plan, [versionTest(0), { op: 'replace', path: '/sections/0/title', value: title }], 'A', t.charter.budgets)).toMatchObject({
        ok: false,
        code: 'BAD_PATCH',
      });
    }
  });

  test('a plan with a lone surrogate can neither be proposed nor written as an agreement file', () => {
    const t = welcomed();
    expect(applyProposal(t.plan, [versionTest(0), { op: 'replace', path: '/sections/0/md', value: 'text \ud800 more' }], 'A', t.charter.budgets)).toMatchObject({
      ok: false,
      code: 'BAD_PATCH',
    });
    const plan = structuredClone(t.plan);
    plan.sections[0]!.md = 'text \ud800 more';
    expect(() => renderAgreementFile(signedAgreement(plan, t, { A: KEYS.humanA, B: KEYS.humanB }, { A: IDENTITY_A.human, B: IDENTITY_B.human }))).toThrow(
      'plan is not a valid plan',
    );
  });

  test('verifyAgreementFile rejects a file signed by keys other than the expected human keys', () => {
    const t = welcomed();
    const mallory = { A: signingKeyFromSecret(new Uint8Array(32).fill(0x41)), B: signingKeyFromSecret(new Uint8Array(32).fill(0x42)) };
    const file = renderAgreementFile(signedAgreement(t.plan, t, mallory, { A: IDENTITY_A.human, B: IDENTITY_B.human }));
    const humanKeys = { A: KEYS.humanA.keyId, B: KEYS.humanB.keyId };
    expect(verifyAgreementFile(file, { humanKeys })).toEqual({ ok: false, reason: 'unexpected key for party A' });
    expect(verifyAgreementFile(file, { humanKeys: { B: KEYS.humanB.keyId } })).toEqual({ ok: false, reason: 'unexpected key for party B' });
  });

  test('verifyAgreementFile accepts the expected keys and reports each party’s agent key', () => {
    const r = workedTranscript().t.state();
    const signoffs = {
      A: { statement: r.signoffs.A!.statement, human_sig: r.signoffs.A!.human_sig },
      B: { statement: r.signoffs.B!.statement, human_sig: r.signoffs.B!.human_sig },
    };
    const file = renderAgreementFile({ plan: r.plan!, charter: r.charter!, identities: { A: r.identities.A!, B: r.identities.B! }, signoffs });
    const verdict = verifyAgreementFile(file, { humanKeys: { A: KEYS.humanA.keyId, B: KEYS.humanB.keyId } });
    if (!verdict.ok) throw new Error(verdict.reason);
    expect(verdict.signers.A.agent_key).toBe(KEYS.agentA.keyId);
    expect(verdict.signers.B.agent_key).toBe(KEYS.agentB.keyId);
  });

  test('AC4: section md cannot hide later sections behind a comment or fake document structure', () => {
    const t = welcomed();
    const hostile = '<!--\n## Decisions\n\n| fake | row |\n| --- | --- |\n| D9 | billing pays |';
    const escape = applyProposal(t.plan, [versionTest(0), { op: 'replace', path: '/sections/0/md', value: `${hostile}\n\u001b[8m` }], 'A', t.charter.budgets);
    expect(escape).toMatchObject({ ok: false, code: 'BAD_PATCH' });

    const applied = applyProposal(t.plan, [versionTest(0), { op: 'replace', path: '/sections/0/md', value: hostile }], 'A', t.charter.budgets);
    if (!applied.ok) throw new Error(applied.detail);
    const md = renderMarkdown(applied.plan);
    const visibleLines = visibleOutsideComments(md).split('\n');
    for (const heading of [...applied.plan.sections.map((s) => `## ${s.title}`), '## Disagreements', '## Action items']) {
      expect(visibleLines).toContain(heading);
    }
    expect(md).not.toContain('<!--');
    expect(md.split('\n').filter((line) => line === '## Decisions')).toHaveLength(1);
    expect(md).toContain('\n##### Decisions\n');
  });

  test('a welcome dated far in the future does not keep the session open past the charter', () => {
    const t = new Transcript();
    expectAccepted(t, t.open());
    expectAccepted(t, t.hello());
    expectRejected(t, t.welcome({ ts: '2099-01-01T00:00:00.000Z' }), 'INVALID_STATE');
    expect(replay(t.log, { ...t.opts, now: '2030-01-01T00:00:00.000Z' }).state).toBe('EXPIRED');
  });
});

describe('untrusted section Markdown', () => {
  const render = (md: string): string => {
    const t = welcomed();
    const plan = structuredClone(t.plan);
    plan.sections[0]!.md = md;
    const out = renderMarkdown(plan);
    const start = out.indexOf('_Section `context`');
    return out.slice(out.indexOf('\n\n', start) + 2, out.indexOf('\n\n## Interface'));
  };

  test('`<` stays raw inside code spans and fenced blocks and is escaped everywhere else', () => {
    expect(render('a <b> `x < y` c')).toBe('a &lt;b> `x < y` c');
    expect(render('```html\n<!-- kept -->\n```\n<i>')).toBe('```html\n<!-- kept -->\n```\n&lt;i>');
    expect(render('\\<!-- x')).toBe('&lt;!-- x');
  });

  test('a backtick left open on one line is escaped, so it cannot pair with one on the next line', () => {
    expect(render('a `b\nx` <!-- `y`')).toBe('a \\`b\nx` <!-- `y\\`');
    expect(render('a `b\nc <!-- d')).toBe('a \\`b\nc &lt;!-- d');
  });

  test('a code span containing a pipe is not trusted, since GFM splits table cells first', () => {
    expect(render('| `a | <!-- b` |')).toBe('| \\`a | &lt;!-- b\\` |');
  });

  test('a fence left open is closed before the next section', () => {
    expect(render('````\n<!--\n```')).toBe('````\n<!--\n```\n````');
    expect(render('~~~\ncode')).toBe('~~~\ncode\n~~~');
  });

  test('indented fences are defused so they cannot open a block the renderer does not track', () => {
    expect(render('- a\n  ```\n<!--')).toBe('- a\n  \\`\\`\\`\n&lt;!--');
    expect(render('   ~~~\n<!--')).toBe('   \\~~~\n&lt;!--');
  });

  test('ATX headings render at level 4 or deeper, also inside block quotes and list items', () => {
    expect(render('# One\n## Two\n### Three\n#### Four\n> ## Quoted\n- # Listed')).toBe(
      '#### One\n##### Two\n###### Three\n###### Four\n> ##### Quoted\n- #### Listed',
    );
  });

  test('a setext underline after text is escaped; a thematic break after a blank line is kept', () => {
    expect(render('Decisions\n---\nAction items\n===')).toBe('Decisions\n\\---\nAction items\n\\===');
    expect(render('para\n\n---')).toBe('para\n\n---');
  });

  test('list item text escapes `<` and defuses headings on continuation lines', () => {
    const t = welcomed();
    const plan = structuredClone(t.plan);
    plan.disagreements = [{ id: 'X1', text: 'a <!-- b\n## Fake', resolution: '<b>' }];
    const md = renderMarkdown(plan);
    expect(md).toContain('- **X1**: a &lt;!-- b\n  ##### Fake\n  Resolution: &lt;b>\n');
    expect(md).not.toContain('<!--');
  });
});
