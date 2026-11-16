import { describe, expect, it } from 'vitest';
import { auditFixture } from './auditFixture';
import { actionLabel, changesOf, describeEvent, detailRows, kindOf, toCsv } from './auditModel';

describe('actionLabel', () => {
  it('keeps the labels of the known actions', () => {
    expect(actionLabel('problem.created')).toBe('Problem created');
    expect(actionLabel('organization.member.removed')).toBe('Member removed');
  });

  it('reads an unknown action in the words of the interface', () => {
    expect(actionLabel('binding_case.created')).toBe('Binding problem created');
    expect(actionLabel('job.cancelled')).toBe('Run cancelled');
    expect(actionLabel('publication.withdrawn')).toBe('Published result withdrawn');
    expect(actionLabel('study.frozen')).toBe('Study frozen');
  });

  it('reads the keys of a detail in the same words', () => {
    expect(detailRows({ case_slug: 'flujo', jobCount: 2 }).map(row => row.label)).toEqual([
      'Problem slug',
      'Run count',
    ]);
  });
});

describe('detailRows', () => {
  it('keeps strings as they are and formats numbers and booleans', () => {
    expect(detailRows({ plan: 'team', seat_count: 12345, active: true, suspended: false })).toEqual(
      [
        { label: 'Plan', value: { kind: 'text', text: 'team' } },
        { label: 'Seat count', value: { kind: 'text', text: '12,345' } },
        { label: 'Active', value: { kind: 'text', text: 'Yes' } },
        { label: 'Suspended', value: { kind: 'text', text: 'No' } },
      ]
    );
  });

  it('draws digests, UUIDs and long hex runs as the word identifier, and leaves other strings', () => {
    const identifier = { kind: 'text', text: 'identifier' };
    expect(
      detailRows({
        digest: 'sha256-' + 'ab'.repeat(32),
        target: '3F2B8C1E-5D4A-4E7B-9C6D-1A2B3C4D5E6F',
        hash: 'AB'.repeat(16),
        role: 'ADMIN',
        email: 'lucia@example.org',
        name: 'abc',
      }).map(row => row.value)
    ).toEqual([
      identifier,
      identifier,
      identifier,
      { kind: 'text', text: 'ADMIN' },
      { kind: 'text', text: 'lucia@example.org' },
      { kind: 'text', text: 'abc' },
    ]);
  });

  it('hides identifiers inside lists and nested objects too', () => {
    const uuid = '3f2b8c1e-5d4a-4e7b-9c6d-1a2b3c4d5e6f';
    expect(
      detailRows({ ids: [uuid, 'owner'], inner: { digest: 'sha256-' + 'cd'.repeat(32) } })
    ).toEqual([
      {
        label: 'Ids',
        value: {
          kind: 'list',
          items: [
            { kind: 'text', text: 'identifier' },
            { kind: 'text', text: 'owner' },
          ],
        },
      },
      {
        label: 'Inner',
        value: {
          kind: 'fields',
          rows: [{ label: 'Digest', value: { kind: 'text', text: 'identifier' } }],
        },
      },
    ]);
  });

  it('reads null and undefined as none', () => {
    expect(detailRows({ note: null, other: undefined })).toEqual([
      { label: 'Note', value: { kind: 'text', text: 'none' } },
      { label: 'Other', value: { kind: 'text', text: 'none' } },
    ]);
  });

  it('turns arrays into lists and objects into nested rows with sentence-case keys', () => {
    expect(
      detailRows({
        tags: ['a', 2],
        previousLimits: { max_projects: 3, nested: { isPublic: true } },
      })
    ).toEqual([
      {
        label: 'Tags',
        value: {
          kind: 'list',
          items: [
            { kind: 'text', text: 'a' },
            { kind: 'text', text: '2' },
          ],
        },
      },
      {
        label: 'Previous limits',
        value: {
          kind: 'fields',
          rows: [
            { label: 'Max projects', value: { kind: 'text', text: '3' } },
            {
              label: 'Nested',
              value: {
                kind: 'fields',
                rows: [{ label: 'Is public', value: { kind: 'text', text: 'Yes' } }],
              },
            },
          ],
        },
      },
    ]);
  });

  it('leaves out the keys it is told to and returns nothing for an empty detail', () => {
    expect(detailRows({ changes: [1], role: 'ADMIN' }, ['changes']).map(row => row.label)).toEqual([
      'Role',
    ]);
    expect(detailRows(null)).toEqual([]);
    expect(detailRows({})).toEqual([]);
  });
});

describe('toCsv', () => {
  it('keeps its JSON detail column', () => {
    const csv = toCsv([
      {
        id: 'e',
        organizationId: 'o',
        actorId: null,
        action: 'a',
        targetType: 't',
        targetId: null,
        detail: { k: 1 },
        createdAt: 'now',
      },
    ]);
    expect(csv.split('\n')[1]).toBe('e,now,,a,t,,"{""k"":1}"');
  });
});

describe('the audit log', () => {
  it('groups actions into kinds', () => {
    expect(kindOf('organization.created')).toBe('organization');
    expect(kindOf('organization.members.batch_updated')).toBe('members');
    expect(kindOf('organization.invitation.created')).toBe('members');
    expect(kindOf('problem.deleted')).toBe('problems');
    expect(kindOf('binding_case.revision.created')).toBe('content');
    expect(kindOf('something.new')).toBe('other');
  });

  it('describes a batch by how many changes it applied and exposes them', () => {
    const [, batch] = auditFixture;
    expect(describeEvent(batch)).toBe('2 member changes applied together');
    expect(changesOf(batch)).toEqual([
      { userId: 'user-marco', role: 'ADMIN' },
      { userId: 'user-sofia', role: null },
    ]);
  });

  it('exports plain CSV, quoting what needs it', () => {
    const csv = toCsv(auditFixture);
    const [head, first] = csv.split('\n');
    expect(head).toBe('id,createdAt,actorId,action,targetType,targetId,detail');
    expect(first.startsWith('ev-3,')).toBe(true);
    expect(csv).toContain('"{""changes"":');
  });
});
