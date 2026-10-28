# T3 · Local relay and client

**Owns:** `packages/relay/**`.

**Spec:** implementation-spec §3, exactly. Bun only: `Bun.serve` (HTTP + WebSocket), `bun:sqlite`, global `WebSocket` in the client. Import hashing/base64 helpers from `@cma/protocol` (`sha256Hash`, `base64urlEncode`, `isKeyId`). The relay treats `payload` as an opaque string; it never parses it.

## API to implement

```ts
// src/server.ts
export interface RelayOptions { port?: number /* 0 = random */; hostname?: string /* default 127.0.0.1 */; dbPath?: string /* default ":memory:" */; now?: () => number }
export function startRelay(opts?: RelayOptions): { url: string; port: number; stop(): Promise<void> }

// src/client.ts
export interface RelayMsg { relay_seq: number; msg_id: string; sender_key: string; payload: string; ts: string }
export class RelayClient {
  static createRoom(relayUrl: string, args: { secretHash: string; creatorKey: string; ttlS: number }): Promise<{ room: string; token: string }>
  static joinRoom(relayUrl: string, room: string, args: { secret: string; memberKey: string }): Promise<{ token: string }>
  constructor(args: { relayUrl: string; room: string; token: string; cursor?: number; onMessage(m: RelayMsg): void; onPresence?(p: { member_key: string; online: boolean }): void; onError?(e: { code: string; detail: string }): void })
  connect(): Promise<void>          // resolves after the first `synced`
  send(msgId: string, payload: string): Promise<{ relay_seq: number; dup: boolean }>
  ack(cursor: number): void
  get cursor(): number              // highest relay_seq delivered to onMessage
  close(): Promise<void>
}

// src/index.ts re-exports server and client.
// src/cli.ts: `bun packages/relay/src/cli.ts serve [--port 8787] [--db path]` and
//             `bun packages/relay/src/cli.ts say --relay URL --room R --token T "text"` (sends a raw payload, prints echoes).
```

## Acceptance criteria

- **AC1** Create room → join with the right secret → both clients connect; a `send` from one is delivered once to both with the same `relay_seq`.
- **AC2** Join with the wrong secret → 403; a second, different key → 409; the same key again → 200 with a new token; unknown room → 404; expired room → 410 (use the `now` option).
- **AC3** Only token hashes and the secret hash are stored: after a full exchange, no row in any table contains the raw token or secret (scan every column of every table).
- **AC4** Reconnect without loss: client B disconnects, A sends 5 messages, B reconnects with its cursor and receives exactly those 5, in order, once each.
- **AC5** Sending the same `msg_id` twice returns the same `relay_seq` with `dup: true` and the peer receives it once.
- **AC6** A client whose connection drops while a `send` is in flight still gets its promise resolved after auto-reconnect (dedup makes the retry safe).
- **AC7** Payload over 262144 bytes → `error` `TOO_LARGE`; the 31st send within a minute → `RATE_LIMITED`.
- **AC8** Presence: when B connects A receives `{online: true}`; when B disconnects A receives `{online: false}`.
- **AC9** WebSocket with a bad token is refused (HTTP 401 on upgrade).
- **AC10** `relay_seq` is strictly increasing per room and survives a server restart with a file DB (stop, start on the same `dbPath`, sync from 0 returns all messages).
- **AC11** `bun run check` passes; tests use `port: 0` and never a fixed port.
