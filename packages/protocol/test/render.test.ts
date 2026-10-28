import { describe, expect, test } from 'bun:test';
import { hashObject, sha256Hash } from '../src/canonical.ts';
import { markdownHash, renderMarkdown } from '../src/render.ts';
import { createPlanV0 } from '../src/templates.ts';
import type { Decision, Plan } from '../src/types.ts';
import { artifact, fixtureCharter, workedTranscript } from './fixtures/transcript.ts';

const charter = fixtureCharter();
const v0 = (): Plan => createPlanV0(charter, hashObject(charter), charter.invitee_label);
const finalPlan = (): Plan => workedTranscript().t.state().plan!;

function decision(id: string, decided_by: Decision['decided_by']): Decision {
  return { id, text: `decision ${id}`, decided_by, decided_in: null };
}

/** A plan whose free text carries CRLF, lone CR, trailing spaces and tabs everywhere. */
function messyPlan(): Plan {
  const plan = v0();
  plan.meta.title = 'Title with trailing space   \r\n';
  plan.sections[0]!.md = 'line one  \r\nline two\t\r\n\r\n\r\nline three \rline four   \n\n\n';
  plan.sections[1]!.artifacts = [artifact('spec', 'openapi-3.1', 'a: 1   \r\nb: 2\t\n')];
  plan.decisions = [{ ...decision('D1', 'human-A'), text: 'multi\r\nline  ' }];
  plan.disagreements = [{ id: 'X1', text: 'we differ  \r\n', resolution: 'resolved  \r\nlater  ' }];
  plan.open_items = [{ id: 'OI1', text: 'open  ', blocking: false, owner: 'B', status: 'deferred' }];
  plan.action_items.B = [{ id: 'B1', text: 'do it  \r\n  then this  ' }];
  return plan;
}

describe('renderMarkdown', () => {
  test('AC10: output ends with exactly one newline', () => {
    for (const plan of [v0(), finalPlan(), messyPlan()]) {
      const md = renderMarkdown(plan);
      expect(md.endsWith('\n')).toBe(true);
      expect(md.endsWith('\n\n')).toBe(false);
    }
  });

  test('AC10: output has no carriage returns or trailing whitespace, even when the plan text does', () => {
    for (const plan of [v0(), finalPlan(), messyPlan()]) {
      const md = renderMarkdown(plan);
      expect(md.includes('\r')).toBe(false);
      expect(md.split('\n').filter((line) => /\s$/.test(line))).toEqual([]);
    }
  });

  test('AC10: agent-assumed decisions come first, then decisions by id', () => {
    const plan = v0();
    plan.decisions = [decision('D10', 'human-A'), decision('D2', 'agent-assumed'), decision('D1', 'human-B'), decision('D11', 'agent-assumed'), decision('D3', 'agent-assumed')];
    const rows = renderMarkdown(plan)
      .split('\n')
      .filter((line) => line.startsWith('| D'))
      .map((line) => line.split(' | ')[0]!.slice(2));
    expect(rows).toEqual(['D2', 'D3', 'D11', 'D1', 'D10']);
  });

  test('AC10: the worked transcript’s final plan renders to the pinned snapshot', async () => {
    const snapshot = await Bun.file(new URL('./fixtures/worked-final.md', import.meta.url)).text();
    const plan = finalPlan();
    expect(renderMarkdown(plan)).toBe(snapshot);
    expect(markdownHash(plan)).toBe(sha256Hash(snapshot));
  });

  test('rendering is independent of object key order', () => {
    const plan = finalPlan();
    const reversed = JSON.parse(JSON.stringify(plan), (_key, value) =>
      value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).reverse()) : value,
    ) as Plan;
    expect(Object.keys(reversed)).toEqual(Object.keys(plan).reverse());
    expect(renderMarkdown(reversed)).toBe(renderMarkdown(plan));
  });

  test('blocks appear in spec order: title, meta, decisions, sections, disagreements, open items, action items', () => {
    const md = renderMarkdown(finalPlan());
    const headings = md.split('\n').filter((line) => /^#{1,3} /.test(line));
    expect(headings).toEqual([
      '# Order list API for billing',
      '## Decisions',
      '## Context',
      '## Interface',
      '## Implementation notes (A)',
      '## Implementation notes (B)',
      '## Rollout',
      '## Risks',
      '## Disagreements',
      '## Open items',
      '## Action items',
      '### A · alice@orders.example',
      '### B · billing team',
    ]);
    expect(md.split('\n')[2]).toStartWith('contract · version 2 · session `ses_fixture_orders_billing`');
  });

  test('artifacts render as fenced blocks with the format as info string, fenced past any backtick run', () => {
    const plan = v0();
    plan.sections[1]!.artifacts = [artifact('notes', 'markdown', 'before\n```\ninside\n````\nafter\n')];
    const md = renderMarkdown(plan);
    expect(md).toContain('`````markdown\nbefore\n```\ninside\n````\nafter\n`````\n');
  });

  test('table cells escape pipes and fold line breaks', () => {
    const plan = v0();
    plan.decisions = [{ ...decision('D1', 'human-A'), text: 'a | b\nc' }];
    expect(renderMarkdown(plan)).toContain('| D1 | a \\| b c | — | human-A | — |');
  });

  test('empty lists and sections render explicitly', () => {
    const md = renderMarkdown(v0());
    expect(md).toContain('## Decisions\n\n_None._\n');
    expect(md).toContain('## Context\n\n_Section `context` · prose · owner: joint_\n\n_No content._\n');
    expect(md).toContain('### B · billing team\n\n_None._\n');
  });

  test('markdownHash is the sha256 of the rendered text', () => {
    const plan = finalPlan();
    expect(markdownHash(plan)).toBe(sha256Hash(renderMarkdown(plan)));
  });
});
