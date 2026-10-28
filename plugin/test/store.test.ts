import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hexToBytes, signingKeyFromSecret } from '@cma/protocol';
import { callPaths, identityPaths, loadOrCreateIdentity } from '../server/store.ts';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cma-store-'));
  dirs.push(dir);
  return dir;
}

test('first run creates agent.key and human.key with mode 0600 and exposes only the human public key', () => {
  const root = home();
  const id = loadOrCreateIdentity(root, { human: 'alice@orders.example', org: 'orders' });
  const p = identityPaths(root);
  expect(statSync(p.agentKey).mode & 0o777).toBe(0o600);
  expect(statSync(p.humanKey).mode & 0o777).toBe(0o600);
  const secret = hexToBytes(readFileSync(p.humanKey, 'utf8').trim());
  expect(id.humanKey).toBe(signingKeyFromSecret(secret).keyId);
  expect(readFileSync(p.humanPub, 'utf8').trim()).toBe(id.humanKey);
  expect(id.profile).toEqual({ human: 'alice@orders.example', org: 'orders' });
  expect(Object.keys(id).sort()).toEqual(['agent', 'humanKey', 'profile']);
});

test('later runs keep the existing keys and profile', () => {
  const root = home();
  const first = loadOrCreateIdentity(root, { human: 'alice' });
  const second = loadOrCreateIdentity(root, { human: 'someone else' });
  expect(second.agent.keyId).toBe(first.agent.keyId);
  expect(second.humanKey).toBe(first.humanKey);
  expect(second.profile.human).toBe('alice');
});

test('a missing human.pub next to an existing human.key is an error, not a reason to read the secret', () => {
  const root = home();
  loadOrCreateIdentity(root, { human: 'alice' });
  unlinkSync(identityPaths(root).humanPub);
  expect(() => loadOrCreateIdentity(root)).toThrow(/cma keygen/);
});

test('session ids that are not path-safe are refused', () => {
  expect(() => callPaths(home(), '../escape')).toThrow(/invalid session id/);
});
