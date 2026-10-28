import { parseArgs } from 'node:util';
import { RelayClient } from './client.ts';
import { startRelay } from './server.ts';

const [command, ...rest] = process.argv.slice(2);

if (command === 'serve') {
  const { values } = parseArgs({
    args: rest,
    options: { port: { type: 'string', default: '8787' }, db: { type: 'string', default: ':memory:' } },
  });
  const relay = startRelay({ port: Number(values.port), dbPath: values.db });
  console.log(`relay listening on ${relay.url}`);
} else if (command === 'say') {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { relay: { type: 'string' }, room: { type: 'string' }, token: { type: 'string' } },
  });
  const text = positionals[0];
  if (!values.relay || !values.room || !values.token || text === undefined) {
    console.error('usage: cli.ts say --relay URL --room R --token T "text"');
    process.exit(2);
  }
  const msgId = crypto.randomUUID();
  let done: () => void = () => {};
  const echoed = new Promise<void>((resolve) => (done = resolve));
  const client = new RelayClient({
    relayUrl: values.relay,
    room: values.room,
    token: values.token,
    onMessage: (m) => {
      console.log(JSON.stringify(m));
      if (m.msg_id === msgId) done();
    },
    onPresence: (p) => console.log(JSON.stringify({ presence: p })),
    onError: (e) => console.error(JSON.stringify(e)),
  });
  await client.connect();
  await client.send(msgId, text);
  await echoed;
  await client.close();
} else {
  console.error('usage: cli.ts serve [--port 8787] [--db path] | say --relay URL --room R --token T "text"');
  process.exit(2);
}
