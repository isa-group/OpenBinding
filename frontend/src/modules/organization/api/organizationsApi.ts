// Adapted from SPHERE frontend/src/modules/organization/api/organizationsApi.ts (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's gateway routes and generated types instead of SPHERE's `/orgs` API; refusals throw the typed error
// `readApiError` reads (SPHERE's `extractErrorMessage` is gone); organizations are named by slug; members carry VIEWER; the
// owner is transferred with `PUT …/owner`; the entity permissions and service trees are not ported.

import { useCallback, useMemo } from 'react';
import { config } from '../../../config';
import { readResponse } from '../../core/api/http';
import type { components } from '../../core/api/openapi';
import { useAuth } from '../../auth/hooks/useAuth';

type Schemas = components['schemas'];

export type OrgRole = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';

export type OrganizationAvatar = Schemas['OrganizationAvatar'];
export type OrganizationStats = Schemas['OrganizationStats'];
export type OrganizationRef = Schemas['OrganizationRef'];

/** One organization as the gateway shows it to a member: with `tree=true`, nested in `children`. */
export type Organization = Omit<Schemas['OrganizationView'], 'effective_role' | 'children'> & {
  effective_role: OrgRole | null;
  children?: Organization[] | null;
};

/** What anybody may read of an organization that publishes (and its members always). */
export type PublicOrganization = Schemas['PublicOrganizationView'];
export type PublicOrganizationsResponse = Schemas['PublicOrganizationList'];
/** One organization of a branch, flat, with whether the viewer may open it. */
export type OrgHierarchyNode = Omit<Schemas['HierarchyNode'], 'effective_role'> & {
  effective_role?: OrgRole | null;
};
export type OrgMember = Omit<Schemas['MemberView'], 'role'> & { role: OrgRole };
export type OrganizationInvitation = Schemas['CodeInvitationView'];
export type InvitationPreview = Schemas['InvitationPreview'];
export type UserRef = Schemas['UserRef'];

/** One staged change of the member batch: a `null` role removes the direct membership. */
export interface MemberChange {
  user_id: string;
  role: OrgRole | null;
}

/** The most changes one batch may carry (`MemberBatchUpdate.maxItems`). */
export const MEMBER_BATCH_LIMIT = 100;

