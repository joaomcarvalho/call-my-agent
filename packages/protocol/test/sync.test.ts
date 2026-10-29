import { describe, expect, test } from 'bun:test';
import { fixtureCharter, Transcript, versionTest } from './fixtures/transcript.ts';

function syncTranscript(): Transcript {
  const t = new Transcript({ ...fixtureCharter(), type: 'sync', template: 'sync' });
  t.push(t.open());
  t.push(t.hello());
  t.push(t.welcome());
  return t;
}

describe('sync call', () => {
  test('a full sync session replays to CLOSED with nothing rejected', () => {
    const t = syncTranscript();
    t.push(t.propose('A', [versionTest(0), { op: 'replace', path: '/sections/1/md', value: 'A found X' }]));
    t.push(t.accept('B'));
    t.push(t.say('A', 'your turn'));
    t.push(t.propose('B', [versionTest(1), { op: 'replace', path: '/sections/2/md', value: 'B found Y' }]));
    t.push(t.accept('A'));
    t.push(t.requestSignoff('A'));
    t.push(t.accept('B'));
    t.push(t.signoff('A'));
    t.push(t.signoff('B'));
    t.push(t.planFinal('A'));
    t.push(t.bye('A'));
    t.push(t.bye('B'));

    const r = t.state();
    expect(r.rejected).toEqual([]);
    expect(r.state).toBe('CLOSED');
    expect(r.plan?.sections.map((s) => s.md)).toEqual(['', 'A found X', 'B found Y', '', '']);
  });

  test('A editing b.findings is OWNER_VIOLATION', () => {
    const t = syncTranscript();
    t.push(t.propose('A', [versionTest(0), { op: 'replace', path: '/sections/2/md', value: 'A writes B part' }]));
    expect(t.state().rejected.map((x) => x.code)).toEqual(['OWNER_VIOLATION']);
  });
});
