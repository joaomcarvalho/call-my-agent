import { afterEach, describe, expect, test } from 'bun:test';
import { generateSigningKey, sha256Hash } from '@cma/protocol';
import { assertSecureRelayUrl, InsecureRelayError, RelayClient, startRelay } from '../src/index.ts';

describe('relay transport security', () => {
  test('plain http to loopback hosts is allowed', () => {
    for (const u of ['http://127.0.0.1:8787', 'http://127.1.2.3:1', 'http://localhost:8787', 'http://[::1]:8787', 'ws://localhost:1']) {
      expect(() => assertSecureRelayUrl(u, {})).not.toThrow();
    }
  });

  test('plain http to a remote host is refused', () => {
    for (const u of ['http://relay.example.com', 'http://10.0.0.5:8787', 'http://127.0.0.1.evil.com', 'ws://relay.example.com']) {
      expect(() => assertSecureRelayUrl(u, {})).toThrow(InsecureRelayError);
    }
  });

  test('https to a remote host is allowed', () => {
    expect(() => assertSecureRelayUrl('https://relay.example.com', {})).not.toThrow();
  });

  test('CMA_ALLOW_INSECURE_RELAY=1 allows plain http to a remote host', () => {
    expect(() => assertSecureRelayUrl('http://100.64.0.1:8787', { CMA_ALLOW_INSECURE_RELAY: '1' })).not.toThrow();
    expect(() => assertSecureRelayUrl('http://100.64.0.1:8787', { CMA_ALLOW_INSECURE_RELAY: 'yes' })).toThrow(InsecureRelayError);
  });

  test('RelayClient refuses a remote http relay before any request', async () => {
    const hash = sha256Hash('x').slice('sha256:'.length);
    await expect(RelayClient.createRoom('http://relay.example.com', { secretHash: hash, creatorKey: generateSigningKey().keyId, ttlS: 60 })).rejects.toThrow(
      InsecureRelayError,
    );
    expect(() => new RelayClient({ relayUrl: 'http://relay.example.com', room: 'r', token: 't', onMessage: () => {} })).toThrow(InsecureRelayError);
  });
});

describe('relay --trust-proxy', () => {
  const stops: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (stops.length) await stops.pop()!();
  });

  async function create(url: string, forwardedFor?: string): Promise<number> {
    const res = await fetch(`${url}/v1/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}) },
      body: JSON.stringify({ secret_hash: 'a'.repeat(64), creator_key: generateSigningKey().keyId, ttl_s: 60 }),
    });
    return res.status;
  }

  async function exhaust(url: string, forwardedFor: string): Promise<void> {
    for (let i = 0; i < 20; i++) expect(await create(url, forwardedFor)).toBe(201);
    expect(await create(url, forwardedFor)).toBe(429);
  }

  test('with trustProxy, room-creation limits count per left-most X-Forwarded-For client', async () => {
    const r = startRelay({ port: 0, trustProxy: true });
    stops.push(() => r.stop());
    await exhaust(r.url, '203.0.113.1, 10.0.0.1');
    expect(await create(r.url, '203.0.113.2, 10.0.0.1')).toBe(201);
  });

  test('without trustProxy, X-Forwarded-For is ignored', async () => {
    const r = startRelay({ port: 0 });
    stops.push(() => r.stop());
    await exhaust(r.url, '203.0.113.1');
    expect(await create(r.url, '203.0.113.2')).toBe(429);
  });
});
