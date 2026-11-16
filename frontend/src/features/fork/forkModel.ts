// The rules of the fork dialog, without the DOM: which organizations a fork may go to, the steps a version needs, the name a taken
// one suggests and what each refusal of the gateway says.

import type { Organization } from '../../api/platform';
import type { ApiError } from '../../shared/api/errors';
import type { CompositionFork, CompositionVersionView } from '../../shared/api/types';
import { SLUG_PATTERN } from '../../shared/lib/slug';

export type ForkStep = 'target' | 'problem' | 'name';

/** Why the source's own organization is not offered. */
export const SAME_ORGANIZATION =
  'Forks go to another organization; to change this composition, create a new version';
/** Why an organization where the account is below MEMBER is not offered. */
export const NEEDS_MEMBER = 'needs member access';

const SLUG_MAX = 64;
export const NAME_MAX = 160;
const FORK_SUFFIX = '-fork';

const ROLE_RANK: Record<NonNullable<Organization['effective_role']>, number> = {
  VIEWER: 0,
  MEMBER: 1,
  ADMIN: 2,
  OWNER: 3,
};

/** Why a fork of a composition of `sourceOrg` cannot go to `organization`, or null when it can. */
export function targetReason(organization: Organization, sourceOrg: string): string | null {
  if (organization.slug === sourceOrg) return SAME_ORGANIZATION;
  const role = organization.effective_role;
  if (role === null || ROLE_RANK[role] < ROLE_RANK.MEMBER) return NEEDS_MEMBER;
  return null;
}

/** Whether a version links a problem, which a fork cannot keep: the fork then needs `dropProblem`, said on purpose. */
export const linksProblem = (version: Pick<CompositionVersionView, 'problem'>): boolean =>
  version.problem !== null;

/** The steps of a fork before it is sent: the target, then (for a linked version) dropping the problem. */
export const stepsOf = (linked: boolean): ForkStep[] =>
  linked ? ['target', 'problem'] : ['target'];

/** What a taken slug suggests instead: `<slug>-fork` and `<name> (fork)`, within the gateway's lengths. */
export function forkSuggestion(source: { slug: string; name: string }): {
  slug: string;
  name: string;
} {
  const base = source.slug.slice(0, SLUG_MAX - FORK_SUFFIX.length).replace(/-+$/g, '');
  const suffix = ' (fork)';
  return {
    slug: `${base}${FORK_SUFFIX}`,
    name: `${source.name.slice(0, NAME_MAX - suffix.length).trimEnd()}${suffix}`,
  };
}

/** What is wrong with the name a fork is given, or null: it may not be the name already there (any case). */
export function nameProblem(name: string, taken: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Give the fork a name.';
  if (trimmed.toLowerCase() === taken.trim().toLowerCase())
    return 'That is the name of the composition already there. Choose a different one.';
  if (trimmed.length > NAME_MAX) return `At most ${NAME_MAX} characters.`;
  return null;
}

/** What is wrong with the address a fork is given, or null: a slug, and not the one already taken. */
export function slugProblem(slug: string, taken: string, target: string): string | null {
  if (!SLUG_PATTERN.test(slug)) return 'Lowercase letters, numbers and hyphens.';
  if (slug === taken) return `${slug} is in use in ${target}. Choose another address.`;
  return null;
}

/** The request of a fork of `version` into `target`: `dropProblem` only for a linked version, and the new name only when given. */
export function forkRequest(
  version: Pick<CompositionVersionView, 'id' | 'problem'>,
  target: string,
  rename?: { slug: string; name: string }
): CompositionFork {
  return {
    version: version.id,
    targetOrganization: target,
    dropProblem: linksProblem(version),
    ...(rename ? { slug: rename.slug, name: rename.name.trim() } : {}),
  };
}

/** A refusal of the gateway, in words, with the field it belongs to and the findings a 422 carries. */
export interface ForkRefusal {
  message: string;
  field?: 'slug';
  findings: ApiError['diagnostics'];
}

/** What a refusal of a fork into `target` (its name) says; `slug` is the address that was asked for. */
export function forkRefusal(error: ApiError, target: string, slug: string): ForkRefusal {
  const code = error.status
    ? ` (${error.status}${error.code !== 'unknown' ? ` · ${error.code}` : ''})`
    : '';
  const plain = (message: string): ForkRefusal => ({ message, findings: [] });
  switch (error.code) {
    case 'api_key_boundary':
      return plain(`This API key does not reach ${target}${code}, so nothing was forked.`);
    case 'feature_not_entitled':
      return plain(
        `Your plan does not include the composition repository${code}, so nothing was forked.`
      );
    case 'organization_forbidden':
      return plain(`Forking into ${target} needs MEMBER there${code}.`);
    case 'composition_fork_same_organization':
      return plain(
        `A fork goes to another organization${code}. To change this composition, create a new version of it instead.`
      );
    case 'composition_fork_problem_unreadable':
      return plain(
        `This version links a problem, which ${target} cannot read${code}. Confirm that the fork drops it, and fork again.`
      );
    case 'slug_conflict':
      return {
        message: `${slug} is in use in ${target}${code}. Choose another address.`,
        field: 'slug',
        findings: [],
      };
    default:
      break;
  }
  if (error.status === 404)
    return plain(
      `This composition or version is not there any more, or you can no longer read it${code}.`
    );
  if (error.status === 422)
    return {
      message: `The forked document has errors${code}. The gateway found:`,
      findings: error.diagnostics,
    };
  if (error.status === 429) {
    const wait = error.retryAfter
      ? ` Try again in ${error.retryAfter} s.`
      : ' Try again in a moment.';
    return plain(`The gateway is busy${code}.${wait}`);
  }
  return {
    message: `The composition couldn’t be forked${code}${error.message ? `: ${error.message}` : '.'}`,
    findings: error.diagnostics,
  };
}
