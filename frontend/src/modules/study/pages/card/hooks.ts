// The state of the study card page, split out of the page as the composition card page splits its own: the organization the
// address names (one of the account's), the study with its revision (`ETag`), read again on demand. Missing, another
// organization's and unreadable are one answer: the in-place 404.

import { useCallback, useEffect, useState } from 'react';
import { readApiError } from '../../../core/api/errors';
import type { Organization, OrgRole } from '../../../organization/api/organizationsApi';
import { useOrganization } from '../../../organization/hooks/useOrganization';
import { studyPath } from '../../../../routes/paths/studies';
import { studiesApi, type Study } from '../../api/studiesApi';

const RANK: Record<OrgRole, number> = { VIEWER: 1, MEMBER: 2, ADMIN: 3, OWNER: 4 };

/** What the account may do with the studies of an organization: MEMBER creates and runs, ADMIN deletes. */
export interface StudyAccess {
  role: OrgRole | null;
  canCreate: boolean;
  canAdminister: boolean;
}

export function studyAccess(role: OrgRole | null | undefined): StudyAccess {
  const rank = role ? RANK[role] : 0;
  return { role: role ?? null, canCreate: rank >= RANK.MEMBER, canAdminister: rank >= RANK.ADMIN };
}

/** Everything a part of the study page needs: the organization, what the account may do, and the study as last read. */
export interface StudyScopeValue {
  organization: Pick<Organization, 'slug' | 'name'>;
  access: StudyAccess;
  study: Study;
  /** The study's revision as the gateway gave it: what an edit sends as `If-Match`. */
  etag: string | null;
  /** `/studies/:org/:study`, the base of every tab's address. */
  studyPath: string;
  /** Read the study again after it changed. */
  reloadStudy: () => void;
}

export type StudyState =
  | { status: 'loading'; scope?: StudyScopeValue }
  | { status: 'ready'; scope: StudyScopeValue }
  | { status: 'missing' }
  | { status: 'error'; message: string };

/** The study `org/slug` of one of the account's organizations; `reload` reads it again and keeps the last one on show. */
export function useCardStudy(org: string, slug: string): { state: StudyState; reload: () => void } {
  const { organizations, isLoading } = useOrganization();
  const organization = organizations.find(item => item.slug === org) ?? null;
  const [read, setRead] = useState<
    | { status: 'loading'; value?: { study: Study; etag: string | null } }
    | { status: 'ready'; value: { study: Study; etag: string | null } }
    | { status: 'missing' }
    | { status: 'error'; message: string }
  >({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const known = organization !== null;

  useEffect(() => {
    if (!known) return;
    let active = true;
    studiesApi
      .get(org, slug)
      .then(answer => {
        if (active) setRead({ status: 'ready', value: { study: answer.value, etag: answer.etag } });
      })
      .catch(caught => {
        if (!active) return;
        const error = readApiError(caught);
        setRead(
          error.status === 404 || error.status === 403
            ? { status: 'missing' }
            : { status: 'error', message: error.message }
        );
      });
    return () => {
      active = false;
    };
  }, [org, slug, known, attempt]);

  const reload = useCallback(() => {
    setRead(current =>
      current.status === 'ready'
        ? { status: 'loading', value: current.value }
        : { status: 'loading' }
    );
    setAttempt(value => value + 1);
  }, []);

  if (!organization)
    return { state: isLoading ? { status: 'loading' } : { status: 'missing' }, reload };
  if (read.status === 'missing' || read.status === 'error') return { state: read, reload };
  const scopeOf = (value: { study: Study; etag: string | null }): StudyScopeValue => ({
    organization: { slug: organization.slug, name: organization.name },
    access: studyAccess(organization.effective_role),
    study: value.study,
    etag: value.etag,
    studyPath: studyPath(organization.slug, value.study.slug),
    reloadStudy: reload,
  });
  return {
    state:
      read.status === 'ready'
        ? { status: 'ready', scope: scopeOf(read.value) }
        : { status: 'loading', scope: read.value ? scopeOf(read.value) : undefined },
    reload,
  };
}
