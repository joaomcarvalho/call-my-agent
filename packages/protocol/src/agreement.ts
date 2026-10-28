import { canonicalString, hashObject, sha256Hash } from './canonical.ts';
import { signObject, signingKeyFromSecret, verifyObject } from './keys.ts';
import { PlanSchema } from './plan.ts';
import { renderMarkdown } from './render.ts';
import type { Charter, Hash, Identity, KeyId, Mode, Party, Plan, SignoffBody, SignoffStatement } from './types.ts';
import { PARTIES, PROTOCOL_VERSION } from './types.ts';

export interface FrozenPlan {
  version: number;
  hash: Hash;
  mdHash: Hash;
}

export interface CreateSignoffArgs {
  session: string;
  charterHash: Hash;
  mode: Mode;
  party: Party;
  human: string;
  frozen: FrozenPlan;
  decision: 'approve' | 'decline';
  humanSecretKey: Uint8Array;
  ts: string;
}

/** Builds and signs a SignoffStatement with the human's key. */
export function createSignoff(args: CreateSignoffArgs): SignoffBody {
  const humanKey = signingKeyFromSecret(args.humanSecretKey).keyId;
  const statement: SignoffStatement = {
    v: PROTOCOL_VERSION,
    session: args.session,
    decision: args.decision,
    version: args.frozen.version,
    plan_hash: args.frozen.hash,
    md_hash: args.frozen.mdHash,
    mode: args.mode,
    charter_hash: args.charterHash,
    party: args.party,
    human: args.human,
    human_key: humanKey,
    ts: args.ts,
  };
  return { statement, human_sig: signObject(statement, args.humanSecretKey) };
}

export function verifySignoffSignature(body: SignoffBody): boolean {
  return verifyObject(body.statement, body.human_sig, body.statement.human_key);
}

export interface AgreementInput {
  plan: Plan;
  charter: Charter;
  identities: Record<Party, Identity>;
  signoffs: Record<Party, SignoffBody>;
}

function slugify(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return slug || 'agreement';
}

/** `<YYYY-MM-DD of charter.created_at>-<slug of plan title>.md` */
export function agreementFileName(plan: Plan, charter: Charter): string {
  return `${charter.created_at.slice(0, 10)}-${slugify(plan.meta.title)}.md`;
}

// Front-matter values are written as JSON strings so any character round-trips.
const q = (value: string): string => JSON.stringify(value);

/** Deterministic agreement file; byte-identical for both parties given the same inputs. */
export function renderAgreementFile(input: AgreementInput): string {
  const { plan, charter, identities, signoffs } = input;
  const valid = PlanSchema.safeParse(plan);
  if (!valid.success) throw new Error(`plan is not a valid plan: ${schemaIssue(valid.error)}`);
  const body = renderMarkdown(plan);
  const planHash = hashObject(plan);
  const mdHash = sha256Hash(body);
  for (const party of PARTIES) {
    const s = signoffs[party].statement;
    if (
      s.decision !== 'approve' ||
      s.plan_hash !== planHash ||
      s.md_hash !== mdHash ||
      s.party !== party ||
      s.version !== plan.version ||
      s.session !== plan.session ||
      s.mode !== charter.mode ||
      s.charter_hash !== plan.meta.charter_hash
    ) {
      throw new Error(`signoff of party ${party} does not approve this plan`);
    }
    if (s.human_key !== identities[party].human_key || !verifySignoffSignature(signoffs[party])) {
      throw new Error(`signoff of party ${party} has an invalid signature`);
    }
  }
  const lines = [
    '---',
    'cma: "0.1"',
    `session: ${q(plan.session)}`,
    `mode: ${q(charter.mode)}`,
    `version: ${plan.version}`,
    `plan_hash: ${q(planHash)}`,
    `md_hash: ${q(mdHash)}`,
    `charter_hash: ${q(plan.meta.charter_hash)}`,
    'parties:',
    ...PARTIES.flatMap((party) => [
      `  ${party}:`,
      `    human: ${q(signoffs[party].statement.human)}`,
      `    agent_key: ${q(identities[party].agent_key)}`,
      `    human_key: ${q(identities[party].human_key)}`,
    ]),
    'signoffs:',
    ...PARTIES.flatMap((party) => [
      `  ${party}:`,
      `    signed_at: ${q(signoffs[party].statement.ts)}`,
      `    sig: ${q(signoffs[party].human_sig)}`,
    ]),
    '---',
    '',
  ];
  return `${lines.join('\n')}${body}\n<!-- cma-plan\n${canonicalString(plan)}\n-->\n`;
}

export interface AgreementSigner {
  human: string;
  human_key: KeyId;
  agent_key: KeyId;
  signed_at: string;
}

export type AgreementVerdict = { ok: true; planHash: Hash; signers: Record<Party, AgreementSigner> } | { ok: false; reason: string };

export interface AgreementExpectations {
  /** Human keys the caller already trusts for each party; a file signed by any other key fails. */
  humanKeys?: Partial<Record<Party, KeyId>>;
}

