import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { DECISION_KINDS, type DecisionKind, type JsonPatchOp } from '@cma/protocol';
import { ToolError, errorText } from './call.ts';
import { sanitizeLabel } from './format.ts';
import { CallManager, NOT_CALL_SESSION_DETAIL, type ToolResult } from './manager.ts';
import { resolveRoot } from './store.ts';

const session = z.string().describe('Call session id (ses_...)');
const decisionKind = z.enum(DECISION_KINDS as [DecisionKind, ...DecisionKind[]]);
const patchOp = z.object({
  op: z.enum(['add', 'remove', 'replace', 'move', 'copy', 'test']),
  path: z.string(),
  value: z.unknown().optional(),
  from: z.string().optional(),
});
const patch = z.array(patchOp).describe('RFC 6902 JSON Patch against the current plan; a leading test of /version is added if missing');
const checkpointRef = z.string().describe('checkpoint_ref returned by cma_answer_checkpoint');

function ok(result: ToolResult): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}

/** Protocol details can quote plan item ids, which the peer chose, so they reach the model flattened to one line. */
function failure(err: unknown): CallToolResult {
  const fixed = err instanceof ToolError && err.code === 'NOT_CALL_SESSION';
  const detail = fixed ? NOT_CALL_SESSION_DETAIL : sanitizeLabel(err instanceof ToolError ? err.detail : errorText(err), 500);
  const body = { error: err instanceof ToolError ? err.code : 'INTERNAL', detail };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(body) }] };
}

