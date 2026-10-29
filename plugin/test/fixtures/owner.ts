import { CallManager } from '../../server/manager.ts';

/** A call-session server in its own process: `bun owner.ts <home> <relayUrl>`. Prints its call list once loaded, then idles. */
const [home, relayUrl] = process.argv.slice(2);
if (!home || !relayUrl) throw new Error('usage: owner.ts <home> <relayUrl>');
const manager = new CallManager({ home, relayUrl, repoRoot: home, env: { CMA_CALL_SESSION: '1' } });
await manager.init();
process.stdout.write(`${JSON.stringify(manager.listCalls())}\n`);
setInterval(() => undefined, 60_000);
