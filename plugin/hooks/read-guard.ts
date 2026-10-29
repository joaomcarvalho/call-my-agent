import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { cmaRoot } from './lib.ts';

const GLOB_CHARS = /[*?[\]{}]/;

/** Resolves symlinks in the longest existing prefix of `p`; the remainder is appended unchanged. */
function realpathPrefix(p: string): string {
  const rest: string[] = [];
  let cur = p;
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return p;
    rest.unshift(cur.slice(parent.length).replace(/^[\\/]+/, ''));
    cur = parent;
  }
  return resolve(realpathSync.native(cur), ...rest);
}

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

function isInside(p: string, root: string): boolean {
  return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** The directory part of a glob pattern that precedes its first wildcard segment. */
function globBase(pattern: string): string {
  const segments = pattern.split('/');
  const fixed: string[] = [];
  for (const seg of segments) {
    if (GLOB_CHARS.test(seg)) break;
    fixed.push(seg);
  }
  return fixed.length === segments.length ? pattern : fixed.join('/') || '/';
}

/** Returns the offending path when the tool call would touch the CMA root, else undefined. */
export function findViolation(toolName: string, toolInput: Record<string, unknown>, cwd: string, rootDir: string): string | undefined {
  const roots = new Set([resolve(rootDir), realpathPrefix(resolve(rootDir))]);
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

  const base = resolve(cwd, expandHome(str(toolInput.path) ?? str(toolInput.notebook_path) ?? cwd));
  const candidates = [base];
  const file = str(toolInput.file_path);
  if (file) candidates.push(resolve(cwd, expandHome(file)));
  // Grep's `pattern` is a regex; only Glob's is a path.
  const globs = [toolName === 'Glob' ? str(toolInput.pattern) : undefined, str(toolInput.glob)];
  for (const g of globs) if (g) candidates.push(resolve(base, expandHome(globBase(g))));

  for (const abs of candidates) {
    for (const p of new Set([abs, realpathPrefix(abs)])) {
      for (const r of roots) if (isInside(p, r)) return abs;
    }
  }
  return undefined;
}

function block(message: string): never {
  console.error(message);
  process.exit(2);
}

async function main(): Promise<void> {
  const input = JSON.parse(await Bun.stdin.text()) as { tool_name?: unknown; tool_input?: Record<string, unknown>; cwd?: unknown };
  const cwd = typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : process.cwd();
  const tool = typeof input.tool_name === 'string' ? input.tool_name : '';
  const hit = findViolation(tool, input.tool_input ?? {}, cwd, cmaRoot());
  if (hit) {
    block(`Blocked by the call-my-agent read guard: ${hit} is inside the plugin's private data directory. Use the cma_* tools instead.`);
  }
}

if (import.meta.main) {
  // Claude Code treats exit 1 as non-blocking, so every failure path must exit 2.
  process.on('uncaughtException', () => process.exit(2));
  process.on('unhandledRejection', () => process.exit(2));
  try {
    await main();
  } catch (err) {
    block(`call-my-agent read guard failed (${err instanceof Error ? err.message : 'unknown error'}); blocking the read.`);
  }
}