function schemaIssue(error: { issues: { path: (string | number)[]; message: string }[] }): string {
  const issue = error.issues[0];
  return issue ? `${issue.path.join('/')}: ${issue.message}` : 'invalid';
}

interface ParsedFrontMatter {
  session: string;
  mode: Mode;
  version: number;
  plan_hash: string;
  md_hash: string;
  charter_hash: string;
  parties: Record<Party, { human: string; agent_key: string; human_key: string }>;
  signoffs: Record<Party, { signed_at: string; sig: string }>;
}

function parseFrontMatter(lines: string[]): ParsedFrontMatter {
  const out: Record<string, unknown> = {};
  let section: 'parties' | 'signoffs' | null = null;
  let party: Party | null = null;
  for (const line of lines) {
    let m: RegExpExecArray | null;
    if ((m = /^(parties|signoffs):$/.exec(line))) {
      section = m[1] as 'parties' | 'signoffs';
      out[section] = {};
      party = null;
    } else if (section && (m = /^ {2}(A|B):$/.exec(line))) {
      party = m[1] as Party;
      (out[section] as Record<string, unknown>)[party] = {};
    } else if (section && party && (m = /^ {4}([a-z_]+): (".*")$/.exec(line))) {
      ((out[section] as Record<string, Record<string, unknown>>)[party]!)[m[1]!] = JSON.parse(m[2]!);
    } else if ((m = /^([a-z_]+): (.*)$/.exec(line))) {
      section = null;
      out[m[1]!] = JSON.parse(m[2]!);
    } else {
      throw new Error(`unexpected front matter line: ${line}`);
    }
  }
  return out as unknown as ParsedFrontMatter;
}

/**
 * Checks an agreement file: embedded plan, rendered body, both hashes and both human signatures.
 * Without `expected.humanKeys` the signatures only prove the file is self-consistent, not who signed it.
 */
export function verifyAgreementFile(text: string, expected: AgreementExpectations = {}): AgreementVerdict {
  const fmMatch = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!fmMatch) return { ok: false, reason: 'missing front matter' };
  const tail = text.slice(fmMatch[0].length);
  const marker = '\n<!-- cma-plan\n';
  const at = tail.lastIndexOf(marker);
  if (at < 0 || !tail.endsWith('\n-->\n')) return { ok: false, reason: 'missing embedded plan' };
  const body = tail.slice(0, at);
  const planJson = tail.slice(at + marker.length, tail.length - '\n-->\n'.length);

  let fm: ParsedFrontMatter;
  let plan: Plan;
  try {
    fm = parseFrontMatter(fmMatch[1]!.split('\n'));
    plan = JSON.parse(planJson) as Plan;
  } catch (err) {
    return { ok: false, reason: `unparseable file: ${(err as Error).message}` };
  }

  const valid = PlanSchema.safeParse(plan);
  if (!valid.success) return { ok: false, reason: `embedded plan is not a valid plan: ${schemaIssue(valid.error)}` };
  const planHash = hashObject(plan);
  if (planJson !== canonicalString(plan)) return { ok: false, reason: 'embedded plan is not canonical JSON' };
  if (planHash !== fm.plan_hash) return { ok: false, reason: 'embedded plan does not match plan_hash' };
  let rendered: string;
  try {
    rendered = renderMarkdown(plan);
  } catch (err) {
    return { ok: false, reason: `embedded plan does not render: ${(err as Error).message}` };
  }
  if (rendered !== body) return { ok: false, reason: 'body differs from the rendered plan' };
  const mdHash = sha256Hash(body);
  if (mdHash !== fm.md_hash) return { ok: false, reason: 'body does not match md_hash' };
  if (plan.session !== fm.session || plan.version !== fm.version || plan.meta.charter_hash !== fm.charter_hash) {
    return { ok: false, reason: 'front matter does not match the embedded plan' };
  }

  const signers = {} as Record<Party, AgreementSigner>;
  for (const party of PARTIES) {
    const who = fm.parties?.[party];
    const sig = fm.signoffs?.[party];
    if (!who || !sig) return { ok: false, reason: `missing party ${party}` };
    const trusted = expected.humanKeys?.[party];
    if (trusted !== undefined && who.human_key !== trusted) return { ok: false, reason: `unexpected key for party ${party}` };
    const statement: SignoffStatement = {
      v: PROTOCOL_VERSION,
      session: plan.session,
      decision: 'approve',
      version: plan.version,
      plan_hash: planHash,
      md_hash: mdHash,
      mode: fm.mode,
      charter_hash: plan.meta.charter_hash,
      party,
      human: who.human,
      human_key: who.human_key as KeyId,
      ts: sig.signed_at,
    };
    if (!verifyObject(statement, sig.sig, who.human_key)) {
      return { ok: false, reason: `signature of party ${party} does not verify` };
    }
    signers[party] = { human: who.human, human_key: who.human_key as KeyId, agent_key: who.agent_key as KeyId, signed_at: sig.signed_at };
  }
  return { ok: true, planHash, signers };
}
