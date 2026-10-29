import type { Charter, Hash, Plan, PlanSection, SectionOwner, SectionType } from './types.ts';
import { PLAN_SCHEMA } from './types.ts';

function section(id: string, title: string, type: SectionType, owner: SectionOwner): PlanSection {
  return { id, title, type, owner, md: '' };
}

const CONTRACT_SECTIONS: PlanSection[] = [
  section('context', 'Context', 'prose', 'joint'),
  section('interface', 'Interface', 'interface', 'joint'),
  section('a.impl_notes', 'Implementation notes (A)', 'prose', 'A'),
  section('b.impl_notes', 'Implementation notes (B)', 'prose', 'B'),
  section('rollout', 'Rollout', 'rollout', 'joint'),
  section('risks', 'Risks', 'risks', 'joint'),
];

const SYNC_SECTIONS: PlanSection[] = [
  section('goal', 'Goal', 'prose', 'joint'),
  section('a.findings', 'Findings (A)', 'prose', 'A'),
  section('b.findings', 'Findings (B)', 'prose', 'B'),
  section('shared_model', 'Shared model', 'prose', 'joint'),
  section('risks', 'Risks', 'risks', 'joint'),
];

const QUESTION_SECTIONS: PlanSection[] = [
  section('question', 'Question', 'prose', 'joint'),
  section('answer', 'Answer', 'prose', 'B'),
  section('follow_ups', 'Follow-ups', 'prose', 'joint'),
];

const GENERIC_SECTIONS: PlanSection[] = [section('context', 'Context', 'prose', 'joint'), section('notes', 'Notes', 'prose', 'joint')];

/** Plan v0 seeded from the charter's call type. `meta.parties.B` is fixed here and can never be patched. */
export function createPlanV0(charter: Charter, charterHash: Hash, inviteeHuman: string): Plan {
  const sections =
    charter.type === 'contract'
      ? CONTRACT_SECTIONS
      : charter.type === 'sync'
        ? SYNC_SECTIONS
        : charter.type === 'question'
          ? QUESTION_SECTIONS
          : GENERIC_SECTIONS;
  return {
    schema: PLAN_SCHEMA,
    session: charter.session,
    version: 0,
    parent: null,
    meta: {
      title: charter.topic,
      type: charter.type,
      parties: { A: charter.inviter.human, B: inviteeHuman },
      charter_hash: charterHash,
    },
    sections: sections.map((s) => ({ ...s })),
    decisions: [],
    disagreements: [],
    open_items: [],
    action_items: { A: [], B: [] },
  };
}
