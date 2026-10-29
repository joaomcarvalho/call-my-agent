// @bun
// plugin/hooks/read-guard.ts
import { existsSync, realpathSync } from "fs";
import { homedir as homedir2 } from "os";
import { dirname, join as join2, resolve, sep } from "path";

// plugin/hooks/lib.ts
import { homedir } from "os";
import { join } from "path";
function cmaRoot(env = process.env) {
  return env.CMA_HOME || env.CLAUDE_PLUGIN_DATA || join(homedir(), ".call-my-agent");
}

// plugin/hooks/read-guard.ts
var GLOB_CHARS = /[*?[\]{}]/;
function realpathPrefix(p) {
  const rest = [];
  let cur = p;
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur)
      return p;
    rest.unshift(cur.slice(parent.length).replace(/^[\\/]+/, ""));
    cur = parent;
  }
  return resolve(realpathSync.native(cur), ...rest);
}
function expandHome(p) {
  if (p === "~")
    return homedir2();
  if (p.startsWith("~/"))
    return join2(homedir2(), p.slice(2));
  return p;
}
function isInside(p, root) {
  return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
}
function globBase(pattern) {
  const segments = pattern.split("/");
  const fixed = [];
  for (const seg of segments) {
    if (GLOB_CHARS.test(seg))
      break;
    fixed.push(seg);
  }
  return fixed.length === segments.length ? pattern : fixed.join("/") || "/";
}
function findViolation(toolName, toolInput, cwd, rootDir) {
  const roots = new Set([resolve(rootDir), realpathPrefix(resolve(rootDir))]);
  const str = (v) => typeof v === "string" && v !== "" ? v : undefined;
  const base = resolve(cwd, expandHome(str(toolInput.path) ?? str(toolInput.notebook_path) ?? cwd));
  const candidates = [base];
  const file = str(toolInput.file_path);
  if (file)
    candidates.push(resolve(cwd, expandHome(file)));
  const globs = [toolName === "Glob" ? str(toolInput.pattern) : undefined, str(toolInput.glob)];
  for (const g of globs)
    if (g)
      candidates.push(resolve(base, expandHome(globBase(g))));
  for (const abs of candidates) {
    for (const p of new Set([abs, realpathPrefix(abs)])) {
      for (const r of roots)
        if (isInside(p, r))
          return abs;
    }
  }
  return;
}
function block(message) {
  console.error(message);
  process.exit(2);
}
async function main() {
  const input = JSON.parse(await Bun.stdin.text());
  const cwd = typeof input.cwd === "string" && input.cwd !== "" ? input.cwd : process.cwd();
  const tool = typeof input.tool_name === "string" ? input.tool_name : "";
  const hit = findViolation(tool, input.tool_input ?? {}, cwd, cmaRoot());
  if (hit) {
    block(`Blocked by the call-my-agent read guard: ${hit} is inside the plugin's private data directory. Use the cma_* tools instead.`);
  }
}
if (import.meta.main) {
  process.on("uncaughtException", () => process.exit(2));
  process.on("unhandledRejection", () => process.exit(2));
  try {
    await main();
  } catch (err) {
    block(`call-my-agent read guard failed (${err instanceof Error ? err.message : "unknown error"}); blocking the read.`);
  }
}
export {
  findViolation
};
