import { describe, expect, it } from 'vitest';
import { isSponsorProposal, PricingUnavailableError, QuotaError, type SponsorProposal } from '../../api/auth';
import { HttpError } from '../../api/client';
import { canCancelProposal, closedText, expiryText, pendingOf, proposedName, proposerName, reasonText, sponsorRefusal } from './sponsorModel';

const proposal = (over: Partial<SponsorProposal> = {}): SponsorProposal => ({
  id: 'p1', organization_id: 'o1', organization_slug: 'isa', organization_name: 'ISA', proposed_user_id: 'u-pilar', proposed_username: 'pilar',
  proposed_by_user_id: 'u-lucia', proposed_by_username: 'lucia', status: 'pending', created_at: '2026-10-01T00:00:00Z', expires_at: '2026-10-15T00:00:00Z',
  decided_at: null, decided_by_user_id: null, decision_reason: null, ...over,
});

const refused = (status: number, code: string, problem?: unknown) => Object.assign(new HttpError(status, 'refused'), { code, problem });

describe('sponsor requests', () => {
  it('tells a request from an organization by its shape', () => {
    expect(isSponsorProposal(proposal())).toBe(true);
    expect(isSponsorProposal({ id: 'o1', slug: 'isa', name: 'ISA', billing_sponsor_user_id: 'u1', created_at: 'x' })).toBe(false);
    expect(isSponsorProposal(null)).toBe(false);
  });

  it('names the people involved, even when an account has gone', () => {
    expect(proposedName(proposal())).toBe('pilar');
    expect(proposedName(proposal({ proposed_username: null }))).toBe('Another account');
    expect(proposedName(proposal({ proposed_username: null, proposed_user_id: null }))).toBe('A removed account');
    expect(proposerName(proposal({ proposed_by_username: null }))).toBe('A removed account');
  });

  it('says when it expires, or expired, and how a closed one ended', () => {
    const now = Date.parse('2026-10-10T00:00:00Z');
    expect(expiryText(proposal(), now)).toBe('Expires Oct 15, 2026');
    expect(expiryText(proposal({ expires_at: '2026-10-05T00:00:00Z' }), now)).toBe('Expired Oct 5, 2026');
    expect(expiryText(proposal({ status: 'expired' }), now)).toBe('Expired Oct 15, 2026');
    expect(closedText(proposal({ status: 'accepted', decided_at: '2026-10-03T10:00:00Z' }))).toBe('Accepted Oct 3, 2026');
    expect(closedText(proposal({ status: 'expired' }))).toBe('Expired Oct 15, 2026');
    expect(closedText(proposal({ status: 'cancelled' }))).toBe('Cancelled');
  });

  it('words why the system closed one', () => {
    expect(reasonText('replaced')).toBe('Replaced by a newer request');
    expect(reasonText('sponsor_changed')).toBe('The sponsor was changed directly');
    expect(reasonText('something_new')).toBe('something new');
    expect(reasonText(null)).toBeNull();
  });

  it('finds the one that waits, and who may withdraw it', () => {
    const waiting = proposal();
    expect(pendingOf([proposal({ status: 'declined' }), waiting])).toBe(waiting);
    expect(pendingOf([])).toBeUndefined();
    expect(pendingOf(null)).toBeUndefined();
    expect(canCancelProposal(waiting, { userId: 'u-lucia', owner: false, platformAdmin: false })).toBe(true);
    expect(canCancelProposal(waiting, { userId: 'u-other', owner: true, platformAdmin: false })).toBe(true);
    expect(canCancelProposal(waiting, { userId: 'u-other', owner: false, platformAdmin: true })).toBe(true);
    expect(canCancelProposal(waiting, { userId: 'u-other', owner: false, platformAdmin: false })).toBe(false);
    expect(canCancelProposal(proposal({ status: 'accepted' }), { userId: 'u-lucia', owner: true, platformAdmin: true })).toBe(false);
  });
});

describe('sponsorRefusal', () => {
  it('shows the limit that was passed, and keeps the request open when it is the proposed person who is short', () => {
    const quota = new QuotaError('sponsor_quota_exceeded', 'full', { limit_id: 'members', limit: 15, used: 18 });
    expect(sponsorRefusal(quota, 'propose').text).toBe('The new sponsor’s plan has no room for this organization and everything under it (402 · sponsor_quota_exceeded). members: 18 of 15 used. Nothing changed.');
    expect(sponsorRefusal(quota, 'accept').text).toContain('members: 18 of 15 used. The request is still waiting');
  });

  it('marks a pricing outage as worth retrying', () => {
    const outage = sponsorRefusal(new PricingUnavailableError('down'), 'accept');
    expect(outage.retry).toBe(true);
    expect(outage.text).toBe('Limits can’t be checked right now (503 · pricing_unavailable). Nothing changed; the request is still waiting. Try again in a moment.');
    expect(sponsorRefusal(new PricingUnavailableError('down'), 'propose').text).not.toContain('still waiting');
  });

  it('tells apart the 409s and gives the id of the request that is already waiting', () => {
    expect(sponsorRefusal(refused(409, 'sponsor_proposal_expired'), 'accept').text).toContain('This request expired (409 · sponsor_proposal_expired)');
    expect(sponsorRefusal(refused(409, 'sponsor_proposal_not_pending', { detail: { status: 'declined' } }), 'accept').text).toContain('was already declined');
    expect(sponsorRefusal(refused(409, 'sponsor_proposal_not_pending'), 'accept').text).toContain('was already answered');
    const pending = sponsorRefusal(refused(409, 'sponsor_proposal_pending', { detail: { proposal_id: 'prop-9' } }), 'propose');
    expect(pending).toMatchObject({ code: 'sponsor_proposal_pending', pendingId: 'prop-9' });
    expect(sponsorRefusal(refused(409, 'already_sponsor'), 'propose').text).toBe('That account is already the sponsor (409 · already_sponsor).');
  });

  it('words the 403, 404 and 422 refusals', () => {
    expect(sponsorRefusal(refused(403, 'sponsor_proposal_forbidden'), 'accept').text).toContain('Only the person the request names can answer it');
    expect(sponsorRefusal(refused(403, 'sponsor_proposal_forbidden'), 'cancel').text).toContain('Only whoever sent the request, an owner');
    expect(sponsorRefusal(refused(404, 'not_found'), 'accept').text).toContain('doesn’t exist any more');
    expect(sponsorRefusal(refused(422, 'invalid_sponsor'), 'propose').text).toBe('That account can’t be a sponsor (422 · invalid_sponsor): sponsors must be active accounts.');
  });

  it('says nothing changed for anything else', () => {
    expect(sponsorRefusal(new TypeError('Failed to fetch'), 'propose')).toMatchObject({ retry: true });
    expect(sponsorRefusal(refused(500, 'boom'), 'decline').retry).toBe(true);
    expect(sponsorRefusal(refused(418, 'teapot'), 'decline').text).toBe('That couldn’t be done (418 · teapot). Nothing changed.');
  });
});
