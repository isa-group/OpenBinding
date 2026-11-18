import { describe, expect, it } from 'vitest';
import type { UpstreamView } from '../../../core/api/types';
import upstream from '../../../../test/fixtures/core/tomatometer-email.upstream.json';
import { upstreamChanges } from './upstreamChanges';

const base = upstream as UpstreamView;
const withPlan = (plan: string, version = '6ade36454b2b5b01c587db3d'): UpstreamView => {
  const view = structuredClone(base);
  const mailgun = view.entries.find(entry => entry.task === 'dailySummary')!;
  mailgun.from = { ...mailgun.from, plan, version };
  return view;
};

describe('upstreamChanges', () => {
  it('finds a task that pins another plan of the same provider', () => {
    const changes = upstreamChanges(
      { view: base, yaml: {} },
      { view: withPlan('SCALE'), yaml: {} }
    );
    expect(changes.map(change => change.task)).toEqual(['dailySummary']);
    expect(changes[0].before.from?.plan).toBe('FOUNDATION');
    expect(changes[0].after.from?.plan).toBe('SCALE');
  });

  it('finds a task that pins another version of the same provider, and nothing when nothing moves', () => {
    expect(
      upstreamChanges(
        { view: base, yaml: {} },
        { view: withPlan('FOUNDATION', '0123456789abcdef01234567'), yaml: {} }
      )
    ).toHaveLength(1);
    expect(upstreamChanges({ view: base, yaml: {} }, { view: base, yaml: {} })).toEqual([]);
  });

  it('ignores a task bound to another provider altogether', () => {
    const view = structuredClone(base);
    const mailgun = view.entries.find(entry => entry.task === 'dailySummary')!;
    mailgun.from = {
      sphere: 'danruilop1/resend',
      version: '6ade2d254b2b5b01c587d7ee',
      plan: 'PRO',
    };
    mailgun.snapshot = { ...mailgun.snapshot!, pricingId: '6ade2d2540e55445692b07c6' };
    expect(upstreamChanges({ view: base, yaml: {} }, { view, yaml: {} })).toEqual([]);
  });
});