/** One row of the organization audit log, as `GET …/audit` sends it. */
export interface OrganizationAuditEvent {
  id: string;
  organizationId: string | null;
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface OrganizationAuditPage {
  events: OrganizationAuditEvent[];
  total: number;
  offset: number;
  limit: number;
}

const enc = encodeURIComponent;
export const ORGS_BASE_PATH = '/v1/organizations';
const root = (org: string) => `${ORGS_BASE_PATH}/${enc(org)}`;

function query(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(name, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

/** The props `OrgAvatar` takes, from the gateway's avatar. */
export function avatarProps(avatar: OrganizationAvatar | null | undefined): {
  avatar: string | null;
  avatarBgColor?: string;
  avatarFgColor?: string;
} {
  return {
    avatar: avatar?.url ?? null,
    avatarBgColor: avatar?.bg_color ?? undefined,
    avatarFgColor: avatar?.fg_color ?? undefined,
  };
}

/** The organizations of a tree, depth first, each once. */
export function flattenOrganizations(orgs: readonly Organization[]): Organization[] {
  return orgs.reduce<Organization[]>((acc, org) => {
    acc.push(org);
    if (org.children?.length) acc.push(...flattenOrganizations(org.children));
    return acc;
  }, []);
}

/**
 * The root organizations that publish at least one composition (`GET /v1/organizations/public`). Anybody may read them, so it
 * goes out without the session, as SPHERE's does.
 */
export async function getPublicOrganizations(
  params: { q?: string; limit?: number; offset?: number } = {},
  signal?: AbortSignal
): Promise<PublicOrganizationsResponse> {
  // `no-cache` makes the browser revalidate, so a changed avatar shows up without a hard reload.
  const response = await fetch(`${config.apiBaseUrl}${ORGS_BASE_PATH}/public${query(params)}`, {
    signal,
    cache: 'no-cache',
  });
  return readResponse<PublicOrganizationsResponse>(response);
}

export function useOrganizationsApi() {
  const { fetchWithInterceptor } = useAuth();

  const call = useCallback(
    async <T>(path: string, init?: RequestInit): Promise<T> =>
      readResponse<T>(await fetchWithInterceptor(path, init)),
    [fetchWithInterceptor]
  );
  const send = useCallback(
    <T>(path: string, method: string, body?: unknown, headers?: HeadersInit): Promise<T> =>
      call<T>(path, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    [call]
  );

  /** The caller's organizations as a tree (`tree=true`): the top-level nodes, each with its `children` and `role_source`. */
  const getMyOrganizations = useCallback(
    () => call<Organization[]>(`${ORGS_BASE_PATH}${query({ tree: true })}`),
    [call]
  );

  /** One organization, for a member (with its stats); 403 or 404 otherwise. */
  const getOrganization = useCallback((org: string) => call<Organization>(root(org)), [call]);

  /** What anybody reads of an organization that publishes, and its members always; 404 otherwise. */
  const getOrganizationProfile = useCallback(
    (org: string) => call<PublicOrganization>(`${root(org)}/profile`),
    [call]
  );

  /** The whole branch of an organization, flat, with `has_access` (members only). */
  const getHierarchy = useCallback(
    (org: string) => call<OrgHierarchyNode[]>(`${root(org)}/hierarchy`),
    [call]
  );

  /** The slug is derived from the name when left out, with a suffix when it is taken (SPHERE's `deduplicateSlug`). */
  const createOrganization = useCallback(
    (payload: { name: string; slug?: string; description?: string; parent_id?: string | null }) =>
      send<Organization>(ORGS_BASE_PATH, 'POST', payload),
    [send]
  );

  /** ADMIN renames or describes it; the slug never changes. */
  const updateOrganization = useCallback(
    (org: string, payload: { name?: string; description?: string | null }) =>
      send<Organization>(root(org), 'PATCH', payload),
    [send]
  );

  /** Re-parents an organization (null: to the root). OWNER of both ends; `organization_cycle` when it would land inside itself. */
  const moveOrganization = useCallback(
    (org: string, parentId: string | null) =>
      send<Organization>(
        root(org),
        'PATCH',
        parentId ? { parent_id: parentId } : { move_to_root: true }
      ),
    [send]
  );

  const deleteOrganization = useCallback((org: string) => send<void>(root(org), 'DELETE'), [send]);

  const getMembers = useCallback(
    (org: string) => call<OrgMember[]>(`${root(org)}/members`),
    [call]
  );

  /** Up to {@link MEMBER_BATCH_LIMIT} staged changes, applied together or not at all; answers the whole member list. */
  const updateMembersBatch = useCallback(
    (org: string, changes: MemberChange[]) =>
      send<OrgMember[]>(`${root(org)}/members/batch`, 'POST', { changes }),
    [send]
  );

  /** Adds a person, or changes their direct role. */
  const upsertMember = useCallback(
    (org: string, userId: string, role: OrgRole) =>
      send<OrgMember>(`${root(org)}/members/${enc(userId)}`, 'PUT', { user_id: userId, role }),
    [send]
  );

  const removeMember = useCallback(
    (org: string, userId: string) => send<void>(`${root(org)}/members/${enc(userId)}`, 'DELETE'),
    [send]
  );

  /** SPHERE's branch-wide swap: the previous owner becomes ADMIN. The recipient is already a member. */
  const transferOwnership = useCallback(
    (org: string, userId: string) =>
      send<OrgMember[]>(`${root(org)}/owner`, 'PUT', { user_id: userId }),
    [send]
  );

  const getInvitations = useCallback(
    (org: string) => call<OrganizationInvitation[]>(`${root(org)}/invitations`),
    [call]
  );

  /** A shareable code: it expires after `expires_in_days` (7 by default) and may be capped at `max_uses`. */
  const createInvitation = useCallback(
    (org: string, payload: { expires_in_days?: number | null; max_uses?: number | null } = {}) =>
      send<OrganizationInvitation>(`${root(org)}/invitations`, 'POST', payload),
    [send]
  );

  /** One code, and an invitation notification for each of the users. */
  const inviteUsers = useCallback(
    (org: string, userIds: string[]) =>
      send<OrganizationInvitation>(`${root(org)}/invitations/invite-users`, 'POST', {
        user_ids: userIds,
      }),
    [send]
  );

  const revokeInvitation = useCallback(
    (org: string, invitationId: string) =>
      send<void>(`${root(org)}/invitations/${enc(invitationId)}`, 'DELETE'),
    [send]
  );

  /** Open to anybody: one 404 for an unknown, expired, revoked or used-up code. */
  const previewInvitation = useCallback(
    (code: string) => call<InvitationPreview>(`/v1/invitations/${enc(code)}/preview`),
    [call]
  );

  /** Joins as MEMBER; 409 `already_member`. */
  const joinOrganization = useCallback(
    (code: string) => send<Organization>(`/v1/invitations/${enc(code)}/join`, 'POST'),
    [send]
  );

  /** The predefined avatar files (`GET /v1/avatars`). */
  const getDefaultAvatars = useCallback(() => call<string[]>('/v1/avatars'), [call]);

  /** A PNG, JPEG or WebP of at most 2 MiB, sent as the raw body. */
  const uploadOrgAvatar = useCallback(
    (org: string, file: Blob) =>
      call<Organization>(`${root(org)}/avatar`, {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      }),
    [call]
  );

  /** A predefined avatar (or none: the initials) and its colours. */
  const setOrgAvatar = useCallback(
    (
      org: string,
      selection: { avatar?: string | null; bg_color?: string | null; fg_color?: string | null }
    ) => send<Organization>(`${root(org)}/avatar-colors`, 'PUT', selection),
    [send]
  );

  const removeOrgAvatar = useCallback(
    (org: string) => send<Organization>(`${root(org)}/avatar`, 'DELETE'),
    [send]
  );

  /** People by username: at least 4 characters, at most 20 results, never an email. */
  const searchUsers = useCallback(
    (q: string, signal?: AbortSignal) => call<UserRef[]>(`/v1/users${query({ q })}`, { signal }),
    [call]
  );

  /** ADMIN reads it. `action` is an exact action name, filtered by the server. */
  const getAudit = useCallback(
    (org: string, params: { action?: string; offset?: number; limit?: number } = {}) =>
      call<OrganizationAuditPage>(`${root(org)}/audit${query(params)}`),
    [call]
  );

  return useMemo(
    () => ({
      getMyOrganizations,
      getOrganization,
      getOrganizationProfile,
      getHierarchy,
      createOrganization,
      updateOrganization,
      moveOrganization,
      deleteOrganization,
      getMembers,
      updateMembersBatch,
      upsertMember,
      removeMember,
      transferOwnership,
      getInvitations,
      createInvitation,
      inviteUsers,
      revokeInvitation,
      previewInvitation,
      joinOrganization,
      getDefaultAvatars,
      uploadOrgAvatar,
      setOrgAvatar,
      removeOrgAvatar,
      searchUsers,
      getAudit,
    }),
    [
      getMyOrganizations,
      getOrganization,
      getOrganizationProfile,
      getHierarchy,
      createOrganization,
      updateOrganization,
      moveOrganization,
      deleteOrganization,
      getMembers,
      updateMembersBatch,
      upsertMember,
      removeMember,
      transferOwnership,
      getInvitations,
      createInvitation,
      inviteUsers,
      revokeInvitation,
      previewInvitation,
      joinOrganization,
      getDefaultAvatars,
      uploadOrgAvatar,
      setOrgAvatar,
      removeOrgAvatar,
      searchUsers,
      getAudit,
    ]
  );
}
