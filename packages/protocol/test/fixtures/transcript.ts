import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { hashObject, sha256Hash } from '../../src/canonical.ts';
import { signEnvelope } from '../../src/envelope.ts';
import { signingKeyFromSecret, signObject, type SigningKeyPair } from '../../src/keys.ts';
import { planHash } from '../../src/plan.ts';
import { markdownHash } from '../../src/render.ts';
import { replay, type ReplayOptions, type ReplayResult } from '../../src/state.ts';
import { createPlanV0 } from '../../src/templates.ts';
import {
  DEFAULT_BUDGETS,
  PROTOCOL_VERSION,
  type Artifact,
  type Budgets,
  type Charter,
  type DecisionKind,
  type Envelope,
  type Hash,
  type Identity,
  type JsonPatchOp,
  type KeyId,
  type MessageType,
  type Party,
  type Plan,
  type SignoffStatement,
} from '../../src/types.ts';

function fixedKey(byte: number): SigningKeyPair {
  return signingKeyFromSecret(new Uint8Array(32).fill(byte));
}

export const KEYS = {
  agentA: fixedKey(1),
  humanA: fixedKey(2),
  agentB: fixedKey(3),
  humanB: fixedKey(4),
  outsider: fixedKey(9),
};

export const JOIN_SECRET = new Uint8Array(32).fill(7);
export const SESSION = 'ses_fixture_orders_billing';
export const CREATED_AT = '2026-10-28T14:00:00.000Z';
export const EXPIRES_AT = '2026-10-31T14:00:00.000Z';

export const IDENTITY_A: Identity = {
  agent_key: KEYS.agentA.keyId,
  human_key: KEYS.humanA.keyId,
  human: 'alice@orders.example',
  org: 'orders',
  assurance: 'self_asserted',
};

export const IDENTITY_B: Identity = {
  agent_key: KEYS.agentB.keyId,
  human_key: KEYS.humanB.keyId,
  human: 'bob@billing.example',
  org: 'billing',
  assurance: 'self_asserted',
};

export function fixtureCharter(budgets: Partial<Budgets> = {}): Charter {
  return {
    session: SESSION,
    topic: 'Order list API for billing',
    type: 'contract',
    mode: 'org',
    template: 'contract',
    inviter: IDENTITY_A,
    invitee_label: 'billing team',
    share_set: ['src/routes/orders.ts'],
    budgets: { ...DEFAULT_BUDGETS.org, ...budgets },
    checkpoint_kinds: ['breaking_change', 'security_or_pii'],
    created_at: CREATED_AT,
    expires_at: EXPIRES_AT,
  };
}

export function joinProofHex(secret: Uint8Array, session: string): string {
  return bytesToHex(sha256(new Uint8Array([...secret, ...new TextEncoder().encode(session)])));
}

export function versionTest(version: number): JsonPatchOp {
  return { op: 'test', path: '/version', value: version };
}

export function artifact(name: string, format: string, content: string): Artifact {
  return { name, format, content, sha256: sha256Hash(content) };
}

export interface EnvelopeOverrides {
  seq?: number;
  prev?: Hash | null;
  /** Key that signs; `from.agent_key` follows it unless `agentKey` is set. */
  signer?: SigningKeyPair;
  agentKey?: KeyId;
  session?: string;
}

export interface ProposalOptions {
  kinds?: DecisionKind[];
  checkpoint_ref?: Hash;
  rationale?: string;
}

const other = (party: Party): Party => (party === 'A' ? 'B' : 'A');

/**
 * Builds a session log from real signed envelopes. Builders return envelopes without adding them;
 * `push` stamps the next relay_seq and appends.
 */
export class Transcript {
  readonly log: Envelope[];
  readonly charterHash: Hash;
  readonly opts: ReplayOptions = { joinSecret: JOIN_SECRET };
  private result: ReplayResult;

  constructor(
    readonly charter: Charter = fixtureCharter(),
    log: Envelope[] = [],
  ) {
    this.charterHash = hashObject(charter);
    this.log = [...log];
    this.result = replay(this.log, this.opts);
  }

  state(): ReplayResult {
    return this.result;
  }

