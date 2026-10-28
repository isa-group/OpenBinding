import { describe, expect, it } from 'vitest';
import { PricingUnavailableError, QuotaError } from '../../api/auth';
import { HttpError } from '../../api/client';
import { sponsorRefusal } from './sponsorModel';

const refused = (status: number, code: string, problem?: unknown) => Object.assign(new HttpError(status, 'refused'), { code, problem });

describe('sponsorRefusal', () => {
  it('shows the limit that was passed', () => {
    const quota = new QuotaError('sponsor_quota_exceeded', 'full', { limit_id: 'members', limit: 15, used: 18 });
    expect(sponsorRefusal(quota)).toBe('The new sponsor’s plan has no room for this organization and everything under it (402 · sponsor_quota_exceeded). members: 18 of 15 used. Nothing changed.');
  });

  it('words a pricing outage', () => {
    expect(sponsorRefusal(new PricingUnavailableError('down'))).toBe('Limits can’t be checked right now (503 · pricing_unavailable). Nothing changed. Try again in a moment.');
  });

  it('words the 422 refusals, naming somebody else included', () => {
    expect(sponsorRefusal(refused(422, 'sponsor_must_be_caller'))).toBe('Only you can make yourself the sponsor (422 · sponsor_must_be_caller). Nothing changed.');
    expect(sponsorRefusal(refused(422, 'invalid_sponsor'))).toBe('That account can’t be a sponsor (422 · invalid_sponsor): sponsors must be active accounts.');
  });

  it('says nothing changed for anything else', () => {
    expect(sponsorRefusal(new TypeError('Failed to fetch'))).toContain('Nothing changed');
    expect(sponsorRefusal(refused(500, 'boom'))).toContain('Try again in a moment');
    expect(sponsorRefusal(refused(418, 'teapot'))).toBe('That couldn’t be done (418 · teapot). Nothing changed.');
  });
});
