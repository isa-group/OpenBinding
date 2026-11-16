import { describe, expect, it } from 'vitest';
import { jobStatus, planLimit } from './model';

describe('the run status in words', () => {
  it('says how a run ended, not only that it finished', () => {
    expect(jobStatus('running')).toEqual({ label: 'Running', tone: 'running' });
    expect(jobStatus('queued')).toEqual({ label: 'Queued', tone: 'queued' });
    expect(jobStatus('completed', 'INFEASIBLE')).toEqual({ label: 'No feasible binding', tone: 'warn' });
    expect(jobStatus('completed', 'OPTIMAL')).toEqual({ label: 'Optimal', tone: 'ok' });
    expect(jobStatus('completed', 'FEASIBLE')).toEqual({ label: 'Feasible', tone: 'ok' });
    expect(jobStatus('completed')).toEqual({ label: 'Completed', tone: 'ok' });
    expect(jobStatus('failed')).toEqual({ label: 'Failed', tone: 'bad' });
    expect(jobStatus('cancelled')).toEqual({ label: 'Cancelled', tone: 'off' });
    expect(jobStatus('mystery')).toEqual({ label: 'mystery', tone: 'off' });
  });
});

describe('the plan limits', () => {
  it('reads a 0.2.0 usage limit from the pricing document, the plan’s own value over the default', () => {
    const catalog = {
      usageLimits: { maxRunMinutes: { defaultValue: 30 }, maxConcurrentRuns: { defaultValue: 1 } },
      plans: { FREE: {}, LAB: { usageLimits: { maxRunMinutes: { value: 1440 }, maxConcurrentRuns: { value: 8 } } } },
    };
    expect(planLimit(catalog, 'LAB', 'maxRunMinutes')).toBe(1440);
    expect(planLimit(catalog, 'LAB', 'maxConcurrentRuns')).toBe(8);
    expect(planLimit(catalog, 'FREE', 'maxRunMinutes')).toBe(30);
    expect(planLimit(catalog, 'NOPE', 'maxConcurrentRuns')).toBe(1);
    expect(planLimit(catalog, 'FREE', 'maxProblems')).toBeNull();
    expect(planLimit(null, 'FREE', 'maxRunMinutes')).toBeNull();
    expect(planLimit(catalog, undefined, 'maxRunMinutes')).toBeNull();
  });
});
