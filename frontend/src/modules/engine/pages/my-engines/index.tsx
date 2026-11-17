// Adapted from SPHERE frontend/src/modules/api-keys/pages/ApiKeysPage.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the account's engine registrations instead of its keys, in the same layout: the title, a banner for what a change
// did (or why it was refused, with the checks that failed), "Register an engine", the plan's room for federated engines in
// the usage box, lifecycle filter chips (Private, In review, Published, Rejected), the cards and how a registration's life
// goes. Publication and pausing a published engine are confirmed; deleting asks for the name. An administrator can list only
// what waits for review (`?review=true`). Refusals are read and said, never swallowed; a Helmet title.

import { useMemo, useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { MdAdd } from 'react-icons/md';
import { Link, useSearchParams } from 'react-router-dom';
import { useResource } from '../../../../utils/useResource';
import BlockAlert from '../../../core/components/block-alert';
import { useAuth } from '../../../auth/hooks/useAuth';
import { ENGINES_PATH, registerEnginePath } from '../../../../routes/paths/engines';
import { useEnginesApi, type EngineRegistrationRevision } from '../../api/enginesApi';
import {
  allowanceOf,
  describeFailure,
  readProbe,
  registrationHref,
  registrationKey,
  type Probe,
} from '../../api/registrationModel';
import { ConfirmDialog, DeregisterDialog } from '../../components/engine-dialogs';
import { PlanMeter, StatusChip } from '../../components/engine-parts';
import { MyDeployments } from '../../components/my-deployments';

type Filter = 'all' | 'private' | 'pending_review' | 'published' | 'rejected';

const FILTERS: ReadonlyArray<{ id: Filter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'private', label: 'Private' },
  { id: 'pending_review', label: 'In review' },
  { id: 'published', label: 'Published' },
  { id: 'rejected', label: 'Rejected' },
];

const LIFECYCLE: ReadonlyArray<{
  label: string;
  tone: 'info' | 'warning' | 'error';
  text: string;
}> = [
  {
    label: 'Inactive / Active',
    tone: 'info',
    text: 'Whether you can pick it for your own runs. Activation re-checks the deployment.',
  },
  {
    label: 'Private → In review → Published',
    tone: 'warning',
    text: 'Publishing needs an administrator’s review. Once published, it can’t be changed.',
  },
  {
    label: 'Delete',
    tone: 'error',
    text: 'Removes a registration you no longer use, with its stored credential. It can’t be undone.',
  },
];

/** Where an administrator reviews publication requests. */
const REVIEW_PATH = '/admin/moderation';

interface Message {
  variant: 'success' | 'error' | 'warning' | 'info';
  title?: string;
  text: string;
  href?: string;
}

type Pending = { kind: 'publish' | 'deactivate' | 'delete'; row: EngineRegistrationRevision };