  get plan(): Plan {
    if (!this.result.plan) throw new Error('no plan yet');
    return this.result.plan;
  }

  push(env: Envelope): Envelope {
    const { relay_seq: _ignored, ...rest } = env;
    const stamped: Envelope = { ...rest, relay_seq: this.log.length + 1 };
    this.log.push(stamped);
    this.result = replay(this.log, this.opts);
    return stamped;
  }

  envelope(party: Party, type: MessageType, body: object, o: EnvelopeOverrides = {}): Envelope {
    const r = this.result;
    const signer = o.signer ?? (party === 'A' ? KEYS.agentA : KEYS.agentB);
    return signEnvelope(
      {
        v: PROTOCOL_VERSION,
        session: o.session ?? this.charter.session,
        from: { party, agent_key: o.agentKey ?? signer.keyId, human: party === 'A' ? IDENTITY_A.human : IDENTITY_B.human },
        to: [other(party)],
        seq: o.seq ?? r.lastSeq[party] + 1,
        prev: o.prev !== undefined ? o.prev : r.lastId[party],
        ack: { A: r.lastSeq.A, B: r.lastSeq.B },
        ts: new Date(Date.parse(CREATED_AT) + (this.log.length + 1) * 1000).toISOString(),
        type,
        body: body as Record<string, unknown>,
      },
      signer.secretKey,
    );
  }

  open(): Envelope {
    const plan = createPlanV0(this.charter, this.charterHash, this.charter.invitee_label);
    return this.envelope('A', 'session_open', { charter: this.charter, charter_hash: this.charterHash, plan_v0: plan, plan_v0_hash: planHash(plan) });
  }

  hello(o: { charter_hash?: Hash; join_proof?: string; identity?: Identity } = {}): Envelope {
    return this.envelope('B', 'hello', {
      charter_hash: o.charter_hash ?? this.charterHash,
      join_proof: o.join_proof ?? joinProofHex(JOIN_SECRET, this.charter.session),
      identity: o.identity ?? IDENTITY_B,
    });
  }

  welcome(): Envelope {
    return this.envelope('A', 'welcome', { charter_hash: this.charterHash, identity: IDENTITY_A });
  }

  say(party: Party, text: string, o?: EnvelopeOverrides): Envelope {
    return this.envelope(party, 'say', { text }, o);
  }

  propose(party: Party, patch: JsonPatchOp[], o: ProposalOptions = {}): Envelope {
    return this.envelope(party, 'propose', proposalBody(patch, o));
  }

  counter(party: Party, patch: JsonPatchOp[], o: ProposalOptions & { proposal?: Hash } = {}): Envelope {
    return this.envelope(party, 'counter', {
      ...proposalBody(patch, o),
      proposal: o.proposal ?? this.pendingId(),
      reasons: [{ text: 'counter-proposal' }],
    });
  }

  amend(party: Party, patch: JsonPatchOp[], o: ProposalOptions & { proposal?: Hash } = {}): Envelope {
    return this.envelope(party, 'amend', { ...proposalBody(patch, o), proposal: o.proposal ?? this.pendingId() });
  }

  withdraw(party: Party, proposal: Hash = this.pendingId()): Envelope {
    return this.envelope(party, 'withdraw', { proposal });
  }

  /** Accepts the pending proposal, else the pending signoff request, with the hash replay computed. */
  accept(party: Party, o: { proposal?: Hash; result_hash?: Hash; checkpoint_ref?: Hash } = {}): Envelope {
    const r = this.result;
    const target = r.pending
      ? { proposal: r.pending.id, result_hash: r.pending.resultHash }
      : r.signoffRequest
        ? { proposal: r.signoffRequest.id, result_hash: r.signoffRequest.hash }
        : null;
    if (!target && (!o.proposal || !o.result_hash)) throw new Error('nothing to accept');
    return this.envelope(party, 'accept', {
      proposal: o.proposal ?? target!.proposal,
      result_hash: o.result_hash ?? target!.result_hash,
      ...(o.checkpoint_ref ? { checkpoint_ref: o.checkpoint_ref } : {}),
    });
  }

