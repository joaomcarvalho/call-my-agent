import { describe, expect, test } from 'bun:test';
import {
  agreementFileName,
  createSignoff,
  renderAgreementFile,
  verifyAgreementFile,
  verifySignoffSignature,
  type AgreementInput,
} from '../src/agreement.ts';
import type { Party, SignoffBody } from '../src/types.ts';
import { KEYS, workedTranscript } from './fixtures/transcript.ts';

function agreedInput(): AgreementInput {
  const result = workedTranscript().t.state();
  const signoffs = {} as Record<Party, SignoffBody>;
  for (const party of ['A', 'B'] as const) {
    const s = result.signoffs[party]!;
    signoffs[party] = { statement: s.statement, human_sig: s.human_sig };
  }
  return {
    plan: result.plan!,
    charter: result.charter!,
    identities: { A: result.identities.A!, B: result.identities.B! },
    signoffs,
  };
}

describe('agreement file', () => {
  test('a rendered agreement verifies and names both signers', () => {
    const verdict = verifyAgreementFile(renderAgreementFile(agreedInput()));
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.signers.A.human_key).toBe(KEYS.humanA.keyId);
      expect(verdict.signers.B.human_key).toBe(KEYS.humanB.keyId);
    }
  });

  test('rendering is deterministic', () => {
    expect(renderAgreementFile(agreedInput())).toBe(renderAgreementFile(agreedInput()));
  });

  test('file name uses the charter date and a slug of the title', () => {
    const input = agreedInput();
    expect(agreementFileName(input.plan, input.charter)).toBe('2026-10-28-order-list-api-for-billing.md');
  });

  test('a changed character in the body fails with a body mismatch', () => {
    const text = renderAgreementFile(agreedInput()).replace('opaque cursor pagination', 'opaque Cursor pagination');
    const verdict = verifyAgreementFile(text);
    expect(verdict).toEqual({ ok: false, reason: 'body differs from the rendered plan' });
  });

  test('a changed embedded plan fails with a plan hash mismatch', () => {
    const text = renderAgreementFile(agreedInput());
    const tampered = text.replace(/("text":"List endpoints use opaque cursor pagination)/, '$1!');
    expect(tampered).not.toBe(text);
    expect(verifyAgreementFile(tampered)).toEqual({ ok: false, reason: 'embedded plan does not match plan_hash' });
  });

  test('a changed signature fails for that party', () => {
    const input = agreedInput();
    const text = renderAgreementFile(input);
    const sig = input.signoffs.B.human_sig;
    const flipped = sig.slice(0, 10) + (sig[10] === 'A' ? 'B' : 'A') + sig.slice(11);
    expect(verifyAgreementFile(text.replace(sig, flipped))).toEqual({
      ok: false,
      reason: 'signature of party B does not verify',
    });
  });

  test('rendering refuses a signoff that approves a different plan', () => {
    const input = agreedInput();
    const forged = createSignoff({
      session: input.plan.session,
      charterHash: input.plan.meta.charter_hash,
      mode: input.charter.mode,
      party: 'B',
      human: 'bob@billing.example',
      frozen: { version: 1, hash: input.signoffs.B.statement.plan_hash, mdHash: input.signoffs.B.statement.md_hash },
      decision: 'approve',
      humanSecretKey: KEYS.humanB.secretKey,
      ts: '2026-10-28T15:00:00.000Z',
    });
    expect(() => renderAgreementFile({ ...input, signoffs: { ...input.signoffs, B: forged } })).toThrow();
  });

  test('createSignoff produces a signature by the human key', () => {
    const input = agreedInput();
    const s = input.signoffs.A.statement;
    const body = createSignoff({
      session: s.session,
      charterHash: s.charter_hash,
      mode: s.mode,
      party: 'A',
      human: s.human,
      frozen: { version: s.version, hash: s.plan_hash, mdHash: s.md_hash },
      decision: 'approve',
      humanSecretKey: KEYS.humanA.secretKey,
      ts: s.ts,
    });
    expect(body.statement.human_key).toBe(KEYS.humanA.keyId);
    expect(verifySignoffSignature(body)).toBe(true);
    expect(body).toEqual(input.signoffs.A);
  });
});
