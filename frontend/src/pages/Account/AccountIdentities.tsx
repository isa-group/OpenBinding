import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Fingerprint, MoveRight, ShieldCheck, TriangleAlert } from 'lucide-react';
import { apiClient } from '../../api/client';
import type { ExternalIdentity } from '../../api/auth';
import { InstitutionMark } from '../../components/InstitutionMark';
import { PlanChangedNotice } from '../../components/PlanChangedNotice/PlanChangedNotice';
import { INSTITUTION_NAME, useInstitutionalBranding } from '../../components/InstitutionMark/institution';
import { Action } from '../../components/ui/Action';
import { Chip } from '../../components/ui/Chip';
import { FormField } from '../../components/ui/FormField';
import { Modal } from '../../components/ui/Modal';
import { Notice, type NoticeTone } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { useAuth } from '../../contexts/auth';
import { formatDate } from '../../utils/format';
import { leaveTo } from '../../utils/navigation';
import { useResource } from '../../utils/useResource';
import { readCatalog } from '../Pricing/pricingModel';
import { classifyAuthError, fallbackMessage, marker, type AuthFailure } from './accountErrors';
import { AccountLayout, LoadFailure, PermissionNotice } from './AccountLayout';
import './AccountIdentities.css';

/** The phrase the gateway asks for before it moves a RESEARCH account off the institutional plan. */
const DOWNGRADE_PHRASE = 'DOWNGRADE RESEARCH';
const CAS = 'us-cas';

interface Message {
  tone: NoticeTone;
  text: string;
}

function pausedReason(code: string | undefined): string {
  switch (code) {
    case 'institutional_pricing_invalid': return 'the current pricing has no valid RESEARCH plan';
    case 'cas_unavailable': return 'CAS sign-in isn’t enabled on this deployment';
    case 'pricing_unavailable': return 'the pricing service isn’t answering';
    default: return 'a service it depends on isn’t answering';
  }
}

/** What the person is told when starting the link fails. Their current sign-in is never affected. */
function linkFailure(failure: AuthFailure): string {
  if (failure.kind === 'unavailable') return `Institutional sign-in is paused${marker(failure)}: ${pausedReason(failure.code)}. Try again later.`;
  return fallbackMessage(failure, 'linked');
}

/** What the gateway's refusals to unlink mean for the person. */
function unlinkFailure(failure: AuthFailure): string {
  if (failure.code === 'research_downgrade_confirmation_required') {
    return `409 · research_downgrade_confirmation_required: type ${DOWNGRADE_PHRASE} exactly to confirm the plan change.`;
  }
  if (failure.code === 'last_login_method') {
    return 'This is your only way to log in (409 · last_login_method). Set a password in Profile & security first, then unlink.';
  }
  if (failure.kind === 'unavailable') return `Your identity and plan were not changed: the pricing service isn’t answering${marker(failure)}. Try again later.`;
  return fallbackMessage(failure, 'unlinked');
}

/**
 * Typed confirmation for removing the institutional identity. On a RESEARCH account that also moves the
 * plan back to the default one, so the phrase is asked for; on any other plan nothing but the link goes.
 */
function UnlinkDialog({ identity, researching, onClose, onUnlinked }: {
  identity: ExternalIdentity;
  researching: boolean;
  onClose: () => void;
  /** `downgraded`: the plan moved back too; `plan` is where it moved, when the pricing says. */
  onUnlinked: (downgraded: boolean, plan: string | null) => void;
}) {
  // What changes is read from the live pricing; without it the dialog still works, just without the numbers.
  const catalog = useResource('unlink-catalog', () => researching ? apiClient.getPricingCatalog().catch(() => null) : Promise.resolve(null));
  const view = catalog.data ? readCatalog(catalog.data) : null;
  const fallbackPlan = view?.plans.find((plan) => !plan.byAgreement && plan.id !== 'RESEARCH')?.id ?? null;
  const jobs = view?.groups.flatMap((group) => group.rows).find((row) => row.id === 'concurrentJobs');
  const cellText = (planId: string | null) => {
    const index = view?.plans.findIndex((plan) => plan.id === planId) ?? -1;
    const cell = index >= 0 ? jobs?.cells[index] : undefined;
    return cell?.kind === 'value' ? `${cell.text} concurrent ${cell.text === '1' ? 'job' : 'jobs'}` : null;
  };

  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const confirmed = !researching || typed === DOWNGRADE_PHRASE;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!confirmed) {
      setError(`409 · research_downgrade_confirmation_required: type ${DOWNGRADE_PHRASE} exactly to confirm the plan change.`);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await apiClient.unlinkOwnIdentity(identity.id, researching ? typed : undefined);
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
      eyebrow={<><TriangleAlert aria-hidden="true" className="ident-warn" />Warning</>}
      onClose={onClose}
    >
      <form className="acct-dialog-form" onSubmit={submit} noValidate>
        {researching && (
          <>
            <div className="ident-change" aria-label="Plan change">
              <div><span>Now</span><strong>RESEARCH</strong><small>{cellText('RESEARCH') ?? 'Institutional limits'}</small></div>
              <MoveRight aria-hidden="true" />
              <div className="is-after"><span>After</span><strong>{fallbackPlan ?? 'The default plan'}</strong><small>{cellText(fallbackPlan) ?? 'Default limits'}</small></div>
            </div>
            <p>You’d lose RESEARCH limits and the institutional identity. Work that exceeds the new limits keeps existing but new runs are limited.</p>
            <FormField
              label={`Type ${DOWNGRADE_PHRASE} to confirm`}
              value={typed}
              onChange={(event) => { setTyped(event.target.value); setError(undefined); }}
              autoComplete="off"
              spellCheck={false}
              mono
            />
          </>
        )}
        {!researching && <p>Your plan stays as it is. You can link the identity again later.</p>}
        <div aria-live="assertive">
          {error && <div className="acct-dialog-error" role="alert">{error}</div>}
        </div>
        <div className="ui-modal-actions">
          <Action variant="secondary" onClick={onClose}>Cancel</Action>
          <Action type="submit" variant="danger" disabled={!confirmed} busy={busy}>Unlink</Action>
        </div>
      </form>
    </Modal>
  );
}

