// Adapted from SPHERE frontend/src/modules/organization/pages/organization-join/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's code invitations (the preview names the organization and who invited); the route is protected,
// so the page never redirects by itself; one neutral "Invalid invitation" for an unknown, expired or used-up code; a
// member who already belongs is told so and taken to the organization; after joining, the organization's page opens;
// SPHERE's undefined `sphere-grey` classes become the theme's tokens; real links instead of `router.push` buttons.

import { useEffect, useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { readApiError } from '../../../core/api/errors';
import Iconify from '../../../core/components/iconify';
import OrgAvatar from '../../../core/components/org-avatar';
import OrgJoinSkeleton from '../../../core/components/skeletons/org-join-skeleton';
import {
  avatarProps,
  useOrganizationsApi,
  type InvitationPreview,
} from '../../api/organizationsApi';
import { useOrganization } from '../../hooks/useOrganization';
import { orgPath } from '../../types/paths';

const INVALID = 'This invitation link is invalid, expired, or has already been used to its limit.';

export default function OrganizationJoinPage() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const { refresh } = useOrganization();
  const { previewInvitation, joinOrganization } = useOrganizationsApi();
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isJoining, setIsJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joined, setJoined] = useState(false);

  useEffect(() => {
    if (!code) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- an address without a code is invalid at once
      setError(INVALID);
      setIsLoading(false);
      return;
    }
    let current = true;
    previewInvitation(code)
      .then(data => {
        if (current) setPreview(data);
      })
      .catch((caught: unknown) => {
        if (!current) return;
        const refusal = readApiError(caught);
        setError(refusal.status === 404 ? INVALID : refusal.message || INVALID);
      })
      .finally(() => {
        if (current) setIsLoading(false);
      });
    return () => {
      current = false;
    };
  }, [code, previewInvitation]);

  const org = preview?.organization ?? null;

  const handleJoin = () => {
    if (!code || !org) return;
    setIsJoining(true);
    setError(null);
    joinOrganization(code)
      .then(async () => {
        await refresh();
        setJoined(true);
      })
      .catch(async (caught: unknown) => {
        const refusal = readApiError(caught);
        if (refusal.code === 'already_member') {
          await refresh();
          navigate(orgPath(org.slug));
          return;
        }
        setError(refusal.status === 404 ? INVALID : refusal.message || INVALID);
        setIsJoining(false);
      });
  };

  if (isLoading) return <OrgJoinSkeleton />;

  if (joined && org) {
    return (
      <div className="mx-auto max-w-112 px-4 py-16 text-center">
        <Helmet>
          <title>{`OpenBinding - Joined ${org.name}`}</title>
        </Helmet>
        <div className="flex flex-col items-center gap-4" role="status">
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-green-100 text-green-700">
            <Iconify icon="mdi:check-circle-outline" width={36} />
          </span>
          <h1 className="font-display text-3xl text-tp-ink">You joined!</h1>
          <p className="text-sm text-tp-slate">
            You are now a member of <strong>{org.name}</strong>.
          </p>
          <Link
            to={orgPath(org.slug)}
            className="mt-2 cursor-pointer rounded-md bg-tp-accent px-6 py-2 text-sm font-semibold text-tp-on-primary hover:bg-tp-primary-deep"
          >
            Open {org.name}
          </Link>
        </div>
      </div>
    );
  }

  if (!org) {
    return (
      <div className="mx-auto max-w-112 px-4 py-16 text-center">
        <Helmet>
          <title>OpenBinding - Invalid invitation</title>
        </Helmet>
        <div className="flex flex-col items-center gap-4">
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-red-100 text-red-700">
            <Iconify icon="mdi:link-off" width={36} />
          </span>
          <h1 className="font-display text-3xl text-tp-ink">Invalid invitation</h1>
          <p className="text-sm text-tp-slate">{error ?? INVALID}</p>
          <Link
            to="/me/orgs"
            className="mt-2 cursor-pointer rounded-md border border-tp-hairline-strong px-5 py-2 text-sm font-semibold text-tp-ink hover:bg-tp-surface"
          >
            Back to organizations
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-112 px-4 py-16">
      <Helmet>
        <title>{`OpenBinding - Join ${org.name}`}</title>
      </Helmet>
      <div className="flex flex-col items-center gap-4 text-center">
        <OrgAvatar name={org.name} {...avatarProps(org.avatar)} size={100} />
        <div>
          <h1 className="font-display text-3xl text-tp-ink">{org.name}</h1>
          <p className="font-mono text-sm text-tp-steel">@{org.slug}</p>
        </div>
        {org.description && <p className="text-sm text-tp-slate">{org.description}</p>}

        <div className="mt-2 w-full rounded-lg border border-tp-hairline bg-tp-surface px-5 py-4 text-left text-sm">
          <p className="mb-1 font-semibold text-tp-ink">
            {preview?.invited_by
              ? `@${preview.invited_by.username} invited you to join this organization.`
              : 'You have been invited to join this organization.'}
          </p>
          <p className="text-tp-slate">
            You will join as a <strong>member</strong>. Admins can change your role later.
          </p>
          {preview?.expires_at && (
            <p className="mt-1 text-xs text-tp-steel">
              The invitation expires on{' '}
              {new Date(preview.expires_at).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })}
              .
            </p>
          )}
        </div>

        {error && (
          <p
            role="alert"
            className="w-full rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700"
          >
            {error}
          </p>
        )}

        <div className="flex w-full flex-col gap-2 pt-2">
          <button
            type="button"
            onClick={handleJoin}
            disabled={isJoining}
            className="w-full cursor-pointer rounded-md bg-tp-accent py-2.5 text-sm font-semibold text-tp-on-primary hover:bg-tp-primary-deep disabled:opacity-50"
          >
            {isJoining ? 'Joining...' : `Join ${org.name}`}
          </button>
          <Link
            to="/me/orgs"
            className="w-full cursor-pointer rounded-md border border-tp-hairline-strong py-2.5 text-sm font-semibold text-tp-ink hover:bg-tp-surface"
          >
            Cancel
          </Link>
        </div>
      </div>
    </div>
  );
}
