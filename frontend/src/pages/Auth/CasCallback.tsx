import { useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { apiClient } from '../../api/client';
import { InstitutionMark } from '../../components/InstitutionMark';
import { INSTITUTION_NAME, useInstitutionalBranding } from '../../components/InstitutionMark/institution';
import { Notice } from '../../components/ui/Notice';
import { useAuth } from '../../contexts/auth';
import { casFlowFor, exchangeCasOnce, forgetCasFlow, notePlanChanged, rememberCasFlow, type CasMode } from '../../utils/authFlow';
import { classifyAuthError } from './authErrors';

/**
 * What stopped the CAS round trip. The gateway answers every failure of its own callback step with `?error=<code>` (a closed list,
 * so nothing from the address is ever shown) and some on the code exchange; both end here.
 */
type CasFailure =
  | 'code' | 'unavailable' | 'pricing' | 'pricing-down' | 'state' | 'ticket' | 'inactive' | 'error' | 'linked-elsewhere' | 'collision';

type Phase = { name: 'loading' } | { name: 'empty' } | { name: 'error'; failure: CasFailure } | { name: 'success' };

/** The `?error=` codes of the callback (docs/ACCOUNTS_AND_PLANS.md), and what each one means for the person. */
const REPORTED = new Map<string, CasFailure>([
  ['cas_unavailable', 'unavailable'],
  ['cas_state_invalid', 'state'],
  ['cas_ticket_invalid', 'ticket'],
  ['account_inactive', 'inactive'],
  ['identity_in_use', 'linked-elsewhere'],
  ['account_collision', 'collision'],
  ['pricing_unavailable', 'pricing-down'],
  ['institutional_pricing_invalid', 'pricing'],
  ['cas_error', 'error'],
]);

function failureFor(code: string | undefined, status: number | undefined): CasFailure {
  const known = code ? REPORTED.get(code) : undefined;
  if (known) return known;
  if (status === 503) return 'unavailable';
  if (status === 409) return 'linked-elsewhere';
  return 'code';
}

/** Failures after which starting the CAS sign-in again can work. */
const RETRYABLE = new Set<CasFailure>(['code', 'unavailable', 'pricing-down', 'state', 'ticket', 'error']);
/** Failures that say something about the service rather than about the person. */
const SERVICE = new Set<CasFailure>(['code', 'unavailable', 'pricing', 'pricing-down', 'error']);

/** Lands here from the university's sign-in: exchanges the one-time code for a session, or explains why it cannot. */
export function CasCallback() {
  const { refresh, user } = useAuth();
  const institutional = useInstitutionalBranding();
  const location = useLocation();
  const started = useRef(false);
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  const reported = params.get('error');
  const announced = params.get('plan_changed');
  // The screen is mounted again once the exchange signs the person in (the interface below the account
  // provider restarts when the account changes), so the flow and the exchange are kept against the code.
  const [flow] = useState(() => casFlowFor(code));
  const mode: CasMode = params.get('mode') === 'link' ? 'link' : flow?.mode ?? 'login';
  const [phase, setPhase] = useState<Phase>(() => {
    if (code) return { name: 'loading' };
    return reported ? { name: 'error', failure: failureFor(reported, undefined) } : { name: 'empty' };
  });

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    // One-time memory: whatever happens next, the next CAS round trip starts from a clean slate.
    forgetCasFlow();
    if (!code) return;
    // Linking CAS raises BASIC to RESEARCH at no cost. The exchange says so; the redirect's `plan_changed` is the same news a step earlier.
    void exchangeCasOnce(code, () => apiClient.exchangeCasCode(code).then((change) => {
      if (change) notePlanChanged({ from: change.from, to: change.to, extraCost: change.extra_cost });
      else if (announced) notePlanChanged({ to: announced, extraCost: false });
      return refresh();
    }))
      .then(() => setPhase({ name: 'success' }))
      .catch((caught: unknown) => {
        const result = classifyAuthError(caught);
        setPhase({ name: 'error', failure: failureFor(result.code, result.status) });
      });
  }, [code, announced, refresh]);

  const linking = mode === 'link';
  const workspace = (!linking && flow?.returnTo) || '/app';
  const modeLabel = linking ? 'link identity' : 'log in';
  const name = user?.username;

  return (
    <div className="auth-card-page">
      <div className="auth-card" aria-live="polite">
        <span className="auth-card-eyebrow">{INSTITUTION_NAME} · CAS · {modeLabel}</span>

        {phase.name === 'loading' && (
          <div className="auth-card-row" role="status">
            <span className="auth-loader" aria-hidden="true" />
            <div>
              <h1>Finishing sign-in…</h1>
              <p>Exchanging the one-time code from CAS for your session.</p>
            </div>
          </div>
        )}

        {phase.name === 'empty' && (
          <>
            <h1>There’s no code to finish sign-in</h1>
            <p>
              This page is opened by the {INSTITUTION_NAME} sign-in. Without its one-time code there’s nothing to exchange.
              Start again from the log in page.
            </p>
            <div className="auth-card-actions">
              <Link className="auth-btn auth-btn-primary" to="/login" viewTransition>Back to log in</Link>
            </div>
          </>
        )}

        {phase.name === 'error' && (
          <>
            <h1>
              {phase.failure === 'linked-elsewhere' || phase.failure === 'collision'
                ? 'This identity can’t be used here'
                : phase.failure === 'inactive' ? 'This account can’t sign in' : 'Sign-in stopped'}
            </h1>
            {phase.failure === 'code' && (
              <Notice tone="error" title="This code can’t be used.">
                It’s invalid or was already used; each code works once and expires quickly. Start the CAS sign-in again.
              </Notice>
            )}
            {phase.failure === 'pricing' && (
              <Notice tone="error" title="Institutional sign-in is paused (503 · institutional_pricing_invalid).">
                The current pricing has no valid RESEARCH plan, so CAS accounts can’t be set up right now. You can still log in with a password.
              </Notice>
            )}
            {phase.failure === 'pricing-down' && (
              <Notice tone="error" title="The pricing service didn’t answer (503 · pricing_unavailable).">
                Your plan’s limits couldn’t be read, so the sign-in stopped before changing anything. Try again in a moment, or log in with a password.
              </Notice>
            )}
            {phase.failure === 'unavailable' && (
              <Notice tone="error" title="Institutional sign-in is unavailable right now (503).">
                The university’s sign-in or the pricing service didn’t answer. Nothing was changed on your account. You can still log in with a password.
              </Notice>
            )}
            {phase.failure === 'state' && (
              <Notice tone="error" title="This sign-in attempt has expired (cas_state_invalid).">
                The sign-in was started a while ago, was already used, or didn’t start from here. Nothing was changed. Start it again and finish it without delay.
              </Notice>
            )}
            {phase.failure === 'ticket' && (
              <Notice tone="error" title="The university didn’t accept this sign-in (cas_ticket_invalid).">
                Its ticket was missing or refused, which happens when the page is reloaded or the sign-in takes too long. Nothing was changed. Try again.
              </Notice>
            )}
            {phase.failure === 'inactive' && (
              <Notice tone="warning" title="This account is deactivated (account_inactive).">
                The account being signed in or linked is deactivated or no longer exists, so nothing was changed. If you think this is a mistake, ask an administrator to reactivate it.
              </Notice>
            )}
            {phase.failure === 'error' && (
              <Notice tone="error" title="The sign-in couldn’t be finished (cas_error).">
                Something went wrong on our side while finishing it. Nothing was changed. Try again; if it keeps failing, check the service status.
              </Notice>
            )}
            {phase.failure === 'linked-elsewhere' && (
              <Notice tone="warning" title="This identity is already linked to another account.">
                A CAS identity can belong to one OpenBinding account only. Log in to that account, or unlink it there first.
              </Notice>
            )}
            {phase.failure === 'collision' && (
              <Notice tone="warning" title="An account with these details already exists.">
                Log in to the existing account and link CAS from Account › Identities. Identities are never linked by email automatically.
              </Notice>
            )}
            <div className="auth-card-actions">
              <Link className="auth-btn auth-btn-primary" to="/login" viewTransition>Back to log in</Link>
              {RETRYABLE.has(phase.failure) && (linking
                ? <Link className="auth-btn auth-btn-secondary" to="/app/account/identities" viewTransition>Try again from Account › Identities</Link>
                : <a className="auth-btn auth-btn-secondary" href={apiClient.casStartUrl('login')} onClick={() => rememberCasFlow('login', flow?.returnTo)}>Try again</a>)}
              {phase.failure === 'linked-elsewhere' || phase.failure === 'collision'
                ? <Link className="auth-btn auth-btn-secondary" to="/app/account/identities" viewTransition>Go to Account › Identities</Link>
                : SERVICE.has(phase.failure) && <Link className="auth-btn auth-btn-secondary" to="/status" viewTransition>Service status</Link>}
            </div>
          </>
        )}

        {phase.name === 'success' && (
          <>
            <div className="auth-card-result" role="status">
              <span className="auth-check" aria-hidden="true"><Check /></span>
              <h1>{linking ? 'Identity linked' : 'You’re signed in'}</h1>
            </div>
            <p>
              {linking
                ? `Your ${INSTITUTION_NAME} identity is now linked${name ? ` to ${name}’s account` : ' to your account'}. You can unlink it from Account › Identities.`
                : institutional
                  ? `Welcome${name ? `, ${name}` : ''}. Your verified identity qualifies for RESEARCH under the current pricing.`
                  : `Welcome${name ? `, ${name}` : ''}. Your identity is verified. Your plan stays ${user?.plan ?? 'as it was'}; RESEARCH applies only when the pricing grants it.`}
            </p>
            {institutional && (
              <div className="auth-institution">
                <InstitutionMark variant="compact" />
                <div>
                  <strong>{INSTITUTION_NAME} · verified</strong>
                  <span>Your plan is {user?.plan ?? 'RESEARCH'}. This badge reflects your institution, not a role: it doesn’t give admin or organization permissions.</span>
                </div>
              </div>
            )}
            <div className="auth-card-actions">
              {linking ? (
                <>
                  <Link className="auth-btn auth-btn-primary" to="/app/account/identities" viewTransition>Back to my account</Link>
                  <Link className="auth-btn auth-btn-secondary" to="/app" viewTransition>Workspace</Link>
                </>
              ) : (
                <>
                  <Link className="auth-btn auth-btn-primary" to={workspace} viewTransition>Continue to your workspace</Link>
                  <Link className="auth-btn auth-btn-secondary" to="/app/account/identities" viewTransition>Account › Identities</Link>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
