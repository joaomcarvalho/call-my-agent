import type { Envelope, Hash, Party } from './types.ts';

export type ChainVerdict = { ok: true } | { ok: false; code: 'CHAIN_GAP' | 'CHAIN_DUPLICATE' | 'CHAIN_FORK'; detail: string };

export interface ChainHeads {
  seq: Record<Party, number>;
  id: Record<Party, Hash | null>;
}

/** Per-sender hash chain over accepted messages (§2.2). Rejected messages are never committed. */
export class ChainTracker {
  private readonly heads: ChainHeads;

  constructor(heads?: ChainHeads) {
    this.heads = {
      seq: { A: heads?.seq.A ?? 0, B: heads?.seq.B ?? 0 },
      id: { A: heads?.id.A ?? null, B: heads?.id.B ?? null },
    };
  }

  check(env: Envelope): ChainVerdict {
    const { seq, id } = this.last(env.from.party);
    if (env.seq > seq + 1) return { ok: false, code: 'CHAIN_GAP', detail: `seq ${env.seq} after ${seq}` };
    if (env.seq <= seq) return { ok: false, code: 'CHAIN_DUPLICATE', detail: `seq ${env.seq} already used by ${env.from.party}` };
    if (env.prev !== id) return { ok: false, code: 'CHAIN_FORK', detail: `prev ${env.prev ?? 'null'} is not ${id ?? 'null'}` };
    return { ok: true };
  }

  /** Records `env` as the sender's latest message. Throws if it does not extend the chain. */
  commit(env: Envelope): void {
    const verdict = this.check(env);
    if (!verdict.ok) throw new Error(`${verdict.code}: ${verdict.detail}`);
    this.heads.seq[env.from.party] = env.seq;
    this.heads.id[env.from.party] = env.id;
  }

  last(party: Party): { seq: number; id: Hash | null } {
    return { seq: this.heads.seq[party], id: this.heads.id[party] };
  }
}
