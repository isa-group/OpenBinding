// Adapted from SPHERE frontend/src/modules/organization/pages/organization-detail/components/CollectionsTab.tsx (revision
// fc776b4d), https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: a composition's environments instead of an organization's collections: the frame (a hairline card, an h2 with
// its subtitle, the primary "New environment" for ADMIN, the empty state, the 1-2-3 column grid) is SPHERE's; there is no
// search or paging (a composition has a handful of environments). The environment the address names (`?environment=`)
// opens its detail in place of the grid; under the grid, the composition's upstream changes (F6), whose event the address
// names (`?event=`) opens in place too; then the composition's proposals. Who sees what follows the roles: every member
// reads, whoever the environment's adoption role allows adopts, ADMIN creates, edits and deletes.

import { motion } from 'framer-motion';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { classifyAuthError, marker } from '../../../core/api/errors';
import type {
  CompositionEnvironmentView,
  CompositionVersionView,
  CompositionView,
} from '../../../core/api/types';
import { EmptyState } from '../../../core/components/empty-state';
import { SYSTEM_TOAST } from '../../../core/contexts/toastKinds';
import { useToast } from '../../../core/contexts/useToast';
import { useResource } from '../../../core/hooks/useResource';
import type { OrgRole } from '../../../organization/api/organizationsApi';
import { compositionPath } from '../../../../routes/paths/compositions';
import { useEnvironmentsApi } from '../../api/environmentsApi';
import { roleAtLeast } from '../../hooks/useCompositionRole';
import { mayAdopt } from '../../utils/environments';
import EnvironmentCard from '../environment-card';
import EnvironmentFormDialog, { DeleteEnvironmentDialog } from '../environment-form-dialog';
import ProposalsSection from '../proposals-section';
import UpstreamEventDetailView from '../upstream-event-detail';
import ProposeAdoption from '../upstream-event-detail/ProposeAdoption';
import UpstreamEventsSection from '../upstream-events-section';
import EnvironmentDetail from './EnvironmentDetail';

interface Props {
  org: string;
  composition: CompositionView;
  /** Light rows of the composition's versions, newest first. */
  versions: CompositionVersionView[];
  /** The reader's role in the organization (a member's; the tab is not drawn for others). */
  role: OrgRole | null;
  /** Adopt in an environment (the adopt dialog); absent until it can be offered. */
  onAdopt?: (environment: CompositionEnvironmentView) => void;
  /** Bumped by the page when something it did (an adoption) changed the environments. */
  refresh?: number;
  /** Something done here changed the upstream events (a review): the page reads its counts again. */
  onUpstreamChanged?: () => void;
}

