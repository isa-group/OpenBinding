import { describe, expect, it } from 'vitest';
import {
  bindingRows, canRetryState, forecastBar, formatOption, formatTook, isActive, metricEntries, normalizeStatus, optionRows, outcomeOf,
  readPins, scoreText, secondsBetween, statusCounts, timelineOf, tookPercent,
} from './jobsModel';

describe('states', () => {
  it('knows which runs are still moving and which can be retried', () => {
    expect(['queued', 'running'].every(isActive)).toBe(true);
    expect(['completed', 'failed', 'cancelled'].some(isActive)).toBe(false);
    expect(['failed', 'cancelled'].every(canRetryState)).toBe(true);
    expect(canRetryState('completed')).toBe(false);
    expect(normalizeStatus('CANCELED')).toBe('cancelled');
  });

  it('counts runs by status, with the total under the empty key', () => {
    expect(statusCounts([{ status: 'queued' }, { status: 'completed' }, { status: 'completed' }, { status: 'canceled' }])).toEqual({
      '': 4, queued: 1, completed: 2, cancelled: 1,
    });
  });
});

describe('outcomes and time', () => {
  it('words how a run ended', () => {
    expect(outcomeOf('FEASIBLE')).toMatchObject({ label: 'Feasible', tone: 'success' });
    expect(outcomeOf('INFEASIBLE')).toMatchObject({ label: 'No feasible binding', tone: 'warning' });
    expect(outcomeOf('UNKNOWN')).toMatchObject({ label: 'No conclusion' });
    expect(outcomeOf(null)).toBeNull();
  });

  it('measures and spells durations', () => {
    expect(secondsBetween('2026-10-01T09:00:00Z', '2026-10-01T09:01:05Z')).toBe(65);
    expect(secondsBetween('2026-10-01T09:00:00Z', null)).toBeNull();
    expect(formatTook(65)).toBe('1 min 5 s');
    expect(formatTook(40)).toBe('40 s');
    expect(formatTook(3725)).toBe('1 h 2 min');
    expect(formatTook(null)).toBe('—');
    expect(tookPercent(60)).toBe(50);
    expect(tookPercent(900)).toBe(100);
  });
});

describe('settings asked and used', () => {
  it('spells values in the unit people think in', () => {
    expect(formatOption('time_budget_ms', 60000)).toBe('60 s');
    expect(formatOption('time_budget_ms', 1500)).toBe('1,500 ms');
    expect(formatOption('iterations', 100000)).toBe('100,000');
  });

  it('shows what the plan reduced instead of hiding it', () => {
    const rows = optionRows({
      requestedOptions: { time_budget_ms: 600000, iterations: 100000 },
      options: { time_budget_ms: 60000, iterations: 100000 },
      warnings: [{ code: 'OPTION_CLAMPED', message: "'time_budget_ms' was reduced from 600000 to 60000 milliseconds, which is what this plan allows.", details: { option: 'time_budget_ms' } }],
    });
    expect(rows).toEqual([
      expect.objectContaining({ key: 'time_budget_ms', label: 'Time budget', asked: '600 s', used: '60 s', reduced: true }),
      expect.objectContaining({ key: 'iterations', asked: '100,000', used: '100,000', reduced: false, note: null }),
    ]);
    expect(rows[0].note).toContain('reduced from 600000');
    expect(optionRows(null)).toEqual([]);
  });
});

describe('provenance', () => {
  it('reads the pins of a run', () => {
    const pins = readPins({
      engine: { namespace: 'bim.builtin', name: 'random-search', version: '1.0.0', digest: 'sha256-a' },
      registration: { namespace: 'bim.builtin', name: 'random-search-deployment', version: '1', digest: 'sha256-r' },
      mode: 'sampling', irDigest: 'sha256-c', instanceDigest: 'sha256-i', evaluator: 'bim-reference-evaluator/v1',
      configuration: { name: 'rs-60s', version: '1' }, limits: { effectiveTimeoutSeconds: 60 },
    });
    expect(pins.engine).toMatchObject({ name: 'random-search', version: '1.0.0' });
    expect(pins).toMatchObject({ mode: 'sampling', compiledForm: 'sha256-c', instance: 'sha256-i', checkedBy: 'bim-reference-evaluator/v1', configuration: 'rs-60s@1' });
    expect(pins.limits).toEqual(['60 s per run']);
    expect(readPins(undefined).engine).toBeNull();
  });

});

describe('timeline', () => {
  it('has the steps a finished run went through', () => {
    const steps = timelineOf('failed', { created: '2026-10-07T15:00:00Z', finished: '2026-10-07T15:00:20Z' });
    expect(steps.map((step) => [step.label, step.state])).toEqual([['Queued', 'done'], ['Running', 'done'], ['Failed', 'bad']]);
  });

  it('does not claim a cancelled run ever ran when it ended within seconds', () => {
    const steps = timelineOf('cancelled', { created: '2026-10-06T12:00:00Z', finished: '2026-10-06T12:00:03Z' });
    expect(steps[1]).toMatchObject({ label: 'Running', when: 'never started', state: 'waiting' });
  });

  it('shows where a live run stands', () => {
    expect(timelineOf('queued', {}).map((step) => step.state)).toEqual(['current', 'waiting', 'waiting']);
    expect(timelineOf('running', {}).map((step) => step.state)).toEqual(['done', 'current', 'waiting']);
  });
});

describe('results', () => {
  const solution = {
    decision: { kind: 'binding', binding: { pay: { resource: 'catalog', id: 'payco-eu' } } },
    metrics: { cost: 0.118, label: 'x' as unknown as number },
    objectives: { score: [1.5, 2] },
  };

  it('reads the binding, the metrics and the score of a solution', () => {
    expect(bindingRows(solution)).toEqual([{ task: 'pay', resource: 'catalog', candidate: 'payco-eu' }]);
    expect(metricEntries(solution)).toEqual([['cost', 0.118]]);
    expect(scoreText(solution)).toBe('[1.5, 2]');
    expect(bindingRows(undefined)).toEqual([]);
  });
});

describe('limits forecast', () => {
  it('adds this run to what is used and says when it goes over', () => {
    expect(forecastBar('Jobs running at once', 1, 3, 1, '')).toMatchObject({ before: 33, over: false, text: '1 used + up to 1 = 2 of 3' });
    expect(forecastBar('Jobs running at once', 3, 3, 1, '')).toMatchObject({ over: true, text: '3 used + up to 1 = 4 of 3 · over the limit' });
    expect(forecastBar('Timeout', 610, 900, 60, ' s').text).toBe('610 used + up to 60 = 670 of 900 s');
  });

  it('says so when there is no limit or the usage cannot be read', () => {
    expect(forecastBar('Jobs', 1, null, 1, '').text).toBe('No limit on your plan');
    expect(forecastBar('Jobs', null, 3, 1, '').text).toBe('Your usage can’t be read right now · limit 3');
  });
});