/** The `cma` MCP server (§4.3) over one CallManager. No tool produces a signoff; those come only from signoff.json. */
export function createServer(manager: CallManager): McpServer {
  const server = new McpServer({ name: 'cma', version: '0.1.0' });
  const run = async (fn: () => ToolResult | Promise<ToolResult>): Promise<CallToolResult> => {
    try {
      return ok(await fn());
    } catch (err) {
      return failure(err);
    }
  };

  server.registerTool(
    'cma_start_call',
    {
      description: 'Create a call: charter, plan v0 and invite. Only after your human confirmed the peer, topic, mode and share set.',
      inputSchema: {
        peer: z.string().min(1).describe('Who is being called, e.g. "bob" or "billing team"'),
        topic: z.string().min(1),
        type: z.enum(['contract', 'impact', 'plan', 'question']).default('contract'),
        mode: z.enum(['org', 'open']).default('org'),
        share_set: z.array(z.string()).optional().describe('Paths or globs the call may quote from'),
      },
    },
    (args) => run(() => manager.startCall(args)),
  );

  server.registerTool(
    'cma_inspect_invite',
    {
      description: 'Show the charter, caller identity, fingerprint, mode and share set of an invite without joining the call.',
      inputSchema: { invite: z.string().min(1) },
    },
    (args) => run(() => manager.inspectInvite(args)),
  );

  server.registerTool(
    'cma_join_call',
    {
      description: 'Join a call from an invite, after your human confirmed. Returns the four-word code to compare out of band.',
      inputSchema: { invite: z.string().min(1) },
    },
    (args) => run(() => manager.joinCall(args)),
  );

  server.registerTool(
    'cma_say',
    {
      description: 'Send a message to the peer agent. Needs the floor.',
      inputSchema: {
        session,
        text: z.string().min(1),
        evidence: z.array(z.object({ ref: z.string().describe('path:line'), commit: z.string().optional() })).optional(),
      },
    },
    (args) => run(() => manager.say(args)),
  );

  server.registerTool(
    'cma_propose',
    {
      description: 'Propose a change to the shared plan. Needs the floor; applied only when the peer accepts.',
      inputSchema: {
        session,
        patch,
        kinds: z.array(decisionKind).optional(),
        rationale: z.string(),
        checkpoint_ref: checkpointRef.optional(),
      },
    },
    (args) => run(() => manager.propose({ ...args, patch: args.patch as JsonPatchOp[] })),
  );

  server.registerTool(
    'cma_respond',
    {
      description: 'Accept, reject or counter the pending proposal or sign-off request. Needs the floor.',
      inputSchema: {
        session,
        action: z.enum(['accept', 'reject', 'counter']),
        reasons: z.array(z.union([z.string(), z.object({ item: z.string().optional(), text: z.string() })])).optional(),
        patch: patch.optional().describe('counter only'),
        kinds: z.array(decisionKind).optional(),
        rationale: z.string().optional(),
        checkpoint_ref: checkpointRef.optional(),
      },
    },
    (args) => run(() => manager.respond({ ...args, patch: args.patch as JsonPatchOp[] | undefined })),
  );

  server.registerTool(
    'cma_withdraw',
    { description: 'Withdraw your own pending proposal.', inputSchema: { session } },
    (args) => run(() => manager.withdraw(args)),
  );

  server.registerTool(
    'cma_checkpoint',
    {
      description: 'Tell the peer you are asking your human. The question stays local. Then end your turn and ask your human.',
      inputSchema: {
        session,
        question: z.string().min(1),
        kind: decisionKind.optional(),
        blocks: z.array(z.string()).optional().describe('Plan item ids this question blocks'),
      },
    },
    (args) => run(() => manager.checkpoint(args)),
  );

  server.registerTool(
    'cma_answer_checkpoint',
    {
      description: "Share a summary of your human's answer. Returns the checkpoint_ref for the next propose or respond.",
      inputSchema: { session, checkpoint_id: z.string().min(1), shareable_summary: z.string() },
    },
    (args) => run(() => manager.answerCheckpoint(args)),
  );

  server.registerTool(
    'cma_request_signoff',
    {
      description: 'Ask the peer to freeze the current plan for human sign-off. Humans sign outside this session.',
      inputSchema: { session },
    },
    (args) => run(() => manager.requestSignoff(args)),
  );

  server.registerTool(
    'cma_plan_get',
    {
      description: 'Read the plan (current or a past version) with its plan hash and markdown hash.',
      inputSchema: {
        session,
        format: z.enum(['markdown', 'json']).default('markdown'),
        version: z.number().int().nonnegative().optional(),
      },
    },
    (args) => run(() => manager.planGet(args)),
  );

  server.registerTool(
    'cma_status',
    {
      description: 'State, floor, plan version and hashes, pending proposal, sign-offs, budgets and checkpoints of a call.',
      inputSchema: { session: session.optional() },
    },
    (args) => run(() => manager.status(args)),
  );

  server.registerTool(
    'cma_list_calls',
    { description: 'List calls on this machine with state, floor and plan version.', inputSchema: {} },
    () => run(() => manager.listCalls()),
  );

  server.registerTool(
    'cma_wait',
    {
      description: 'Wait for new messages from the peer (up to timeout_s seconds) and return them.',
      inputSchema: { session, timeout_s: z.number().int().min(0).max(300).default(60) },
    },
    (args) => run(() => manager.wait(args)),
  );

  server.registerTool(
    'cma_inbox',
    { description: 'Return queued messages from the peer without waiting.', inputSchema: { session } },
    (args) => run(() => manager.inboxRead(args)),
  );

  server.registerTool(
    'cma_hangup',
    {
      description: 'End the call without agreement.',
      inputSchema: { session, reason: z.string().default('ended by user') },
    },
    (args) => run(() => manager.hangup(args)),
  );

  server.registerTool(
    'cma_write_plan',
    {
      description: 'After both humans signed: write the agreement file under docs/agreements/ and close the call.',
      inputSchema: { session },
    },
    (args) => run(() => manager.writePlan(args)),
  );

  return server;
}

if (import.meta.main) {
  const manager = new CallManager({
    home: resolveRoot(),
    relayUrl: process.env.CMA_RELAY_URL,
    repoRoot: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
    env: process.env,
  });
  await manager.init();
  const server = createServer(manager);
  const shutdown = async (): Promise<void> => {
    await manager.close();
    process.exit(0);
  };
  // Relay sockets and watchers keep the event loop alive; closing them at the end of stdin lets the process
  // exit once the replies already in flight are written.
  process.stdin.on('end', () => void manager.close());
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  await server.connect(new StdioServerTransport());
}
