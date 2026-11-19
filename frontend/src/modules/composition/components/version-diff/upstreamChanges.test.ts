import { describe, expect, it } from 'vitest';
import type { UpstreamView } from '../../../core/api/types';
import upstream from '../../../../test/fixtures/core/tomatometer-email.upstream.json';
import { upstreamChanges } from './upstreamChanges';

const base = upstream as UpstreamView;
const withPlan = (plan: string, version = '6ade2d444b2b5b01c587d80d'): UpstreamView => {
  const view = structuredClone(base);
  const brevo = view.entries.find(entry => entry.task === 'dailySummary')!;
  brevo.from = { ...brevo.from, plan, version };
  return view;
};

describe('upstreamChanges', () => {
  it('finds a task that pins another plan of the same provider', () => {
    const changes = upstreamChanges(
      { view: base, yaml: {} },
      { view: withPlan('STANDARD'), yaml: {} }
    );
    expect(changes.map(change => change.task)).toEqual(['dailySummary']);
    expect(changes[0].before.from?.plan).toBe('PROFESSIONAL');
    expect(changes[0].after.from?.plan).toBe('STANDARD');
  });

  it('finds a task that pins another version of the same provider, and nothing when nothing moves', () => {
    expect(
      upstreamChanges(
        { view: base, yaml: {} },
        { view: withPlan('PROFESSIONAL', '0123456789abcdef01234567'), yaml: {} }
      )
    ).toHaveLength(1);
    expect(upstreamChanges({ view: base, yaml: {} }, { view: base, yaml: {} })).toEqual([]);
  });

  it('ignores a task bound to another provider altogether', () => {
    const view = structuredClone(base);
    const email = view.entries.find(entry => entry.task === 'dailySummary')!;
    email.from = {
      sphere: 'danruilop1/resend',
      version: '6ade2d254b2b5b01c587d7ee',
      plan: 'PRO',
    };
    email.snapshot = { ...email.snapshot!, pricingId: '6ade2d2540e55445692b07c6' };
    expect(upstreamChanges({ view: base, yaml: {} }, { view, yaml: {} })).toEqual([]);
  });
});
