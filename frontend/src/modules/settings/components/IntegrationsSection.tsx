// Adapted from SPHERE frontend/src/modules/settings/components/IntegrationsSection.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's one provider, the Universidad de Sevilla CAS identity (linked through `POST /v1/auth/cas/link-intent`),
// and any other identity the gateway lists; unlinking asks in OpenBinding's accessible Modal and, on RESEARCH, for the typed
// phrase the gateway requires, showing the plan change it causes; Google and the local-password card are not ported (the
// password is changed in Account); load failures are said with a retry.

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  FiArrowRight,
  FiCheck,
  FiLink,
  FiLoader,
  FiLock,
  FiShield,
  FiTrash2,
} from 'react-icons/fi';
import { InstitutionMark } from '../../auth/components/institution-mark';
import {
  INSTITUTION_NAME,
  useInstitutionalBranding,
} from '../../auth/components/institution-mark/institution';
import { PlanChangedNotice } from '../../auth/components/plan-changed-notice';
import { readCatalog } from '../../core/utils/pricing/pricingModel';
import { formatDate } from '../../core/utils/format';
import { LIMIT } from '../../core/utils/limits';
import { leaveTo } from '../../core/utils/navigation';
import { useAuth } from '../../auth/hooks/useAuth';
import { classifyAuthError, marker, type AuthFailure } from '../../core/api/errors';
import BlockAlert from '../../core/components/block-alert';
import { FormField } from '../../core/components/form-field';
import { Modal } from '../../core/components/modal';
import { useUserSettingsApi, type ExternalIdentity } from '../api/userSettingsApi';
import { fallbackMessage } from '../../core/utils/account-errors';
import { accountClient } from '../../auth/api/accountClient';

/** The phrase the gateway asks for before it moves a RESEARCH account off the institutional plan. */
const DOWNGRADE_PHRASE = 'DOWNGRADE RESEARCH';
const CAS = 'us-cas';

interface Message {
  variant: 'success' | 'error';
  text: string;
}

function pausedReason(code: string | undefined): string {
  switch (code) {
    case 'institutional_pricing_invalid':
      return 'the current pricing has no valid RESEARCH plan';
    case 'cas_unavailable':
      return 'CAS sign-in isn’t enabled on this deployment';
    case 'pricing_unavailable':
      return 'the pricing service isn’t answering';
    default:
      return 'a service it depends on isn’t answering';
  }
}

/** What the person is told when starting the link fails. Their current sign-in is never affected. */
function linkFailure(failure: AuthFailure): string {
  if (failure.kind === 'unavailable')
    return `Institutional sign-in is paused${marker(failure)}: ${pausedReason(failure.code)}. Try again later.`;
  return fallbackMessage(failure, 'linked');
}

/** What the gateway's refusals to unlink mean for the person. */
function unlinkFailure(failure: AuthFailure): string {
  if (failure.code === 'research_downgrade_confirmation_required')
    return `409 · research_downgrade_confirmation_required: type ${DOWNGRADE_PHRASE} exactly to confirm the plan change.`;
  if (failure.code === 'last_login_method')
    return 'This is your only way to sign in (409 · last_login_method). Set a password in Account first, then unlink.';
  if (failure.kind === 'unavailable')
    return `Your identity and plan were not changed: the pricing service isn’t answering${marker(failure)}. Try again later.`;
  return fallbackMessage(failure, 'unlinked');
}

