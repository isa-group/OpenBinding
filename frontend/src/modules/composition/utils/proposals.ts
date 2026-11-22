// The words around a proposal (F6) on the composition screens: a step's base, where a done step's result opens, and why a
// confirmation or a cancellation was refused. The proposal card (core) draws; this says what the composition module knows
// (its versions' labels and its environments' names). Nothing here decides: the gateway checked every base already.

import { HttpError } from '../../core/api/http';
import { readApiError } from '../../core/api/errors';
import type { ProposalStepView } from '../../core/api/types';
import type { StepLink } from '../../core/components/proposal-card';
import { compositionPath } from '../../../routes/paths/compositions';

/** What the composition module knows to name a proposal's steps: labels by version id, environments by id. */
export interface ProposalContext {
  org: string;
  composition: string;
  versionLabel?: (id: string) => string | null;
  environments?: ReadonlyArray<{ id: string; slug: string; name: string }>;
}

const environmentOf = (context: ProposalContext, id: unknown) =>
  typeof id === 'string' ? context.environments?.find(item => item.id === id) : undefined;

const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

/** A step's base in words: what it was built on, which the gateway checks again at confirmation. */
export function describeBase(context: ProposalContext, step: ProposalStepView): string | null {
  const base = step.base as Record<string, unknown>;
  if (step.kind === 'adopt') {
    const environment = environmentOf(context, step.params.environment);
    const inEffect = text(base.inEffect);
    const label = inEffect ? (context.versionLabel?.(inEffect) ?? null) : null;
    return `${environment?.name ?? 'The environment'} as it was when proposed, ${
      inEffect ? `with ${label ?? 'its version'} in effect` : 'with nothing in effect'
    }.`;
  }
  if (step.kind === 'seal_derived') {
    const head = text(base.headVersionId);
    const label = head ? (context.versionLabel?.(head) ?? null) : null;
    return `Built on ${label ? `${label} as the latest version` : 'the latest version as it was'}, and on the exact document shown.`;
  }
  return null;
}

/** Where a done step's result opens: the sealed version compared in Versions, the environment adopted in. */
export function resultLink(
  context: ProposalContext,
  step: ProposalStepView,
  against: string | null
): StepLink | null {
  const result = (step.result ?? {}) as Record<string, unknown>;
  if (step.kind === 'seal_derived') {
    const version = result.version as { label?: string } | undefined;
    if (!version?.label) return null;
    return {
      label: `Compare ${version.label} in Versions`,
      to: compositionPath(context.org, context.composition, 'versions', {
        ...(against ? { from: against } : {}),
        to: version.label,
      }),
    };
  }
  if (step.kind === 'adopt') {
    const slug = text(result.environment) ?? environmentOf(context, step.params.environment)?.slug;
    if (!slug) return null;
    const ordinal = typeof result.ordinal === 'number' ? ` (adoption #${result.ordinal})` : '';
    return {
      label: `Open ${slug}${ordinal}`,
      to: compositionPath(context.org, context.composition, 'operation', { environment: slug }),
    };
  }
  return null;
}

/** Why a proposal went out of date, from a 409 `proposal_stale`'s `stale` reasons. */
const STALE: Record<string, (environment: string) => string> = {
  environment_changed: environment => `${environment} changed`,
  environment_missing: environment => `${environment} was deleted`,
  head_version_changed: () => 'a newer version of the composition was sealed',
  derivation_changed: () => 'the document it would seal is no longer the one shown',
  run_unreadable: () => 'the run it derives from can no longer be read',
  version_missing: () => 'the version it adopts no longer exists',
  composition_archived: () => 'the composition was archived',
};

export interface ProposalRefusal {
  text: string;
  /** The proposal changed (out of date, no longer pending): read it again. */
  reread: boolean;
}

/** A refused confirmation or cancellation, in words. */
export function proposalRefusal(
  caught: unknown,
  context: ProposalContext,
  steps: ProposalStepView[] = []
): ProposalRefusal {
  const error = readApiError(caught);
  if (error.code === 'proposal_stale') {
    const problem = caught instanceof HttpError ? (caught.problem as Record<string, unknown>) : {};
    const detail = (problem?.detail ?? {}) as { stale?: Array<{ step: number; reason: string }> };
    const reasons = (detail.stale ?? []).map(item => {
      const step =
        steps.find(candidate => candidate.ordinal === item.step && candidate.kind === 'adopt') ??
        steps.find(candidate => candidate.kind === 'adopt');
      const environment =
        environmentOf(context, step?.params.environment)?.slug ?? 'the environment';
      return STALE[item.reason]?.(environment) ?? item.reason;
    });
    const what = reasons.length > 0 ? reasons.join(' and ') : 'what it was built on changed';
    return {
      text: `This proposal is out of date: ${what} since it was made. Nothing was changed.`,
      reread: true,
    };
  }
  if (error.code === 'composition_busy')
    return {
      text: 'The composition is busy with another change. Nothing was changed, and the proposal still waits: try again in a moment.',
      reread: false,
    };
  if (error.code === 'proposal_not_yours')
    return {
      text: 'Only the person who made this proposal can confirm or cancel it.',
      reread: false,
    };
  if (error.code === 'proposal_not_pending')
    return { text: 'This proposal is no longer waiting for confirmation.', reread: true };
  if (error.code === 'confirmation_required' || error.code === 'confirmation_mismatch')
    return { text: 'Type the phrase exactly as shown to confirm.', reread: false };
  if (error.status === 404) return { text: 'This proposal no longer exists.', reread: true };
  return {
    text: error.message || 'The proposal couldn’t be confirmed. Nothing was changed.',
    reread: false,
  };
}
