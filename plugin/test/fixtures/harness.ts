import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSignoff, hexToBytes, sha256Hash, type Artifact, type Hash, type JsonPatchOp, type Party } from '@cma/protocol';
import { startRelay } from '@cma/relay';
import { CallManager, type CallManagerOptions, type ToolResult } from '../../server/manager.ts';
import { callPaths, identityPaths, type Profile } from '../../server/store.ts';

export const PROFILES: Record<string, Profile> = {
  alice: { human: 'alice@orders.example', org: 'orders' },
  bob: { human: 'bob@billing.example', org: 'billing' },
};

export async function waitFor(pred: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export interface Side {
  name: string;
  home: string;
  repo: string;
  manager: CallManager;
}

/** A relay on port 0 with an on-disk DB, plus temp homes and repos per named side. Everything is removed by `cleanup`. */
export class Harness {
  readonly dir: string;
  readonly dbPath: string;
  readonly relay: ReturnType<typeof startRelay>;
  private readonly sides = new Map<string, { home: string; repo: string }>();
  private readonly managers: CallManager[] = [];

  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), 'cma-plugin-'));
    this.dbPath = join(this.dir, 'relay.db');
    this.relay = startRelay({ port: 0, dbPath: this.dbPath });
  }

  paths(name: string): { home: string; repo: string } {
    let side = this.sides.get(name);
    if (!side) {
      side = { home: join(this.dir, `${name}-home`), repo: join(this.dir, `${name}-repo`) };
      this.sides.set(name, side);
    }
    return side;
  }

  /** A fresh manager on `name`'s home; calling it again for the same name simulates a server restart. */
  async side(name: string, opts: Partial<CallManagerOptions> = {}): Promise<Side> {
    const { home, repo } = this.paths(name);
    const manager = new CallManager({
      home,
      repoRoot: repo,
      relayUrl: this.relay.url,
      env: {},
      profile: PROFILES[name] ?? { human: name },
      ...opts,
    });
    this.managers.push(manager);
    await manager.init();
    return { name, home, repo, manager };
  }

  messageCount(): number {
    const db = new Database(this.dbPath);
    try {
      return db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM messages').get()!.n;
    } finally {
      db.close();
    }
  }

  payloads(): string[] {
    const db = new Database(this.dbPath);
    try {
      return db.query<{ payload: string }, []>('SELECT payload FROM messages ORDER BY relay_seq').all().map((row) => row.payload);
    } finally {
      db.close();
    }
  }

  async cleanup(): Promise<void> {
    for (const manager of this.managers) await manager.close();
    await this.relay.stop();
    for (const { home } of this.sides.values()) {
      const key = identityPaths(home).humanKey;
      if (existsSync(key)) chmodSync(key, 0o600);
    }
    rmSync(this.dir, { recursive: true, force: true });
  }
}

export const TOPIC = 'Order list API for billing';

/** A starts, B inspects and joins; resolves once both sides are DISCUSSING. */
export async function connect(alice: Side, bob: Side, topic = TOPIC): Promise<{ session: string; started: ToolResult; joined: ToolResult; inspected: ToolResult }> {
  const started = await alice.manager.startCall({ peer: 'bob@billing.example', topic, share_set: ['openapi.yaml'] });
  const invite = started.invite as string;
  const inspected = await bob.manager.inspectInvite({ invite });
  const joined = await bob.manager.joinCall({ invite });
  const session = started.session as string;
  await waitFor(
    () => alice.manager.status({ session }).state === 'DISCUSSING' && bob.manager.status({ session }).state === 'DISCUSSING',
    'both sides DISCUSSING',
  );
  return { session, started, joined, inspected };
}

export function status(side: Side, session: string): ToolResult {
  return side.manager.status({ session });
}

/** Writes signoff.json the way `cma approve` would: signed with the side's human.key, then renamed into place. */
export function writeSignoff(
  side: Side,
  session: string,
  o: { decision?: 'approve' | 'decline'; mdHash?: Hash; humanSecretKey?: Uint8Array } = {},
): void {
  const rt = side.manager.runtime(session);
  const r = rt.result;
  if (!r.frozen || !r.charter || !r.charterHash) throw new Error(`${side.name} is not FROZEN`);
  const party: Party = rt.party;
  const body = createSignoff({
    session,
    charterHash: r.charterHash,
    mode: r.charter.mode,
    party,
    human: r.identities[party]!.human,
    frozen: { version: r.frozen.version, hash: r.frozen.hash, mdHash: o.mdHash ?? r.frozen.mdHash },
    decision: o.decision ?? 'approve',
    humanSecretKey: o.humanSecretKey ?? hexToBytes(readFileSync(identityPaths(side.home).humanKey, 'utf8').trim()),
    ts: new Date().toISOString(),
  });
  const target = callPaths(side.home, session).signoff;
  writeFileSync(`${target}.tmp`, JSON.stringify(body));
  renameSync(`${target}.tmp`, target);
}

/** From FROZEN: both humans sign, A's server sends plan_final, both write the plan and the call closes. */
export async function signAndClose(alice: Side, bob: Side, session: string): Promise<{ a: ToolResult; b: ToolResult }> {
  await waitFor(() => status(alice, session).state === 'FROZEN' && status(bob, session).state === 'FROZEN', 'both FROZEN');
  writeSignoff(alice, session);
  writeSignoff(bob, session);
  await waitFor(() => status(alice, session).final === true && status(bob, session).final === true, 'plan_final on both sides');
  const a = await alice.manager.writePlan({ session });
  const b = await bob.manager.writePlan({ session });
  await waitFor(() => status(alice, session).state === 'CLOSED' && status(bob, session).state === 'CLOSED', 'both CLOSED');
  return { a, b };
}

