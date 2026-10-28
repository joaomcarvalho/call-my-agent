import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cmaRoot } from './lib.ts';

const root = cmaRoot();

const socket = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
const token = process.env.CLAUDE_CODE_MESSAGING_TOKEN;
if (socket && token) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = join(root, 'session-env.json');
  writeFileSync(file, JSON.stringify({ socket, token }), { mode: 0o600 });
  chmodSync(file, 0o600);
}

const lines: string[] = [];
const callsDir = join(root, 'calls');
if (existsSync(callsDir)) {
  for (const name of readdirSync(callsDir).sort()) {
    try {
      const call = JSON.parse(readFileSync(join(callsDir, name, 'call.json'), 'utf8')) as {
        session?: string;
        party?: string;
        invite?: string;
        peer?: { human?: string } | string;
      };
      const peer = typeof call.peer === 'string' ? call.peer : call.peer?.human;
      lines.push(`${call.session ?? name} (you are party ${call.party ?? '?'}${peer ? `, peer ${peer}` : ''})`);
    } catch {
      continue;
    }
  }
}

if (lines.length > 0) {
  const additionalContext = `[call-my-agent] Calls on this machine: ${lines.join('; ')}. Use cma_list_calls for their state and the negotiate skill before acting.`;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } }));
}
