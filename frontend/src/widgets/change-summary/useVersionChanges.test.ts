// Adapted from SPHERE frontend/src/modules/pricing/components/pricing-version-graph/use-version-changes.test.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the hook runs under renderHook instead of react-test-renderer, rendered before the timers advance; the gateway's diff (`compositionsApi.diff`) is mocked
// where SPHERE mocked fetch and the YAML files, so a pair of versions answers a diff whose binding section lists what was added;
// the credential is the signed-in account.

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompositionVersionDiff } from '../../shared/api/types';
import fms from '../../test/fixtures/core/fms.diff.json';
import { useVersionChanges, type ChangesState, type ChangesTarget } from './useVersionChanges';

const auth = vi.hoisted(() => ({ user: { id: 'first-user' } }));
vi.mock('../../contexts/auth', () => ({ useAuth: () => ({ user: auth.user }) }));
const api = vi.hoisted(() => ({ diff: vi.fn() }));
vi.mock('../../entities/composition/api', () => ({ compositionsApi: api }));

/** A diff whose binding section adds these tasks and changes nothing else. */
function diffAdding(added: string[]): CompositionVersionDiff {
  const diff = structuredClone(fms) as CompositionVersionDiff;
  diff.sections = [{ key: 'binding', label: 'Binding', entries: added.map((name) => ({ kind: 'added' as const, name, changes: [] })) }];
  diff.general = [];
  diff.isEmpty = added.length === 0;
  diff.totals = { added: added.length, removed: 0, changed: 0 };
  return diff;
}

const pair = (before: string, after: string): ChangesTarget => ({ org: 'isa-demo', composition: 'order-desk', key: 'composition-v3', before, after });

describe('version change cache', () => {
  let latest: ChangesState;
  let target: ChangesTarget | null;
  let revision: object;
  let answers: Record<string, string[]>;
  let view: { rerender: () => void; unmount: () => void } | undefined;

  // Render (its effects run as the render's own act ends), then let the delay pass and the diff answer.
  const render = async () => {
    if (view) view.rerender();
    else view = renderHook(() => { latest = useVersionChanges(target, revision); return latest; });
    await act(async () => { await vi.advanceTimersByTimeAsync(151); });
  };
  const additions = () => {
    if (latest.status !== 'ready') throw new Error(`Expected ready, got ${latest.status}`);
    return latest.summary.sections.flatMap((section) => section.added);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    api.diff.mockReset().mockImplementation(async (_org: string, _composition: string, before: string, after: string) => diffAdding(answers[`${before}..${after}`] ?? []));
    auth.user = { id: 'first-user' };
    revision = {};
    target = pair('v2', 'v3');
    answers = { 'v1..v3': ['Pro', 'Enterprise'], 'v2..v3': ['Enterprise'] };
  });

  afterEach(() => {
    act(() => view?.unmount());
    view = undefined;
    vi.useRealTimers();
  });

  it('reuses a comparison within the same snapshot of the versions', async () => {
    await render();
    expect(additions()).toEqual(['Enterprise']);
    target = null;
    await render();
    expect(latest.status).toBe('idle');
    target = pair('v2', 'v3');
    await render();
    expect(additions()).toEqual(['Enterprise']);
    expect(api.diff).toHaveBeenCalledTimes(1);
    expect(api.diff).toHaveBeenCalledWith('isa-demo', 'order-desk', 'v2', 'v3');
  });

  it('compares again when the previous version is another one', async () => {
    await render();
    target = pair('v1', 'v3');
    await render();
    expect(additions()).toEqual(['Pro', 'Enterprise']);
  });

  it('asks again when the versions are read again', async () => {
    await render();
    answers['v2..v3'] = ['Team'];
    revision = {};
    await render();
    expect(additions()).toEqual(['Team']);
    expect(api.diff).toHaveBeenCalledTimes(2);
  });

  it('does not reuse another credential’s cached comparison', async () => {
    await render();
    auth.user = { id: 'second-user' };
    api.diff.mockRejectedValue(new Error('404'));
    await render();
    expect(latest.status).toBe('error');
    expect(api.diff).toHaveBeenCalledTimes(2);
  });

  it('ignores an old in-flight result after the versions change', async () => {
    let finish!: (value: CompositionVersionDiff) => void;
    api.diff.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await render();
    expect(latest.status).toBe('loading');
    revision = {};
    answers['v2..v3'] = ['Team'];
    await render();
    expect(additions()).toEqual(['Team']);
    await act(async () => { finish(diffAdding([])); });
    expect(additions()).toEqual(['Team']);
  });
});
