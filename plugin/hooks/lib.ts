import { homedir } from 'node:os';
import { join } from 'node:path';

/** CMA root: `CMA_HOME`, else `CLAUDE_PLUGIN_DATA`, else `~/.call-my-agent`. */
export function cmaRoot(env: Record<string, string | undefined> = process.env): string {
  return env.CMA_HOME || env.CLAUDE_PLUGIN_DATA || join(homedir(), '.call-my-agent');
}