/** Identities (`acct-identities`, `/app/account/identities`): the Universidad de Sevilla CAS identity and any other linked sign-in. */
export function AccountIdentities() {
  const { user, refresh } = useAuth();
  const institutional = useInstitutionalBranding();
  const identities = useResource(`identities:${user?.id ?? ''}`, () => apiClient.listOwnIdentities());
  const [notice, setNotice] = useState<Message | null>(null);
  const [linking, setLinking] = useState(false);
  const [unlinking, setUnlinking] = useState<ExternalIdentity | null>(null);

  const failure = identities.status === 'error' ? classifyAuthError(identities.error) : null;
  const list = identities.data ?? [];
  const cas = list.find((item) => item.provider === CAS);
  const others = list.filter((item) => item.provider !== CAS);
  const researching = user?.plan === 'RESEARCH';

  const link = async () => {
    setLinking(true);
    setNotice(null);
    try {
      leaveTo(await apiClient.createCasLinkIntent());
    } catch (caught) {
      setNotice({ tone: 'error', text: linkFailure(classifyAuthError(caught)) });
      setLinking(false);
    }
  };

  const unlinked = async (downgraded: boolean, plan: string | null) => {
    setUnlinking(null);
    setNotice({
      tone: 'success',
      text: downgraded ? `Identity unlinked. Your plan is now ${plan ?? 'the default plan'}.` : 'Identity unlinked.',
    });
    // The plan and the institutional mark both follow the identity: re-read the profile instead of asking for a reload.
    identities.reload();
    await refresh();
  };

  return (
    <AccountLayout section="identities" title="Identities" lede="Institutional identities linked to your account.">
      <PlanChangedNotice />
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
      {failure?.status === 403 && <PermissionNotice permissions={['account:read', 'account:write']} action="link or unlink identities" />}
      {failure && failure.status !== 403 && <LoadFailure onRetry={identities.reload}>{fallbackMessage(failure, 'loaded')}</LoadFailure>}
      {identities.status === 'loading' && <div aria-busy="true"><Skeleton variant="panel" /></div>}

      {identities.data && (
        <>
          <section className="ident-card" aria-labelledby="ident-title">
            <header>
              <span className="ident-icon" aria-hidden="true"><ShieldCheck /></span>
              <div>
                <h2 id="ident-title">Connected identities</h2>
                <p>One CAS identity per OpenBinding account.</p>
              </div>
            </header>
            <div className="ident-row">
              <span className="ident-tile" aria-hidden="true">US</span>
              <div className="ident-who">
                <strong>{INSTITUTION_NAME} · CAS</strong>
                <span>
                  {cas
                    ? `Verified · linked ${formatDate(cas.verifiedAt) ?? 'recently'} · ${cas.subject}`
                    : 'Not linked. You’ll sign in at the Universidad de Sevilla and come back here.'}
                </span>
              </div>
              <Chip tone={cas ? 'success' : 'plain'}>{cas ? 'Verified' : 'Not linked'}</Chip>
              {cas
                ? <Action variant="secondary" size="sm" onClick={() => setUnlinking(cas)}>Unlink</Action>
                : <Action variant="primary" size="sm" onClick={() => void link()} busy={linking}>{linking ? 'Opening CAS…' : 'Link CAS identity'}</Action>}
            </div>
            {cas && institutional && (
              <div className="ident-badge">
                <InstitutionMark variant="compact" />
                <span>Shown on signed-in pages because your plan includes the institutional identity. It isn’t a role.</span>
              </div>
            )}
          </section>

          {others.length > 0 && (
            <section className="ident-card" aria-labelledby="ident-other">
              <header>
                <span className="ident-icon" aria-hidden="true"><Fingerprint /></span>
                <div><h2 id="ident-other">Other sign-in identities</h2><p>Linked to your account by another provider.</p></div>
              </header>
              {others.map((item) => (
                <div key={item.id} className="ident-row">
                  <span className="ident-tile" aria-hidden="true">{item.provider.slice(0, 2).toUpperCase()}</span>
                  <div className="ident-who"><strong>{item.provider}</strong><span>Verified · linked {formatDate(item.verifiedAt) ?? 'recently'} · {item.subject}</span></div>
                  <Chip tone="success">Verified</Chip>
                  <Action variant="secondary" size="sm" onClick={() => setUnlinking(item)}>Unlink</Action>
                </div>
              ))}
            </section>
          )}

          <Notice tone="info">
            RESEARCH needs a verified CAS identity. Linking one moves an account on the default plan to RESEARCH automatically, at no extra cost;
            an account on another plan keeps it. Unlinking while on RESEARCH moves you back to the default plan. See{' '}
            <Link to="/pricing" viewTransition>the plans</Link>.
          </Notice>
        </>
      )}

      {unlinking && (
        <UnlinkDialog
          identity={unlinking}
          researching={researching && unlinking.provider === CAS}
          onClose={() => setUnlinking(null)}
          onUnlinked={(downgraded, plan) => void unlinked(downgraded, plan)}
        />
      )}
    </AccountLayout>
  );
}
