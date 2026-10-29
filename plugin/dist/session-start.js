// @bun
// plugin/hooks/session-start.ts
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join as join2 } from "path";

// plugin/hooks/lib.ts
import { homedir } from "os";
import { join } from "path";
function cmaRoot(env = process.env) {
  return env.CMA_HOME || env.CLAUDE_PLUGIN_DATA || join(homedir(), ".call-my-agent");
}

// plugin/hooks/session-start.ts
var root = cmaRoot();
var socket = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
var token = process.env.CLAUDE_CODE_MESSAGING_TOKEN;
if (socket && token) {
  mkdirSync(root, { recursive: true, mode: 448 });
  const file = join2(root, "session-env.json");
  writeFileSync(file, JSON.stringify({ socket, token }), { mode: 384 });
  chmodSync(file, 384);
}
var lines = [];
var callsDir = join2(root, "calls");
if (existsSync(callsDir)) {
  for (const name of readdirSync(callsDir).sort()) {
    try {
      const call = JSON.parse(readFileSync(join2(callsDir, name, "call.json"), "utf8"));
      const peer = typeof call.peer === "string" ? call.peer : call.peer?.human;
      lines.push(`${call.session ?? name} (you are party ${call.party ?? "?"}${peer ? `, peer ${peer}` : ""})`);
    } catch {
      continue;
    }
  }
}
if (lines.length > 0) {
  const additionalContext = `[call-my-agent] Calls on this machine: ${lines.join("; ")}. Use cma_list_calls for their state and the negotiate skill before acting.`;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } }));
}