export default function OperationTab({
  org,
  composition,
  versions,
  role,
  onAdopt,
  refresh = 0,
  onUpstreamChanged,
}: Props) {
  const api = useEnvironmentsApi();
  const { addToast } = useToast();
  const [query] = useSearchParams();
  const selected = query.get('environment');
  const event = query.get('event');
  const canAdminister = roleAtLeast(role, 'ADMIN');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<{
    environment: CompositionEnvironmentView;
    etag: string | null;
  } | null>(null);
  const [deleting, setDeleting] = useState<{
    environment: CompositionEnvironmentView;
    etag: string | null;
  } | null>(null);
  const [nonce, setNonce] = useState(0);
  const environments = useResource(
    `composition-environments:${org}/${composition.slug}:${refresh}:${nonce}`,
    () => api.listEnvironments(org, composition.slug)
  );
  const changed = (message?: string) => {
    if (message) addToast({ kind: SYSTEM_TOAST, title: message });
    setNonce(value => value + 1);
  };
  const detailTo = (slug?: string) =>
    compositionPath(org, composition.slug, 'operation', { environment: slug });

  /** Opens an edit or a delete on the environment as it is now, with its `ETag`. */
  const openWith = async (
    environment: CompositionEnvironmentView,
    then: (value: { environment: CompositionEnvironmentView; etag: string | null }) => void
  ) => {
    try {
      const read = await api.getEnvironment(org, composition.slug, environment.slug);
      then({ environment: read.value, etag: read.etag });
    } catch {
      then({ environment, etag: null });
    }
  };

  const failure = environments.status === 'error' ? classifyAuthError(environments.error) : null;
  const list = environments.data ?? environments.stale ?? [];

  if (event)
    return (
      <UpstreamEventDetailView
        org={org}
        composition={composition}
        versions={versions}
        eventId={event}
        role={role}
        backTo={detailTo()}
        refresh={`${refresh}:${nonce}`}
        onChanged={() => {
          setNonce(value => value + 1);
          onUpstreamChanged?.();
        }}
        actions={detail => (
          <ProposeAdoption
            org={org}
            composition={composition.slug}
            event={detail}
            environments={list}
            role={role}
            onChanged={() => {
              setNonce(value => value + 1);
              onUpstreamChanged?.();
            }}
          />
        )}
      />
    );

  if (selected)
    return (
      <EnvironmentDetail
        key={`${selected}:${refresh}`}
        org={org}
        composition={composition}
        versions={versions}
        slug={selected}
        role={role}
        backTo={detailTo()}
        onAdopt={onAdopt}
        onChanged={changed}
      />
    );

  return (
    <motion.div
      key="operation"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
    >
      <section
        aria-labelledby="operation-heading"
        className="rounded-xl border border-tp-hairline bg-tp-canvas"
      >
        <div className="flex flex-col gap-3 border-b border-tp-hairline px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 id="operation-heading" className="font-display text-lg text-tp-ink">
              Environments
            </h2>
            <p className="text-xs text-tp-steel">
              What your applications read. It changes only when someone adopts a version.
            </p>
          </div>
          {canAdminister && (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="flex h-9 cursor-pointer items-center gap-1.5 self-start rounded-lg bg-tp-primary px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-tp-primary/90 sm:self-auto"
            >
              <svg
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
                aria-hidden="true"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              New environment
            </button>
          )}
        </div>

        <div className="min-h-40 p-4">
          {environments.status === 'loading' && list.length === 0 ? (
            <p role="status" className="py-12 text-center text-sm text-tp-steel">
              Loading the environments…
            </p>
          ) : failure ? (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"
            >
              {`The environments couldn’t be loaded${marker(failure)}.`}
              <button
                type="button"
                onClick={environments.reload}
                className="cursor-pointer rounded-lg border border-red-300 bg-tp-canvas px-3 py-1 text-xs font-medium"
              >
                Retry
              </button>
            </div>
          ) : list.length === 0 ? (
            <EmptyState
              dashed
              icon={
                <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-16.5-3a3 3 0 013-3h13.5a3 3 0 013 3"
                  />
                </svg>
              }
              title="No environments yet"
            >
              {canAdminister
                ? 'Create one for each place an application runs, then adopt a version in it.'
                : 'An admin of this organization creates environments; then a version can be adopted in them.'}
            </EmptyState>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {list.map(environment => (
                <EnvironmentCard
                  key={environment.id}
                  environment={environment}
                  to={detailTo(environment.slug)}
                  onAdopt={
                    onAdopt && mayAdopt(role, environment) && !composition.archived
                      ? () => onAdopt(environment)
                      : undefined
                  }
                  menuItems={
                    canAdminister
                      ? [
                          {
                            label: 'Edit',
                            onClick: () => void openWith(environment, setEditing),
                          },
                          {
                            label: 'Delete',
                            variant: 'danger',
                            onClick: () => void openWith(environment, setDeleting),
                          },
                        ]
                      : []
                  }
                />
              ))}
            </div>
          )}
        </div>
      </section>
      {list.length > 0 && (
        <p className="mt-2 text-xs text-tp-steel">
          {list.length === 1 ? 'One environment' : `${list.length} environments`}.{' '}
          <Link
            to={compositionPath(org, composition.slug, 'versions')}
            className="underline decoration-dotted hover:text-tp-ink"
          >
            Versions
          </Link>{' '}
          lists what can be adopted.
        </p>
      )}

      <div className="mt-6">
        <UpstreamEventsSection
          org={org}
          composition={composition}
          refresh={`${refresh}:${nonce}`}
        />
      </div>

      <div className="mt-6">
        <ProposalsSection
          org={org}
          composition={composition}
          versions={versions}
          environments={list}
          refresh={refresh}
          onChanged={() => {
            setNonce(value => value + 1);
            onUpstreamChanged?.();
          }}
        />
      </div>

      {creating && (
        <EnvironmentFormDialog
          org={org}
          composition={composition.slug}
          onClose={() => setCreating(false)}
          onSaved={environment => {
            setCreating(false);
            changed(`Environment “${environment.name}” created.`);
          }}
        />
      )}
      {editing && (
        <EnvironmentFormDialog
          org={org}
          composition={composition.slug}
          editing={editing}
          onClose={() => setEditing(null)}
          onStale={() => {
            setEditing(null);
            changed();
          }}
          onSaved={environment => {
            setEditing(null);
            changed(`Environment “${environment.name}” saved.`);
          }}
        />
      )}
      {deleting && (
        <DeleteEnvironmentDialog
          org={org}
          composition={composition.slug}
          environment={deleting.environment}
          etag={deleting.etag}
          onClose={() => setDeleting(null)}
          onStale={() => {
            setDeleting(null);
            changed();
          }}
          onDeleted={() => {
            const name = deleting.environment.name;
            setDeleting(null);
            changed(`Environment “${name}” deleted.`);
          }}
        />
      )}
    </motion.div>
  );
}
