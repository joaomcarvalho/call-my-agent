import { rmSync } from 'node:fs';
import { join } from 'node:path';

const plugin = join(import.meta.dir, '..', 'plugin');
const entries: Record<string, string> = {
  'server.js': 'server/index.ts',
  'session-start.js': 'hooks/session-start.ts',
  'disclosure.js': 'hooks/disclosure.ts',
  'read-guard.js': 'hooks/read-guard.ts',
};

rmSync(join(plugin, 'dist'), { recursive: true, force: true });

for (const [out, entry] of Object.entries(entries)) {
  const result = await Bun.build({
    entrypoints: [join(plugin, entry)],
    outdir: join(plugin, 'dist'),
    target: 'bun',
    format: 'esm',
    minify: false,
    sourcemap: 'none',
    naming: { entry: out },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
}