  reject(party: Party, proposal?: Hash): Envelope {
    const target = proposal ?? this.result.pending?.id ?? this.result.signoffRequest?.id;
    if (!target) throw new Error('nothing to reject');
    return this.envelope(party, 'reject', { proposal: target, reasons: [{ text: 'not agreed' }] });
  }

  ask(party: Party, checkpointId: string, kind?: DecisionKind): Envelope {
    return this.envelope(party, 'ask_user_pending', {
      checkpoint_id: checkpointId,
      reason: 'checkpoint',
      ...(kind ? { kind } : {}),
      blocks: [],
    });
  }

  answer(party: Party, checkpointId: string, summary = 'approved by my human'): Envelope {
    return this.envelope(party, 'user_answer_summary', { checkpoint_id: checkpointId, summary });
  }

  requestSignoff(party: Party, o: { version?: number; hash?: Hash; md_hash?: Hash } = {}): Envelope {
    return this.envelope(party, 'request_signoff', {
      version: o.version ?? this.result.version,
      hash: o.hash ?? planHash(this.plan),
      md_hash: o.md_hash ?? markdownHash(this.plan),
    });
  }

  unfreeze(party: Party): Envelope {
    return this.envelope(party, 'unfreeze', { reason: 'reopening' });
  }

  statement(party: Party, decision: 'approve' | 'decline', o: Partial<SignoffStatement> = {}): SignoffStatement {
    const frozen = this.result.frozen;
    if (!frozen) throw new Error('plan is not frozen');
    const identity = party === 'A' ? IDENTITY_A : IDENTITY_B;
    return {
      v: PROTOCOL_VERSION,
      session: this.charter.session,
      decision,
      version: frozen.version,
      plan_hash: frozen.hash,
      md_hash: frozen.mdHash,
      mode: this.charter.mode,
      charter_hash: this.charterHash,
      party,
      human: identity.human,
      human_key: identity.human_key,
      ts: new Date(Date.parse(CREATED_AT) + (this.log.length + 1) * 1000).toISOString(),
      ...o,
    };
  }

  signoff(party: Party, decision: 'approve' | 'decline' = 'approve', o: { statement?: Partial<SignoffStatement>; signer?: SigningKeyPair } = {}): Envelope {
    const statement = this.statement(party, decision, o.statement);
    const signer = o.signer ?? (party === 'A' ? KEYS.humanA : KEYS.humanB);
    return this.envelope(party, 'signoff', { statement, human_sig: signObject(statement, signer.secretKey) });
  }

  planFinal(party: Party, signoffs?: Hash[]): Envelope {
    const r = this.result;
    if (!r.frozen) throw new Error('plan is not frozen');
    return this.envelope(party, 'plan_final', {
      plan_hash: r.frozen.hash,
      md_hash: r.frozen.mdHash,
      signoffs: signoffs ?? [r.signoffs.A?.id, r.signoffs.B?.id].filter((id): id is Hash => id !== undefined),
    });
  }

  bye(party: Party, stored?: Hash): Envelope {
    const hash = stored ?? this.result.frozen?.hash;
    if (!hash) throw new Error('no agreed hash');
    return this.envelope(party, 'bye', { stored: hash });
  }

  resolve(party: Party, action: 'extend' | 'partial' | 'abort'): Envelope {
    return this.envelope(party, 'resolve', { action });
  }

  abort(party: Party, o?: EnvelopeOverrides): Envelope {
    return this.envelope(party, 'abort', { reason: 'hanging up' }, o);
  }

  private pendingId(): Hash {
    const id = this.result.pending?.id;
    if (!id) throw new Error('no pending proposal');
    return id;
  }
}

function proposalBody(patch: JsonPatchOp[], o: ProposalOptions): Record<string, unknown> {
  return {
    patch,
    kinds: o.kinds ?? [],
    rationale: o.rationale ?? 'see patch',
    ...(o.checkpoint_ref ? { checkpoint_ref: o.checkpoint_ref } : {}),
  };
}

// ---------------------------------------------------------------- worked transcript

