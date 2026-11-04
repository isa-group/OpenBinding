import { describe, expect, it } from 'vitest';
import { actionLabel, detailRows, toCsv } from './auditModel';

describe('actionLabel', () => {
  // [utest->req~frontend-nav-vocabulary-text~1]
  it('keeps the labels of the known actions', () => {
    expect(actionLabel('project.created')).toBe('Project created');
    expect(actionLabel('organization.member.removed')).toBe('Member removed');
  });

  // [utest->req~frontend-nav-vocabulary-text~1]
  it('reads an unknown action in the words of the interface', () => {
    expect(actionLabel('binding_case.created')).toBe('Binding problem created');
    expect(actionLabel('job.cancelled')).toBe('Run cancelled');
    expect(actionLabel('publication.withdrawn')).toBe('Published result withdrawn');
    expect(actionLabel('study.frozen')).toBe('Study frozen');
  });

  // [utest->req~frontend-nav-vocabulary-text~1]
  it('reads the keys of a detail in the same words', () => {
    expect(detailRows({ case_slug: 'flujo', jobCount: 2 }).map((row) => row.label)).toEqual(['Problem slug', 'Run count']);
  });
});

describe('detailRows', () => {
  // [utest->req~frontend-audit-detail-rendered~1]
  it('keeps strings as they are and formats numbers and booleans', () => {
    expect(detailRows({ plan: 'team', seat_count: 12345, active: true, suspended: false })).toEqual([
      { label: 'Plan', value: { kind: 'text', text: 'team' } },
      { label: 'Seat count', value: { kind: 'text', text: '12,345' } },
      { label: 'Active', value: { kind: 'text', text: 'Yes' } },
      { label: 'Suspended', value: { kind: 'text', text: 'No' } },
    ]);
  });

  // [utest->req~frontend-audit-detail-rendered~1]
  it('reads null and undefined as none', () => {
    expect(detailRows({ note: null, other: undefined })).toEqual([
      { label: 'Note', value: { kind: 'text', text: 'none' } },
      { label: 'Other', value: { kind: 'text', text: 'none' } },
    ]);
  });

  // [utest->req~frontend-audit-detail-rendered~1]
  it('turns arrays into lists and objects into nested rows with sentence-case keys', () => {
    expect(detailRows({ tags: ['a', 2], previousLimits: { max_projects: 3, nested: { isPublic: true } } })).toEqual([
      { label: 'Tags', value: { kind: 'list', items: [{ kind: 'text', text: 'a' }, { kind: 'text', text: '2' }] } },
      {
        label: 'Previous limits',
        value: {
          kind: 'fields',
          rows: [
            { label: 'Max projects', value: { kind: 'text', text: '3' } },
            { label: 'Nested', value: { kind: 'fields', rows: [{ label: 'Is public', value: { kind: 'text', text: 'Yes' } }] } },
          ],
        },
      },
    ]);
  });

  // [utest->req~frontend-audit-detail-rendered~1]
  it('leaves out the keys it is told to and returns nothing for an empty detail', () => {
    expect(detailRows({ changes: [1], role: 'ADMIN' }, ['changes']).map((row) => row.label)).toEqual(['Role']);
    expect(detailRows(null)).toEqual([]);
    expect(detailRows({})).toEqual([]);
  });
});

describe('toCsv', () => {
  // [utest->req~frontend-audit-detail-rendered~1]
  it('keeps its JSON detail column', () => {
    const csv = toCsv([{ id: 'e', organizationId: 'o', actorId: null, action: 'a', targetType: 't', targetId: null, detail: { k: 1 }, createdAt: 'now' }]);
    expect(csv.split('\n')[1]).toBe('e,now,,a,t,,"{""k"":1}"');
  });
});