// ---------------------------------------------------------------- plan patches (contract template: 0 context, 1 interface, 2 a.impl_notes, 3 b.impl_notes, 4 rollout, 5 risks)

export const OPENAPI_V1 = `paths:
  /v1/orders:
    get:
      parameters:
        - name: cursor
          in: query
      responses:
        '200':
          description: A page of orders with next_cursor and total_count
`;

export const OPENAPI_V2 = `${OPENAPI_V1}components:
  schemas:
    Order:
      required: [id, amount_minor, currency]
`;

export function artifact(name: string, format: string, content: string): Artifact {
  return { name, format, content, sha256: sha256Hash(content) };
}

const CONTEXT_MD = 'Billing reconciles invoices against orders every night and pages through all orders.';
const OPEN_ITEM = { id: 'OI1', text: 'Agree how `amount` changes before billing switches over.', blocking: true, owner: 'joint', status: 'open' };

/** B's opening proposal. No decisions, so no checkpoint is needed; the server adds the version test. */
export function cursorPatch(): JsonPatchOp[] {
  return [
    { op: 'replace', path: '/sections/0/md', value: CONTEXT_MD },
    { op: 'replace', path: '/sections/1/md', value: '`GET /v1/orders` pages with an opaque `cursor`; responses carry `next_cursor`.' },
    { op: 'add', path: '/open_items/-', value: OPEN_ITEM },
  ];
}

/** A's counter: cursor pagination plus `total_count` and the OpenAPI fragment. */
export function totalCountPatch(): JsonPatchOp[] {
  return [
    { op: 'test', path: '/version', value: 0 },
    { op: 'replace', path: '/sections/0/md', value: CONTEXT_MD },
    { op: 'replace', path: '/sections/1/md', value: '`GET /v1/orders` pages with an opaque `cursor`; responses carry `next_cursor` and `total_count`.' },
    { op: 'add', path: '/sections/1/artifacts', value: [artifact('orders-list', 'openapi-3.1', OPENAPI_V1)] },
    { op: 'add', path: '/open_items/-', value: OPEN_ITEM },
  ];
}

/** A's breaking change at v1: records the decisions, resolves OI1, fills rollout, risks and action items. */
export function breakingPatch(): JsonPatchOp[] {
  return [
    { op: 'test', path: '/version', value: 1 },
    { op: 'add', path: '/decisions/-', value: { id: 'D1', text: 'List endpoints use opaque cursor pagination.', decided_by: 'human-A', decided_in: null } },
    { op: 'add', path: '/decisions/-', value: { id: 'D2', text: 'Responses include `total_count`.', decided_by: 'agent-assumed', decided_in: null } },
    {
      op: 'add',
      path: '/decisions/-',
      value: { id: 'D3', text: 'Rename `amount` to `amount_minor` (integer minor units).', kind: 'breaking_change', decided_by: 'human-A', decided_in: null },
    },
    { op: 'replace', path: '/sections/1/artifacts/0', value: artifact('orders-list', 'openapi-3.1', OPENAPI_V2) },
    { op: 'replace', path: '/sections/2/md', value: 'Dual-write `amount` and `amount_minor` for 30 days, then drop `amount`.' },
    { op: 'replace', path: '/sections/4/md', value: '1. Orders ships `amount_minor`.\n2. Billing switches.\n3. Orders removes `amount` 30 days later.' },
    { op: 'replace', path: '/sections/5/md', value: 'Any consumer still reading `amount` after day 30 breaks.' },
    { op: 'replace', path: '/open_items/0/status', value: 'resolved' },
    { op: 'add', path: '/disagreements/-', value: { id: 'X1', text: 'Billing asked to keep `amount` indefinitely.', resolution: 'Dropped after 30 days.' } },
    { op: 'add', path: '/action_items/A/-', value: { id: 'A1', text: 'Add `amount_minor` and `total_count` to `GET /v1/orders`.' } },
    { op: 'add', path: '/action_items/B/-', value: { id: 'B1', text: 'Move the nightly sync to cursor pagination and `amount_minor`.' } },
  ];
}

/** A decision-free edit of the joint context section. */
export function contextPatch(text: string): JsonPatchOp[] {
  return [{ op: 'replace', path: '/sections/0/md', value: text }];
}

/** From DISCUSSING with floor A: B proposes, A accepts, A requests sign-off, B accepts; both reach FROZEN. */
export async function freezeSimplePlan(alice: Side, bob: Side, session: string): Promise<void> {
  await alice.manager.say({ session, text: 'Billing needs a stable way to page through orders.' });
  await waitFor(() => status(bob, session).floor === 'you', 'floor at bob');
  await bob.manager.propose({ session, patch: contextPatch(CONTEXT_MD), rationale: 'Record the context first.' });
  await waitFor(() => status(alice, session).pending !== null, 'proposal at alice');
  await alice.manager.respond({ session, action: 'accept' });
  await waitFor(() => status(bob, session).version === 1, 'v1 at bob');
  await alice.manager.requestSignoff({ session });
  await waitFor(() => status(bob, session).signoff_request !== null, 'signoff request at bob');
  await bob.manager.respond({ session, action: 'accept' });
  await waitFor(() => status(alice, session).state === 'FROZEN' && status(bob, session).state === 'FROZEN', 'both FROZEN');
}