export default function IntegrationsSection() {
  const { user, refresh } = useAuth();
  const api = useUserSettingsApi();
  const institutional = useInstitutionalBranding();
  const [identities, setIdentities] = useState<ExternalIdentity[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [linking, setLinking] = useState(false);
  const [unlinking, setUnlinking] = useState<ExternalIdentity | null>(null);
  const [message, setMessage] = useState<Message | null>(null);

  useEffect(() => {
    let current = true;
    api
      .listIdentities()
      .then(list => {
        if (!current) return;
        setIdentities(list);
        setLoadError(null);
      })
      .catch((caught: unknown) => {
        if (!current) return;
        const failure = classifyAuthError(caught);
        setLoadError(
          failure.status === 403
            ? 'This request was refused (403). To link or unlink identities, a request needs account:read and account:write or a browser session.'
            : fallbackMessage(failure, 'loaded')
        );
      });
    return () => {
      current = false;
    };
  }, [api, attempt]);

  const reload = useCallback(() => {
    setLoadError(null);
    setIdentities(null);
    setAttempt(value => value + 1);
  }, []);

  const cas = identities?.find(item => item.provider === CAS);
  const others = identities?.filter(item => item.provider !== CAS) ?? [];
  const researching = user?.plan === 'RESEARCH';

  const link = async () => {
    setLinking(true);
    setMessage(null);
    try {
      leaveTo(await accountClient.createCasLinkIntent());
    } catch (caught) {
      setMessage({ variant: 'error', text: linkFailure(classifyAuthError(caught)) });
      setLinking(false);
    }
  };

  const unlinked = async (downgraded: boolean, plan: string | null) => {
    setUnlinking(null);
    setMessage({
      variant: 'success',
      text: downgraded
        ? `Identity unlinked. Your plan is now ${plan ?? 'the default plan'}.`
        : 'Identity unlinked.',
    });
    // The plan and the institutional mark both follow the identity: re-read the profile instead of asking for a reload.
    reload();
    await refresh();
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-medium text-tp-ink">Sign-in & Security</h2>
        <p className="mt-0.5 text-sm text-tp-steel">
          The institutional identities linked to your OpenBinding account.
        </p>
      </div>

      <PlanChangedNotice />
      <BlockAlert
        variant={message?.variant ?? 'success'}
        message={message?.text}
        onDismiss={() => setMessage(null)}
      />

      <div className="overflow-hidden rounded-[12px] border border-tp-hairline bg-tp-canvas">
        <div className="border-b border-tp-hairline px-5 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-[9px] bg-tp-primary/10">
              <FiLink className="h-4 w-4 text-tp-accent" aria-hidden="true" />
            </div>
            <div>
              <h3 className="text-sm font-medium text-tp-ink">Connected identities</h3>
              <p className="mt-0.5 text-xs text-tp-steel">
                One CAS identity per OpenBinding account.
              </p>
            </div>
          </div>
        </div>

        {loadError ? (
          <div className="px-5 py-6 sm:px-6">
            <BlockAlert variant="error" message={loadError} />
            <button
              type="button"
              onClick={reload}
              className="mt-3 cursor-pointer rounded-[8px] border border-tp-hairline-strong px-3.5 py-2 text-xs font-medium text-tp-ink transition-colors hover:bg-tp-surface"
            >
              Try again
            </button>
          </div>
        ) : identities === null ? (
          <div
            className="flex items-center justify-center gap-2 px-6 py-12 text-sm text-tp-steel"
            aria-busy="true"
          >
            <FiLoader className="h-4 w-4 animate-spin" aria-hidden="true" />
            Loading sign-in methods…
          </div>
        ) : (
          <div className="divide-y divide-tp-hairline">
            <ProviderRow
              name={`${INSTITUTION_NAME} · CAS`}
              description={
                cas
                  ? `Linked ${formatDate(cas.verifiedAt) ?? 'recently'} · ${cas.subject}`
                  : 'Not linked. You’ll sign in at the Universidad de Sevilla and come back here.'
              }
              connected={Boolean(cas)}
              busy={linking}
              connectLabel={linking ? 'Opening CAS…' : 'Link CAS identity'}
              onConnect={() => void link()}
              onDisconnect={() => cas && setUnlinking(cas)}
            />
            {others.map(item => (
              <ProviderRow
                key={item.id}
                name={item.provider}
                description={`Linked ${formatDate(item.verifiedAt) ?? 'recently'} · ${item.subject}`}
                connected
                busy={false}
                connectLabel="Link"
                onConnect={() => {}}
                onDisconnect={() => setUnlinking(item)}
              />
            ))}
          </div>
        )}

        {cas && institutional && (
          <div className="flex flex-wrap items-center gap-3 border-t border-tp-hairline px-5 py-4 text-xs text-tp-steel sm:px-6">
            <InstitutionMark variant="compact" />
            <span>
              Shown on signed-in pages because your plan includes the institutional identity. It
              isn’t a role.
            </span>
          </div>
        )}
      </div>

      <div className="rounded-[12px] border border-tp-hairline bg-tp-canvas p-5 text-sm text-tp-steel sm:p-6">
        <p>
          RESEARCH needs a linked CAS identity. Linking one moves an account on the default plan to
          RESEARCH automatically, at no extra cost; an account on another plan keeps it. Unlinking
          while on RESEARCH moves you back to the default plan. See{' '}
          <Link to="/pricing" className="cursor-pointer text-tp-link hover:underline">
            the plans
          </Link>
          .
        </p>
        <p className="mt-3">
          Your password is changed in{' '}
          <Link to="/me/settings" className="cursor-pointer text-tp-link hover:underline">
            Account
          </Link>
          .
        </p>
      </div>

      {unlinking && (
        <UnlinkDialog
          identity={unlinking}
          researching={researching && unlinking.provider === CAS}
          onClose={() => setUnlinking(null)}
          onUnlinked={(downgraded, plan) => void unlinked(downgraded, plan)}
        />
      )}
    </div>
  );
}

function ProviderRow({
  name,
  description,
  connected,
  busy,
  connectLabel,
  onConnect,
  onDisconnect,
}: {
  name: string;
  description: string;
  connected: boolean;
  busy: boolean;
  connectLabel: string;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  return (
    <div className="flex flex-col gap-4 px-5 py-5 sm:flex-row sm:items-center sm:px-6">
      <div className="flex min-w-0 flex-1 items-center gap-4">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[11px] border border-tp-hairline bg-tp-surface">
          <FiLock className="h-5 w-5 text-tp-accent" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-medium text-tp-ink">{name}</h4>
            <span
              className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                connected ? 'bg-emerald-500/10 text-emerald-700' : 'bg-tp-surface text-tp-steel'
              }`}
            >
              {connected ? 'Connected' : 'Not connected'}
            </span>
          </div>
          <p className="mt-1 text-xs break-all text-tp-steel">{description}</p>
        </div>
      </div>

      {connected ? (
        <button
          type="button"
          onClick={onDisconnect}
          aria-label={`Unlink ${name}`}
          className="flex cursor-pointer items-center justify-center gap-2 self-start rounded-[8px] border border-tp-hairline-strong px-3.5 py-2 text-xs font-medium text-tp-steel transition-colors hover:border-red-300 hover:bg-red-50 hover:text-red-700 sm:self-auto"
        >
          <FiTrash2 className="h-3.5 w-3.5" aria-hidden="true" />
          Unlink
        </button>
      ) : (
        <button
          type="button"
          onClick={onConnect}
          disabled={busy}
          aria-busy={busy || undefined}
          className="flex cursor-pointer items-center justify-center gap-2 self-start rounded-[8px] bg-tp-accent px-3.5 py-2 text-xs font-medium text-tp-on-primary transition-colors hover:bg-tp-primary-deep disabled:cursor-not-allowed disabled:opacity-50 sm:self-auto"
        >
          {busy ? (
            <FiLoader className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <FiLink className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {connectLabel}
        </button>
      )}
    </div>
  );
}

/**
 * Typed confirmation for removing the institutional identity. On a RESEARCH account that also moves the plan back to the
 * default one, so the phrase is asked for; on any other plan nothing but the link goes.
 */
function UnlinkDialog({
  identity,
  researching,
  onClose,
  onUnlinked,
}: {
  identity: ExternalIdentity;
  researching: boolean;
  onClose: () => void;
  /** `downgraded`: the plan moved back too; `plan` is where it moved, when the pricing says. */
  onUnlinked: (downgraded: boolean, plan: string | null) => void;
}) {
  const api = useUserSettingsApi();
  const [catalog, setCatalog] = useState<ReturnType<typeof readCatalog>>(null);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const confirmed = !researching || typed === DOWNGRADE_PHRASE;

  // What changes is read from the live pricing; without it the dialog still works, just without the numbers.
  useEffect(() => {
    if (!researching) return;
    let current = true;
    api
      .getPricingCatalog()
      .then(answer => {
        if (current) setCatalog(readCatalog(answer));
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [api, researching]);

  const fallbackPlan =
    catalog?.plans.find(plan => !plan.byAgreement && plan.id !== 'RESEARCH')?.id ?? null;
  const jobs = catalog?.groups
    .flatMap(group => group.rows)
    .find(row => row.id === LIMIT.maxConcurrentRuns);
  const cellText = (planId: string | null) => {
    const index = catalog?.plans.findIndex(plan => plan.id === planId) ?? -1;
    const cell = index >= 0 ? jobs?.cells[index] : undefined;
    return cell?.kind === 'value'
      ? `${cell.text} concurrent ${cell.text === '1' ? 'run' : 'runs'}`
      : null;
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!confirmed) {
      setError(
        `409 · research_downgrade_confirmation_required: type ${DOWNGRADE_PHRASE} exactly to confirm the plan change.`
      );
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await api.unlinkIdentity(identity.id, researching ? typed : undefined);
      onUnlinked(researching, fallbackPlan);
    } catch (caught) {
      setError(unlinkFailure(classifyAuthError(caught)));
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Unlink your Universidad de Sevilla identity?"
      tone="danger"
      size="md"
      eyebrow="Warning"
      onClose={() => !busy && onClose()}
    >
      <form className="space-y-4" onSubmit={submit} noValidate>
        {researching ? (
          <>
            <div
              className="flex items-stretch gap-3 rounded-[10px] border border-tp-hairline bg-tp-surface p-3"
              aria-label="Plan change"
            >
              <div className="flex flex-1 flex-col">
                <span className="text-[11px] text-tp-steel uppercase">Now</span>
                <strong className="text-sm text-tp-ink">RESEARCH</strong>
                <small className="text-xs text-tp-steel">
                  {cellText('RESEARCH') ?? 'Institutional limits'}
                </small>
              </div>
              <FiArrowRight className="h-4 w-4 self-center text-tp-steel" aria-hidden="true" />
              <div className="flex flex-1 flex-col">
                <span className="text-[11px] text-tp-steel uppercase">After</span>
                <strong className="text-sm text-tp-ink">
                  {fallbackPlan ?? 'The default plan'}
                </strong>
                <small className="text-xs text-tp-steel">
                  {cellText(fallbackPlan) ?? 'Default limits'}
                </small>
              </div>
            </div>
            <p>
              You’d lose RESEARCH limits and the institutional identity. Work that exceeds the new
              limits keeps existing but new runs are limited.
            </p>
            <FormField
              label={`Type ${DOWNGRADE_PHRASE} to confirm`}
              value={typed}
              onChange={event => {
                setTyped(event.target.value);
                setError(undefined);
              }}
              autoComplete="off"
              spellCheck={false}
              mono
            />
          </>
        ) : (
          <p>Your plan stays as it is. You can link the identity again later.</p>
        )}
        <div aria-live="assertive">
          {error && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-[8px] border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-700"
            >
              <FiShield className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>{error}</span>
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="cursor-pointer rounded-[8px] px-4 py-2.5 text-sm font-medium text-tp-steel transition-colors hover:text-tp-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !confirmed}
            aria-busy={busy || undefined}
            className="flex cursor-pointer items-center gap-2 rounded-[8px] bg-red-700 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? (
              <FiLoader className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <FiCheck className="h-4 w-4" aria-hidden="true" />
            )}
            Unlink
          </button>
        </div>
      </form>
    </Modal>
  );
}
