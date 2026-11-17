import { describe, expect, it } from 'vitest';
import type { TaskModel } from '../../../../utils/composition/viewModel';
import type { CompositionVersionDiff } from '../../../../api/types';
import fms from '../../../../../../test/fixtures/core/fms.diff.json';
import {
  activeFilter,
  changeRow,
  filteredSections,
  opensAtFirst,
  removedTasks,
  selectionTags,
  showsGeneral,
  taskOverlay,
  workflowChanged,
} from './diffModel';

const diff = () => structuredClone(fms) as CompositionVersionDiff;
const task = (id: string, over: Partial<TaskModel> = {}): TaskModel => ({
  id,
  local: false,
  candidate: null,
  from: null,
  provider: null,
  ...over,
});

describe('the comparison model', () => {
  it('filters the entries by kind, leaving out the sections that have none, and drops a filter with nothing to show', () => {
    const value = diff();
    value.sections[0].entries.push({ kind: 'added', name: 'T9', changes: [] });
    value.totals = { added: 1, removed: 0, changed: 5 };
    expect(filteredSections(value, null).map(section => section.key)).toEqual([
      'binding',
      'values',
    ]);
    expect(
      filteredSections(value, 'added').map(section => [
        section.key,
        section.entries.map(entry => entry.name),
      ])
    ).toEqual([['binding', ['T9']]]);
    expect(activeFilter(value, 'removed')).toBeNull();
    expect(activeFilter(value, 'added')).toBe('added');
  });

  it('counts general changes as changed', () => {
    const value = diff();
    value.general = [{ path: 'kind', before: 'workflow', after: 'pipeline' }];
    expect(showsGeneral(value, null)).toBe(true);
    expect(showsGeneral(value, 'changed')).toBe(true);
    expect(showsGeneral(value, 'added')).toBe(false);
  });

  it('opens a changed entry of a few fields at first', () => {
    expect(
      opensAtFirst({
        kind: 'changed',
        name: 'T1',
        changes: [{ path: 'candidate', before: 'a', after: 'b' }],
      })
    ).toBe(true);
    expect(
      opensAtFirst({
        kind: 'added',
        name: 'T1',
        changes: [{ path: 'candidate', before: null, after: 'b' }],
      })
    ).toBe(false);
    const many = Array.from({ length: 7 }, (_, index) => ({
      path: `f${index}`,
      before: index,
      after: index + 1,
    }));
    expect(opensAtFirst({ kind: 'changed', name: 'T1', changes: many })).toBe(false);
  });

  it('reads null as absent: an added entry shows only its after side, a removed one only its before side', () => {
    expect(changeRow({ path: 'candidate', before: 'cand_a', after: 'cand_b' }, 'changed')).toEqual({
      path: 'candidate',
      before: { text: 'cand_a', absent: false },
      after: { text: 'cand_b', absent: false },
      structure: false,
    });
    expect(changeRow({ path: 'candidate', before: null, after: 'cand_b' }, 'added')).toMatchObject({
      before: null,
      after: { text: 'cand_b', absent: false },
    });
    expect(
      changeRow({ path: 'candidate', before: 'cand_a', after: null }, 'removed')
    ).toMatchObject({ before: { text: 'cand_a', absent: false }, after: null });
    // A field added or removed inside a changed entry.
    expect(
      changeRow({ path: 'from.plan', before: null, after: 'STARTER' }, 'changed')
    ).toMatchObject({ before: { text: 'not set', absent: true } });
    expect(
      changeRow({ path: 'from.plan', before: 'STARTER', after: null }, 'changed')
    ).toMatchObject({ after: { text: 'removed', absent: true } });
    expect(changeRow({ path: 'value', before: 3060, after: 3080 }, 'changed')).toMatchObject({
      before: { text: '3,060' },
      after: { text: '3,080' },
    });
  });

  it('names a changed structure instead of printing it', () => {
    expect(
      changeRow(
        { path: 'workflow', before: { seq: ['T1'] }, after: { seq: ['T1', 'T2'] } },
        'changed'
      )
    ).toEqual({ path: 'workflow', before: null, after: null, structure: true });
    const value = diff();
    value.general = [{ path: 'workflow', before: { seq: ['T1'] }, after: { seq: ['T1', 'T2'] } }];
    expect(workflowChanged(value)).toBe(true);
    expect(workflowChanged(diff())).toBe(false);
  });

  it('marks each task of the later workflow by its binding entry, and names the removed tasks it no longer has', () => {
    const value = diff();
    value.sections[0].entries.push(
      { kind: 'added', name: 'T9', changes: [] },
      { kind: 'removed', name: 'T0', changes: [] }
    );
    const tasks = [
      task('T1', { candidate: 'cand_t1_google_cloud' }),
      task('T2', { local: true }),
      task('T9', { candidate: 'cand_t9' }),
    ];
    expect(taskOverlay(value, tasks)).toEqual({
      T1: { candidate: 'cand_t1_google_cloud', status: 'changed' },
      T2: { local: true },
      T9: { candidate: 'cand_t9', status: 'added' },
    });
    expect(removedTasks(value, tasks)).toEqual(['T0']);
  });

  it('tags a candidate with every version that chose it, comparing keys only', () => {
    const tags = selectionTags([
      { label: '1.0.0', selection: { T1: 'res/cand_t1_aws', T2: 'res/cand_t2' } },
      { label: '1.1.0', selection: { T1: 'res/cand_t1_google_cloud', T2: 'res/cand_t2' } },
    ]);
    expect(tags('T1', 'res/cand_t1_aws')).toEqual(['In 1.0.0']);
    expect(tags('T1', 'res/cand_t1_google_cloud')).toEqual(['In 1.1.0']);
    expect(tags('T2', 'res/cand_t2')).toEqual(['In 1.0.0', 'In 1.1.0']);
    expect(selectionTags([{ label: '1.0.0', selection: null }])('T1', 'res/cand_t1_aws')).toEqual(
      []
    );
  });
});
