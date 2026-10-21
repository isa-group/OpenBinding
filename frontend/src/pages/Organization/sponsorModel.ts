import type { SponsorProposal, SponsorProposalStatus } from '../../api/auth';
import { problemField } from '../../api/problem';
import { formatDate } from '../../utils/format';
import { classifyAuthError, marker, quotaOf } from './orgErrors';

/** How a request reads in a list and on a card. */
export const PROPOSAL_STATUS: Record<SponsorProposalStatus, { label: string; tone: 'plain' | 'success' | 'warning' }> = {
  pending: { label: 'Pending', tone: 'warning' },
  accepted: { label: 'Accepted', tone: 'success' },
  declined: { label: 'Declined', tone: 'plain' },
  cancelled: { label: 'Cancelled', tone: 'plain' },
  expired: { label: 'Expired', tone: 'plain' },
};

/** Why the system closed a request, in words (`decision_reason`). */
const REASONS: Record<string, string> = {
  expired: 'Nobody answered in time',
  replaced: 'Replaced by a newer request',
  sponsor_changed: 'The sponsor was changed directly',
  user_deactivated: 'An account involved was deactivated',
  user_deleted: 'An account involved was deleted',
};

export function reasonText(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return REASONS[reason] ?? reason.replace(/_/g, ' ');
}

/** The person a request names, as the screens write it. */
export function proposedName(proposal: Pick<SponsorProposal, 'proposed_username' | 'proposed_user_id'>): string {
  return proposal.proposed_username ?? (proposal.proposed_user_id ? 'Another account' : 'A removed account');
}

export function proposerName(proposal: Pick<SponsorProposal, 'proposed_by_username'>): string {
  return proposal.proposed_by_username ?? 'A removed account';
}

/** “Expires Oct 24, 2026”, or “Expired Oct 24, 2026” once the date has passed. */
export function expiryText(proposal: Pick<SponsorProposal, 'expires_at' | 'status'>, now = Date.now()): string {
  const when = formatDate(proposal.expires_at) ?? 'soon';
  return proposal.status === 'expired' || Date.parse(proposal.expires_at) < now ? `Expired ${when}` : `Expires ${when}`;
}

/** What happened to a request that is no longer pending, and when: “Accepted Oct 12, 2026”. */
export function closedText(proposal: Pick<SponsorProposal, 'status' | 'decided_at' | 'expires_at'>): string {
  const label = PROPOSAL_STATUS[proposal.status].label;
  const when = formatDate(proposal.decided_at ?? (proposal.status === 'expired' ? proposal.expires_at : null));
  return when ? `${label} ${when}` : label;
}

/** The pending request among a list, if any: an organization has at most one. */
export function pendingOf(proposals: readonly SponsorProposal[] | null | undefined): SponsorProposal | undefined {
  return proposals?.find((proposal) => proposal.status === 'pending');
}

/** Can this person withdraw a request? Its sender, an OWNER of the organization or a platform administrator; an ADMIN may only look. */
export function canCancelProposal(proposal: SponsorProposal, who: { userId?: string; owner: boolean; platformAdmin: boolean }): boolean {
  return proposal.status === 'pending' && (who.owner || who.platformAdmin || (Boolean(who.userId) && proposal.proposed_by_user_id === who.userId));
}

export type SponsorAction = 'propose' | 'accept' | 'decline' | 'cancel';

export interface SponsorRefusal {
  /** What the gateway said, by code. */
  code: string | undefined;
  text: string;
  /** Trying again later can work (limits couldn't be read; nothing changed and the request, if any, is still waiting). */
  retry: boolean;
  /** `sponsor_proposal_pending`: the request that is already waiting, to replace or cancel. */
  pendingId?: string;
}

function limitText(caught: unknown): string {
  const quota = quotaOf(caught);
  return quota ? ` ${quota.limit_id}: ${quota.used ?? '?'} of ${quota.limit} used.` : '';
}

/** The words for each way the gateway can refuse naming a sponsor or answering a request. */
export function sponsorRefusal(caught: unknown, action: SponsorAction): SponsorRefusal {
  const failure = classifyAuthError(caught);
  const code = failure.code;
  const mark = marker(failure);
  switch (code) {
    case 'sponsor_quota_exceeded':
      return {
        code, retry: false,
        text: action === 'accept'
          ? `Your plan can’t take this organization and everything under it${mark}.${limitText(caught)} The request is still waiting: raise your plan, then accept again.`
          : `The new sponsor’s plan has no room for this organization and everything under it${mark}.${limitText(caught)} Nothing changed.`,
      };
    case 'pricing_unavailable':
      return { code, retry: true, text: `Limits can’t be checked right now${mark}. Nothing changed${action === 'accept' ? '; the request is still waiting' : ''}. Try again in a moment.` };
    case 'sponsor_proposal_expired':
      return { code, retry: false, text: `This request expired${mark}. It can no longer be accepted; ask the owner to send a new one.` };
    case 'sponsor_proposal_not_pending': {
      const status = problemField(caught, 'status');
      return { code, retry: false, text: `This request was already ${typeof status === 'string' ? status : 'answered'}${mark}. Reload to see its current state.` };
    }
    case 'sponsor_proposal_pending': {
      const id = problemField(caught, 'proposal_id');
      return { code, retry: false, pendingId: typeof id === 'string' ? id : undefined, text: `A sponsor request is already waiting for an answer${mark}.` };
    }
    case 'already_sponsor':
      return { code, retry: false, text: `That account is already the sponsor${mark}.` };
    case 'invalid_sponsor':
      return { code, retry: false, text: `That account can’t be a sponsor${mark}: sponsors must be active accounts.` };
    case 'sponsor_proposal_forbidden':
      return {
        code, retry: false,
        text: action === 'cancel'
          ? `Only whoever sent the request, an owner of the organization or a platform administrator can cancel it${mark}.`
          : `Only the person the request names can answer it${mark}.`,
      };
    default:
      if (failure.status === 404) return { code, retry: false, text: `This request doesn’t exist any more, or it isn’t yours to see${mark}. Reload the page.` };
      if (failure.kind === 'unavailable') return { code, retry: true, text: `A service OpenBinding depends on isn’t answering${mark}. Nothing changed. Try again in a moment.` };
      if (failure.kind === 'network') return { code, retry: true, text: 'OpenBinding couldn’t be reached. Nothing changed. Check your connection and try again.' };
      if (failure.kind === 'rejected') return { code, retry: false, text: `Your session has ended${mark}. Log in again to continue.` };
      return { code, retry: false, text: `That couldn’t be done${mark}. Nothing changed.` };
  }
}