/** `/me/engines`: the engine deployments of this account, and the ones published for everyone. */
export default function MyEnginesPage() {
  const api = useEnginesApi();
  const { user, isAdmin } = useAuth();
  const username = user?.username ?? '';
  const [params, setParams] = useSearchParams();
  const review = params.get('review') === 'true';
  const [filter, setFilter] = useState<Filter>('all');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState<Message | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  const list = useResource(`engine-registrations:${username}:${review}`, async () => ({
    review,
    username,
    rows: await api.listEngineRegistrations({ review }),
  }));
  const usage = useResource(`engine-registrations-usage:${username}`, () =>
    api.getOwnUsage().catch(() => null)
  );

  // After a failed refresh the last list stays, but never one that was asked for another way or by another account.
  const kept =
    list.stale?.review === review && list.stale.username === username ? list.stale : undefined;
  const rows = useMemo(() => (list.data ?? kept)?.rows ?? [], [list.data, kept]);
  const stamp = rows.map(row => `${registrationKey(row)}:${row.active}:${row.status}`).join(',');
  const probes = useResource(`engine-registration-probes:${stamp}`, async () => {
    const found: Record<string, Probe | null> = {};
    await Promise.all(
      rows.map(async row => {
        try {
          found[registrationKey(row)] = readProbe(
            (await api.getEngineRegistrationReport(row)).report
          );
        } catch {
          found[registrationKey(row)] = null;
        }
      })
    );
    return found;
  });
  const known = probes.data ?? probes.stale ?? {};

  const failure =
    list.status === 'error' ? describeFailure(list.error, 'Your engines couldn’t be loaded') : null;
  const visible = rows.filter(row => filter === 'all' || row.status === filter);
  const own = rows.filter(row => row.namespace === username);
  const allowance = allowanceOf(usage.data ?? usage.stale ?? null, own.length);

  const setReview = (next: boolean) => {
    const query = new URLSearchParams(params);
    if (next) query.set('review', 'true');
    else query.delete('review');
    setParams(query, { replace: true });
    setFilter('all');
    setMessage(null);
  };

  const run = async (
    row: EngineRegistrationRevision,
    task: () => Promise<unknown>,
    success: string
  ) => {
    setBusy(registrationKey(row));
    setMessage(null);
    try {
      await task();
      setMessage({ variant: 'success', text: success });
      list.reload();
    } catch (error: unknown) {
      const refused = describeFailure(error, 'The change was refused');
      const checks =
        refused.probe?.checks
          .filter(check => check.state === 'failed')
          .map(check => check.detail)
          .filter(Boolean) ?? [];
      setMessage({
        variant: refused.tone,
        title: refused.title,
        text: [refused.text, ...checks, ...refused.details].join(' '),
        href: refused.probe ? registrationHref(row) : undefined,
      });
    } finally {
      setBusy('');
    }
  };

  const toggle = (row: EngineRegistrationRevision) => {
    if (!row.active) {
      void run(
        row,
        () => api.activateEngineRegistration(row),
        `${row.name} passed its check and is active for you.`
      );
    } else if (row.status === 'published') {
      setPending({ kind: 'deactivate', row });
    } else {
      void run(
        row,
        () => api.deactivateEngineRegistration(row),
        'Deactivated. You can’t pick it for new runs until you activate it again.'
      );
    }
  };

  const askPublication = (row: EngineRegistrationRevision) => {
    if (!row.active) {
      setMessage({
        variant: 'warning',
        title: 'Activate it first',
        text: `Activate ${row.name} before requesting publication. Activation re-checks your deployment.`,
      });
      return;
    }
    setPending({ kind: 'publish', row });
  };

  const applyPending = async () => {
    if (!pending) return;
    const { kind, row } = pending;
    const task =
      kind === 'publish'
        ? () => api.requestEngineRegistrationPublication(row)
        : kind === 'deactivate'
          ? () => api.deactivateEngineRegistration(row)
          : () => api.deleteEngineRegistration(row);
    const success =
      kind === 'publish'
        ? 'Publication requested. An administrator will review it.'
        : kind === 'deactivate'
          ? 'Deactivated. Nobody can pick it for new runs until you activate it again.'
          : `Deleted ${row.name} ${row.version}.`;
    await run(row, task, success);
    setPending(null);
  };

  const status = list.status;
  const unauthorized = failure?.status === 401;
  const forbidden = failure?.status === 403;
  const unavailable = failure !== null && !unauthorized && !forbidden;
  const showList = status === 'ready' || rows.length > 0;
  const showMain = !unauthorized;
  const chip = (active: boolean) =>
    `cursor-pointer rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
      active
        ? 'border-tp-primary bg-tp-primary text-tp-on-primary'
        : 'border-tp-hairline-strong bg-tp-canvas text-tp-slate hover:border-tp-stone hover:text-tp-ink'
    }`;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <Helmet>
        <title>OpenBinding - My engines</title>
      </Helmet>
      <div className="mb-8">
        <h1 className="font-display text-3xl text-tp-ink">My engines</h1>
        <p className="mt-1 text-sm text-tp-steel">
          Engine deployments you’ve registered, and any that have been published for everyone.
          Built-in engines live in the{' '}
          <Link to={ENGINES_PATH} className="cursor-pointer text-tp-link hover:underline">
            catalog
          </Link>
          .
        </p>
      </div>

      {message && (
        <BlockAlert variant={message.variant} className="mb-6" onDismiss={() => setMessage(null)}>
          <div className="min-w-0">
            {message.title && <p className="font-medium">{message.title}</p>}
            <p>{message.text}</p>
            {message.href && (
              <Link to={message.href} className="cursor-pointer font-medium underline">
                See the checks
              </Link>
            )}
          </div>
        </BlockAlert>
      )}

      {unauthorized && (
        <BlockAlert variant="error" className="mb-6">
          <p className="font-medium">Your session ended (401)</p>
          <p>
            Log in again to see your engines.{' '}
            <Link to="/authentication" className="cursor-pointer font-medium underline">
              Log in
            </Link>
          </p>
        </BlockAlert>
      )}

      {forbidden && (
        <BlockAlert variant="error" className="mb-6">
          <div className="min-w-0">
            <p className="font-medium">
              {review
                ? isAdmin
                  ? 'This key can’t moderate engines (403)'
                  : 'Only administrators can filter by “in review” (403)'
                : 'This key can’t list engines (403)'}
            </p>
            <p>
              {review
                ? isAdmin
                  ? 'Your account is an administrator, but the API key behind this session doesn’t include “moderate engines”.'
                  : 'The link you followed asks for every registration waiting for review. That list is for platform administrators. Your own registrations are still here.'
                : 'The API key behind this session doesn’t include the permission to read engines (engines:read).'}
            </p>
            {review ? (
              <button
                type="button"
                onClick={() => setReview(false)}
                className="mt-2 cursor-pointer rounded-md border border-tp-severity-error-border px-3 py-1.5 text-xs font-medium text-tp-ink hover:bg-tp-severity-error-border/20"
              >
                Show my engines
              </button>
            ) : (
              <Link to="/me/api-keys" className="cursor-pointer font-medium underline">
                Manage API keys
              </Link>
            )}
          </div>
        </BlockAlert>
      )}

      {failure && unavailable && (
        <div className="mb-6">
          <BlockAlert variant={failure.tone}>
            <div className="min-w-0">
              <p className="font-medium">
                {failure.status === 503
                  ? 'Accounts are unavailable right now (503 · accounts_unavailable)'
                  : failure.title}
              </p>
              <p>
                {failure.status === 503
                  ? 'Registrations are tied to accounts, so we can’t list them. Nothing has changed; try again in a moment.'
                  : rows.length > 0
                    ? `${failure.text} You’re seeing the last list loaded.`
                    : failure.text}
              </p>
            </div>
          </BlockAlert>
          <button
            type="button"
            onClick={list.reload}
            className="mt-3 cursor-pointer rounded-lg border border-tp-hairline px-3 py-1.5 text-sm text-tp-slate transition-colors hover:bg-tp-surface"
          >
            Try again
          </button>
        </div>
      )}

      {showMain && (
        <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-tp-ink">
              {review ? 'Waiting for review' : 'Your engines'}
            </h2>
            <Link
              to={registerEnginePath()}
              className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-tp-accent px-4 py-2 text-sm font-medium text-tp-on-primary transition-colors hover:bg-tp-primary-deep"
            >
              <MdAdd className="h-4 w-4" aria-hidden="true" />
              Register an engine
            </Link>
          </div>

          {!review && (
            <section className="mb-4" aria-label="Your plan’s room for federated engines">
              <PlanMeter
                allowance={allowance}
                loading={usage.status === 'loading' && !usage.stale}
                note={
                  allowance ? (
                    <>
                      {allowance.plan} plan · limit from the live pricing. Your registered engines
                      count toward it.{' '}
                      <Link
                        to="/me/settings?section=plan"
                        viewTransition
                        className="cursor-pointer text-tp-link hover:underline"
                      >
                        See all your limits
                      </Link>
                    </>
                  ) : undefined
                }
              />
            </section>
          )}

          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter">
              {FILTERS.map(item => (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={filter === item.id}
                  onClick={() => setFilter(item.id)}
                  className={chip(filter === item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            {isAdmin && (
              <label className="flex cursor-pointer items-center gap-2 text-sm text-tp-slate">
                <input
                  type="checkbox"
                  className="h-4 w-4 cursor-pointer accent-tp-primary"
                  checked={review}
                  onChange={event => setReview(event.target.checked)}
                />
                <span>Only in review</span>
                <StatusChip>admin</StatusChip>
              </label>
            )}
          </div>
        </>
      )}

      {status === 'loading' && !kept && (
        <div
          className="rounded-lg border border-tp-hairline bg-tp-canvas p-8 text-center"
          aria-busy="true"
        >
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-tp-primary border-t-transparent" />
          <p className="mt-3 text-sm text-tp-steel">Loading your engines…</p>
        </div>
      )}

      {showMain && !forbidden && showList && (
        <>
          {rows.length > 0 && visible.length === 0 ? (
            <div className="rounded-lg border border-tp-hairline bg-tp-canvas p-8 text-center">
              <h3 className="text-sm font-medium text-tp-ink">No engine matches this filter</h3>
              <p className="mt-1 text-sm text-tp-steel">Try another filter.</p>
            </div>
          ) : (
            (rows.length > 0 || !failure) && (
              <MyDeployments
                rows={visible}
                username={username}
                review={review}
                isAdmin={isAdmin}
                probes={known}
                probesLoading={probes.status === 'loading'}
                busy={busy}
                createTo={registerEnginePath()}
                reviewTo={REVIEW_PATH}
                onToggle={toggle}
                onRequestPublication={askPublication}
                onDelete={row => setPending({ kind: 'delete', row })}
              />
            )
          )}
          {rows.length > 0 && (
            <p className="mt-3 text-xs text-tp-steel">
              {review
                ? 'Shown because an owner requested publication and the registration is waiting for an administrator.'
                : 'Your registrations are private to your account. Published ones are shared by their owners with everyone.'}
            </p>
          )}
        </>
      )}

      {showMain && !review && (
        <section
          className="mt-8 flex flex-col gap-2 rounded-lg border border-tp-hairline bg-tp-canvas p-4"
          aria-label="How registrations change"
        >
          {LIFECYCLE.map(item => (
            <div
              key={item.label}
              className="flex flex-wrap items-center gap-2 text-sm text-tp-slate"
            >
              <StatusChip tone={item.tone}>{item.label}</StatusChip>
              <span>{item.text}</span>
            </div>
          ))}
        </section>
      )}

      {pending?.kind === 'publish' && (
        <ConfirmDialog
          title={`Request publication of ${pending.row.name}?`}
          confirmLabel="Request publication"
          busy={busy === registrationKey(pending.row)}
          onConfirm={() => void applyPending()}
          onClose={() => setPending(null)}
        >
          <p>
            Administrators will then be able to discover and review this exact revision. It stays
            private until they approve it.
          </p>
        </ConfirmDialog>
      )}
      {pending?.kind === 'deactivate' && (
        <ConfirmDialog
          title={`Deactivate ${pending.row.name}?`}
          tone="warning"
          confirmLabel="Deactivate"
          busy={busy === registrationKey(pending.row)}
          onConfirm={() => void applyPending()}
          onClose={() => setPending(null)}
        >
          <p>
            It is published, so other people may be using it. Deactivating pauses it for everyone;
            its publication state doesn’t change. Administrators are told.
          </p>
        </ConfirmDialog>
      )}
      {pending?.kind === 'delete' && (
        <DeregisterDialog
          name={pending.row.name}
          version={pending.row.version}
          published={pending.row.status === 'published'}
          busy={busy === registrationKey(pending.row)}
          onConfirm={() => void applyPending()}
          onClose={() => setPending(null)}
        />
      )}
    </div>
  );
}
