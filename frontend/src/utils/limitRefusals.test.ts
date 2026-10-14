import { describe, expect, it } from 'vitest';
import { QuotaError } from '../api/auth';
import { HttpError } from '../api/client';
import { bindingSpaceFrom, limitNoticeFrom } from '../api/limitNotice';
import { combinations, complexityText, limitProblemOf, sizeOf, slotsText, usageUnknownText } from './limitRefusals';

describe('reading what a refusal says about its limit', () => {
  it('keeps the fields the screens show and nothing else', () => {
    expect(limitNoticeFrom({ limit_id: 'x', state: 'exhausted', source: 'plan', unit: 'job', limit: 2, used: 2, path: '/srv', host: 'h' })).toEqual({
      limit_id: 'x', state: 'exhausted', source: 'plan', unit: 'job', limit: 2, used: 2,
    });
    expect(bindingSpaceFrom({ kind: 'estimate', log10: 3, digits: 4, cardinality: '1000', path: '/srv' })).toEqual({ log10: 3, digits: 4, cardinality: '1000' });
  });

  it('reads an absent state as exhausted (the old 402) and a state it does not know as unknown', () => {
    expect(limitNoticeFrom({ limit_id: 'apiKeys', limit: 1 })?.state).toBe('exhausted');
    expect(limitNoticeFrom({ limit_id: 'apiKeys', state: 'new-thing' })?.state).toBe('unknown');
  });

  it.each([undefined, null, 'text', 4, [], {}, { limit_id: '' }, { limit_id: 3 }])('has no notice in %j', (raw) => {
    expect(limitNoticeFrom(raw)).toBeUndefined();
  });

  it.each([undefined, null, 'text', [], {}, { cardinality: 'abc', digits: 'x' }, { cardinality: '1'.repeat(41) }])('has no measure in %j', (raw) => {
    expect(bindingSpaceFrom(raw)).toBeUndefined();
  });
});

describe('the size of a problem in words', () => {
  it('writes a whole power of ten with its superscript and any other with a caret', () => {
    expect(combinations(9)).toBe('10⁹');
    expect(combinations(12.5)).toBe('10^12.5');
    expect(combinations(0.30103)).toBe('10^0.3');
  });

  it('prefers the exact count, then the log10, then only the digits', () => {
    expect(sizeOf({ cardinality: '1234567', log10: 6.09 })).toBe('1,234,567 combinations');
    expect(sizeOf({ log10: 6.09 })).toBe('about 10^6.1 combinations');
    expect(sizeOf({ digits: 4321 })).toBe('a number of combinations with 4,321 digits');
    expect(sizeOf(undefined, { limit_id: 'x', state: 'exhausted', used: 3 })).toBe('about 10³ combinations');
    expect(sizeOf(undefined, { limit_id: 'x', state: 'unknown', used: 3 })).toBeNull();
    expect(sizeOf()).toBeNull();
  });
});

describe('the sentences about a limit', () => {
  it('only the four limit problems are recognised, by code', () => {
    const at = ' (403 · x)';
    const codes = ['binding_space_limit_unknown', 'binding_space_over_technical_limit', 'binding_space_unmeasured', 'pricing_misconfigured'];
    expect(codes.map((code) => limitProblemOf(Object.assign(new HttpError(403, 'x'), { code }), 'N.', at)?.kind)).toEqual(['limit-unknown', 'technical', 'unmeasured', 'misconfigured']);
    for (const code of ['instance_complexity_too_large', 'feature_not_entitled', 'forbidden', undefined]) {
      expect(limitProblemOf(Object.assign(new HttpError(403, 'x'), { code }), 'N.', at)).toBeNull();
    }
    expect(limitProblemOf(new Error('x'), 'N.', at)).toBeNull();
    expect(limitProblemOf(new QuotaError('quota_exceeded', 'x'), 'N.', at)).toBeNull();
  });

  it('puts the marker of the answer in the title and what was left undone at the end of the text', () => {
    const problem = limitProblemOf(Object.assign(new HttpError(403, 'x'), { code: 'binding_space_limit_unknown' }), 'Nothing was started.', ' (403 · binding_space_limit_unknown)');
    expect(problem?.title.endsWith('(403 · binding_space_limit_unknown)')).toBe(true);
    expect(problem?.text.endsWith('Nothing was started.')).toBe(true);
  });

  it('says whose limit a job limit is', () => {
    expect(slotsText()).toBe('You have no free job slot.');
    expect(slotsText({ limit: 1 })).toBe('You can run 1 job at once.');
    expect(slotsText({ limit: 1, source: 'plan' })).toBe('Your plan lets you run 1 job at once.');
    expect(slotsText({ limit: 3, source: 'technical' })).toBe('This deployment lets one account run 3 jobs at once, whatever its plan.');
  });

  it('never talks about money, a balance or capacity units', () => {
    const texts = [
      complexityText(new QuotaError('instance_complexity_too_large', 'x'), 'N.'),
      usageUnknownText('N.'),
      slotsText({ limit: 1, source: 'plan' }),
      slotsText({ limit: 1, source: 'technical' }),
    ];
    for (const text of texts) expect(text).not.toMatch(/credit|balance|capacity unit|\bCUs?\b|\bpay\b|\bprice\b/i);
  });
});