export const OPENAPI_V1 = `paths:
  /v1/orders:
    get:
      parameters:
        - name: cursor
          in: query
          schema: { type: string }
      responses:
        '200':
          description: A page of orders
          content:
            application/json:
              schema:
                type: object
                required: [orders, next_cursor, total_count]
                properties:
                  orders: { type: array, items: { $ref: '#/components/schemas/Order' } }
                  next_cursor: { type: [string, 'null'] }
                  total_count: { type: integer }
`;

export const OPENAPI_V2 = `${OPENAPI_V1}components:
  schemas:
    Order:
      type: object
      required: [id, amount_minor, currency]
      properties:
        id: { type: string }
        amount_minor: { type: integer, description: Amount in minor units }
        currency: { type: string }
`;

const CONTEXT_MD = 'Billing reconciles invoices against orders every night and needs a stable way to page through all orders.';

/** B's opening proposal: cursor pagination (plan v0 sections: 0 context, 1 interface, 2 a.impl_notes, 3 b.impl_notes, 4 rollout, 5 risks). */
export function cursorPatch(): JsonPatchOp[] {
  return [
    versionTest(0),
    { op: 'replace', path: '/sections/0/md', value: CONTEXT_MD },
    { op: 'replace', path: '/sections/1/md', value: '`GET /v1/orders` pages with an opaque `cursor`; responses carry `next_cursor` (null on the last page).' },
    { op: 'add', path: '/decisions/-', value: { id: 'D1', text: 'List endpoints use opaque cursor pagination instead of offsets.', decided_by: 'human-B', decided_in: null } },
    {
      op: 'add',
      path: '/open_items/-',
      value: { id: 'OI1', text: 'Agree how `amount` changes before billing switches over.', blocking: true, owner: 'joint', status: 'open' },
    },
  ];
}

/** A's counter: the same plus `total_count` and the OpenAPI fragment. No checkpoint kinds. */
export function totalCountPatch(): JsonPatchOp[] {
  const [test, context, , d1, oi1] = cursorPatch();
  return [
    test!,
    context!,
    {
      op: 'replace',
      path: '/sections/1/md',
      value: '`GET /v1/orders` pages with an opaque `cursor`; responses carry `next_cursor` (null on the last page) and `total_count`.',
    },
    { op: 'add', path: '/sections/1/artifacts', value: [artifact('orders-list', 'openapi-3.1', OPENAPI_V1)] },
    d1!,
    { op: 'add', path: '/decisions/-', value: { id: 'D2', text: 'Responses include `total_count` so billing can detect truncated syncs.', decided_by: 'agent-assumed', decided_in: null } },
    oi1!,
  ];
}

/** A's breaking change at v1: rename `amount`, resolve OI1, fill rollout, risks and action items. */
export function breakingPatch(settledIn: Hash): JsonPatchOp[] {
  return [
    versionTest(1),
    {
      op: 'add',
      path: '/decisions/-',
      value: { id: 'D3', text: 'Rename `amount` to `amount_minor` (integer minor units). Breaking for existing consumers.', kind: 'breaking_change', decided_by: 'human-A', decided_in: null },
    },
    { op: 'replace', path: '/decisions/0/decided_in', value: settledIn },
    { op: 'replace', path: '/decisions/1/decided_in', value: settledIn },
    { op: 'replace', path: '/sections/1/artifacts/0', value: artifact('orders-list', 'openapi-3.1', OPENAPI_V2) },
    { op: 'replace', path: '/sections/2/md', value: 'Dual-write `amount` and `amount_minor` for 30 days, then drop `amount`.' },
    {
      op: 'replace',
      path: '/sections/4/md',
      value: '1. Orders ships `amount_minor` next to `amount`.\n2. Billing switches to `amount_minor` and cursor pagination.\n3. Orders removes `amount` 30 days later.',
    },
    { op: 'replace', path: '/sections/5/md', value: 'Any consumer still reading `amount` after day 30 breaks. Billing is the only known consumer.' },
    { op: 'replace', path: '/open_items/0/status', value: 'resolved' },
    { op: 'add', path: '/disagreements/-', value: { id: 'X1', text: 'Billing asked to keep `amount` indefinitely.', resolution: 'Dropped after the 30-day dual-write window.' } },
    { op: 'add', path: '/action_items/A/-', value: { id: 'A1', text: 'Add `amount_minor` and `total_count` to `GET /v1/orders`.' } },
    { op: 'add', path: '/action_items/B/-', value: { id: 'B1', text: 'Move the nightly sync to cursor pagination and `amount_minor`.' } },
  ];
}

export const WORKED_STEPS = [
  'session_open',
  'hello',
  'welcome',
  'say',
  'propose',
  'counter',
  'accept_counter',
  'ask_a',
  'answer_a',
  'propose_breaking',
  'ask_b',
  'answer_b',
  'accept_breaking',
  'request_signoff',
  'accept_signoff',
  'signoff_a',
  'signoff_b',
  'plan_final',
  'bye_a',
  'bye_b',
] as const;

export type WorkedStep = (typeof WORKED_STEPS)[number];
export type WorkedIds = Partial<Record<WorkedStep, Hash>>;

const WORKED: Record<WorkedStep, (t: Transcript, ids: WorkedIds) => Envelope> = {
  session_open: (t) => t.open(),
  hello: (t) => t.hello(),
  welcome: (t) => t.welcome(),
  say: (t) => t.say('A', 'Today GET /v1/orders uses offset pagination and returns `amount` as a decimal string.'),
  propose: (t) => t.propose('B', cursorPatch(), { rationale: 'Offsets skip orders when new ones arrive mid-sync.' }),
  counter: (t) => t.counter('A', totalCountPatch(), { rationale: 'Cursor pagination plus total_count.' }),
  accept_counter: (t) => t.accept('B'),
  ask_a: (t) => t.ask('A', 'cp-a-1', 'breaking_change'),
  answer_a: (t) => t.answer('A', 'cp-a-1', 'Alice approves renaming amount to amount_minor with a 30-day dual-write window.'),
  propose_breaking: (t, ids) => t.propose('A', breakingPatch(ids.accept_counter!), { kinds: ['breaking_change'], checkpoint_ref: ids.answer_a! }),
  ask_b: (t) => t.ask('B', 'cp-b-1', 'breaking_change'),
  answer_b: (t) => t.answer('B', 'cp-b-1', 'Bob accepts the rename on the 30-day timeline.'),
  accept_breaking: (t, ids) => t.accept('B', { checkpoint_ref: ids.answer_b! }),
  request_signoff: (t) => t.requestSignoff('B'),
  accept_signoff: (t) => t.accept('A'),
  signoff_a: (t) => t.signoff('A'),
  signoff_b: (t) => t.signoff('B'),
  plan_final: (t) => t.planFinal('A'),
  bye_a: (t) => t.bye('A'),
  bye_b: (t) => t.bye('B'),
};

/** Worked logs built so far, per charter hash. Envelopes are deterministic, so prefixes are shared. */
const built = new Map<Hash, { t: Transcript; ids: WorkedIds; steps: number }>();

/** The worked transcript of AC1, stopping after `until`, as a fresh Transcript. Throws if a step is not accepted. */
export function workedTranscript(until: WorkedStep = 'bye_b', charter: Charter = fixtureCharter()): { t: Transcript; ids: WorkedIds } {
  const key = hashObject(charter);
  let entry = built.get(key);
  if (!entry) {
    entry = { t: new Transcript(charter), ids: {}, steps: 0 };
    built.set(key, entry);
  }
  const count = WORKED_STEPS.indexOf(until) + 1;
  while (entry.steps < count) {
    const step = WORKED_STEPS[entry.steps]!;
    const env = entry.t.push(WORKED[step](entry.t, entry.ids));
    const rejected = entry.t.state().rejected;
    if (rejected.length > 0) throw new Error(`worked step ${step} rejected: ${rejected[0]!.code} ${rejected[0]!.detail}`);
    entry.ids[step] = env.id;
    entry.steps += 1;
  }
  const ids: WorkedIds = {};
  for (const step of WORKED_STEPS.slice(0, count)) ids[step] = entry.ids[step];
  return { t: new Transcript(charter, entry.t.log.slice(0, count)), ids };
}
