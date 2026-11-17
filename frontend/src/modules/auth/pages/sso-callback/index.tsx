// Adapted from SPHERE frontend/src/modules/auth/pages/sso-callback/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's CAS return on the auth layout: the gateway's closed list of `?error=` codes, each named with what to do
// next; the one-time code is exchanged once however often the screen is mounted, and the plan change it reports is kept for
// the next screen; the linking flow returns to Settings › Sign-in & Security; the result is shown, not navigated past.

import { motion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { FiCheck } from 'react-icons/fi';
import { Link, useLocation } from 'react-router-dom';
import { InstitutionMark } from '../../components/institution-mark';
import {
  INSTITUTION_NAME,
  useInstitutionalBranding,
} from '../../components/institution-mark/institution';
import {
  casFlowFor,
  exchangeCasOnce,
  forgetCasFlow,
  notePlanChanged,
  rememberCasFlow,
  type CasMode,
} from '../../utils/authFlow';
import { classifyAuthError } from '../../../core/api/errors';
import { Notice } from '../../../core/components/notice';
import ServiceStatus from '../../../presentation/components/service-status';
import { AuthSpinner } from '../../components/auth-field';
import AuthLayout from '../../components/auth-layout';
import { fadeUp } from '../../components/auth-layout/variants';
import { useAuth } from '../../hooks/useAuth';
import { ICON_TILE, LEDE, PRIMARY_ACTION, SECONDARY_ACTION, TITLE } from '../../utils/classes';
import { accountClient } from '../../api/accountClient';

/** Where the CAS identity of an account is linked and unlinked. */
const SIGN_IN_SECURITY = '/me/settings?section=integrations';
const SIGN_IN_SECURITY_NAME = 'Settings › Sign-in & Security';

/**
 * What stopped the CAS round trip. The gateway answers every failure of its own callback step with `?error=<code>` (a closed list,
 * so nothing from the address is ever shown) and some on the code exchange; both end here.
 */
type CasFailure =
  | 'code'
  | 'unavailable'
  | 'pricing'
  | 'pricing-down'
  | 'state'
  | 'ticket'
  | 'inactive'
  | 'error'
  | 'linked-elsewhere'
  | 'collision'
  | 'username';

type Phase =
  | { name: 'loading' }
  | { name: 'empty' }
  | { name: 'error'; failure: CasFailure }
  | { name: 'success' };

/** The `?error=` codes of the callback (docs/ACCOUNTS_AND_PLANS.md), and what each one means for the person. */
const REPORTED = new Map<string, CasFailure>([
  ['cas_unavailable', 'unavailable'],
  ['cas_state_invalid', 'state'],
  ['cas_ticket_invalid', 'ticket'],
  ['account_inactive', 'inactive'],
  ['identity_in_use', 'linked-elsewhere'],
  ['account_collision', 'collision'],
  ['username_unavailable', 'username'],
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
const RETRYABLE = new Set<CasFailure>([
  'code',
  'unavailable',
  'pricing-down',
  'state',
  'ticket',
  'error',
]);
/** Failures that say something about the service rather than about the person. */
const SERVICE = new Set<CasFailure>(['code', 'unavailable', 'pricing', 'pricing-down', 'error']);

/** `/sso/callback`: lands here from the university's sign-in, exchanges the one-time code for a session, or explains why it cannot. */
export default function SsoCallbackPage() {
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
  const mode: CasMode = params.get('mode') === 'link' ? 'link' : (flow?.mode ?? 'login');
  const [phase, setPhase] = useState<Phase>(() => {
    if (code) return { name: 'loading' };
    return reported
      ? { name: 'error', failure: failureFor(reported, undefined) }
      : { name: 'empty' };
  });

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    // One-time memory: whatever happens next, the next CAS round trip starts from a clean slate.
    forgetCasFlow();
    if (!code) return;
    // Linking CAS raises FREE to RESEARCH at no cost. The exchange says so; the redirect's `plan_changed` is the same news a step earlier.
    void exchangeCasOnce(code, () =>
      accountClient.exchangeCasCode(code).then(change => {
        if (change)
          notePlanChanged({ from: change.from, to: change.to, extraCost: change.extra_cost });
        else if (announced) notePlanChanged({ to: announced, extraCost: false });
        return refresh();
      })
    )
      .then(() => setPhase({ name: 'success' }))
      .catch((caught: unknown) => {
        const result = classifyAuthError(caught);
        setPhase({ name: 'error', failure: failureFor(result.code, result.status) });
      });
  }, [code, announced, refresh]);

  const linking = mode === 'link';
  const workspace = (!linking && flow?.returnTo) || '/';
  const modeLabel = linking ? 'link identity' : 'log in';
  const name = user?.username;

  return (
    <AuthLayout backTo="/authentication">
      <Helmet>
        <title>OpenBinding - Signing in</title>
      </Helmet>
      <div className="flex flex-col" aria-live="polite">
        <motion.p
          variants={fadeUp}
          className="mb-4 text-xs font-medium tracking-[0.18em] text-tp-steel uppercase"
        >
          {INSTITUTION_NAME} · CAS · {modeLabel}
        </motion.p>

        {phase.name === 'loading' && (
          <div className="flex items-start gap-3" role="status">
            <span className="mt-2 text-tp-accent">
              <AuthSpinner />
            </span>
            <div>
              <h1 className={TITLE}>Finishing sign-in…</h1>
              <p className={LEDE}>Exchanging the one-time code from CAS for your session.</p>
            </div>
          </div>
        )}

        {phase.name === 'empty' && (
          <>
            <h1 className={TITLE}>There’s no code to finish sign-in</h1>
            <p className={LEDE}>
              This page is opened by the {INSTITUTION_NAME} sign-in. Without its one-time code
              there’s nothing to exchange. Start again from the log in page.
            </p>
            <div className="mt-7 flex flex-col gap-3">
              <Link className={PRIMARY_ACTION} to="/authentication" viewTransition>
                Back to log in
              </Link>
            </div>
          </>
        )}

        {phase.name === 'error' && (
          <>
            <h1 className={TITLE}>
              {phase.failure === 'linked-elsewhere' ||
              phase.failure === 'collision' ||
              phase.failure === 'username'
                ? 'This identity can’t be used here'
                : phase.failure === 'inactive'
                  ? 'This account can’t sign in'
                  : 'Sign-in stopped'}
            </h1>
            <div className="mt-5">
              {phase.failure === 'code' && (
                <Notice tone="error" title="This code can’t be used.">
                  It’s invalid or was already used; each code works once and expires quickly. Start
                  the CAS sign-in again.
                </Notice>
              )}
              {phase.failure === 'pricing' && (
                <Notice
                  tone="error"
                  title="Institutional sign-in is paused (503 · institutional_pricing_invalid)."
                >
                  The current pricing has no valid RESEARCH plan, so CAS accounts can’t be set up
                  right now. You can still log in with a password.
                </Notice>
              )}
              {phase.failure === 'pricing-down' && (
                <Notice
                  tone="error"
                  title="The pricing service didn’t answer (503 · pricing_unavailable)."
                >
                  Your plan’s limits couldn’t be read, so the sign-in stopped before changing
                  anything. Try again in a moment, or log in with a password.
                </Notice>
              )}
              {phase.failure === 'unavailable' && (
                <Notice tone="error" title="Institutional sign-in is unavailable right now (503).">
                  The university’s sign-in or the pricing service didn’t answer. Nothing was changed
                  on your account. You can still log in with a password.
                </Notice>
              )}
              {phase.failure === 'state' && (
                <Notice tone="error" title="This sign-in attempt has expired (cas_state_invalid).">
                  The sign-in was started a while ago, was already used, or didn’t start from here.
                  Nothing was changed. Start it again and finish it without delay.
                </Notice>
              )}
              {phase.failure === 'ticket' && (
                <Notice
                  tone="error"
                  title="The university didn’t accept this sign-in (cas_ticket_invalid)."
                >
                  Its ticket was missing or refused, which happens when the page is reloaded or the
                  sign-in takes too long. Nothing was changed. Try again.
                </Notice>
              )}
              {phase.failure === 'inactive' && (
                <Notice tone="warning" title="This account is deactivated (account_inactive).">
                  The account being signed in or linked is deactivated or no longer exists, so
                  nothing was changed. If you think this is a mistake, ask an administrator to
                  reactivate it.
                </Notice>
              )}
              {phase.failure === 'error' && (
                <Notice tone="error" title="The sign-in couldn’t be finished (cas_error).">
                  Something went wrong on our side while finishing it. Nothing was changed. Try
                  again; if it keeps failing, check the service status.
                </Notice>
              )}
              {phase.failure === 'linked-elsewhere' && (
                <Notice tone="warning" title="This identity is already linked to another account.">
                  A CAS identity can belong to one OpenBinding account only. Log in to that account,
                  or unlink it there first.
                </Notice>
              )}
              {phase.failure === 'collision' && (
                <Notice tone="warning" title="An account with these details already exists.">
                  Log in to the existing account and link CAS from {SIGN_IN_SECURITY_NAME}.
                  Identities are never linked by email automatically.
                </Notice>
              )}
              {phase.failure === 'username' && (
                <Notice
                  tone="warning"
                  title="Your university username is reserved here (username_unavailable)."
                >
                  An OpenBinding account can’t take this name: it names engines published under it,
                  or belonged to an account that was deleted. Signing in again won’t change that.
                  Create an account with a password and another username, then link CAS from{' '}
                  {SIGN_IN_SECURITY_NAME}, or contact the administrator.
                </Notice>
              )}
            </div>
            <div className="mt-7 flex flex-col gap-3">
              <Link className={PRIMARY_ACTION} to="/authentication" viewTransition>
                Back to log in
              </Link>
              {RETRYABLE.has(phase.failure) &&
                (linking ? (
                  <Link className={SECONDARY_ACTION} to={SIGN_IN_SECURITY} viewTransition>
                    Try again from {SIGN_IN_SECURITY_NAME}
                  </Link>
                ) : (
                  <a
                    className={SECONDARY_ACTION}
                    href={accountClient.casStartUrl('login')}
                    onClick={() => rememberCasFlow('login', flow?.returnTo)}
                  >
                    Try again
                  </a>
                ))}
              {phase.failure === 'linked-elsewhere' || phase.failure === 'collision' ? (
                <Link className={SECONDARY_ACTION} to={SIGN_IN_SECURITY} viewTransition>
                  Go to {SIGN_IN_SECURITY_NAME}
                </Link>
              ) : (
                SERVICE.has(phase.failure) && <ServiceStatus className="text-tp-slate" />
              )}
            </div>
          </>
        )}

        {phase.name === 'success' && (
          <>
            <div role="status">
              <div className={ICON_TILE} aria-hidden="true">
                <FiCheck className="h-7 w-7 text-emerald-600" />
              </div>
              <h1 className={TITLE}>{linking ? 'Identity linked' : 'You’re signed in'}</h1>
            </div>
            <p className={LEDE}>
              {linking
                ? `Your ${INSTITUTION_NAME} identity is now linked${name ? ` to ${name}’s account` : ' to your account'}. You can unlink it from ${SIGN_IN_SECURITY_NAME}.`
                : institutional
                  ? `Welcome${name ? `, ${name}` : ''}. Your verified identity qualifies for RESEARCH under the current pricing.`
                  : `Welcome${name ? `, ${name}` : ''}. Your identity is verified. Your plan stays ${user?.plan ?? 'as it was'}; RESEARCH applies only when the pricing grants it.`}
            </p>
            {institutional && (
              <div
                className="mt-5 flex items-start gap-3 rounded-lg border border-tp-hairline-soft bg-tp-surface px-4 py-3"
                data-testid="institution-verified"
              >
                <InstitutionMark variant="compact" />
                <div className="flex flex-col gap-0.5 text-sm">
                  <strong className="font-semibold text-tp-ink">
                    {INSTITUTION_NAME} · verified
                  </strong>
                  <span className="text-tp-steel">
                    Your plan is {user?.plan ?? 'RESEARCH'}. This badge reflects your institution,
                    not a role: it doesn’t give admin or organization permissions.
                  </span>
                </div>
              </div>
            )}
            <div className="mt-7 flex flex-col gap-3">
              {linking ? (
                <>
                  <Link className={PRIMARY_ACTION} to={SIGN_IN_SECURITY} viewTransition>
                    Back to {SIGN_IN_SECURITY_NAME}
                  </Link>
                  <Link className={SECONDARY_ACTION} to="/" viewTransition>
                    Workspace
                  </Link>
                </>
              ) : (
                <>
                  <Link className={PRIMARY_ACTION} to={workspace} viewTransition>
                    Continue to your workspace
                  </Link>
                  <Link className={SECONDARY_ACTION} to={SIGN_IN_SECURITY} viewTransition>
                    {SIGN_IN_SECURITY_NAME}
                  </Link>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </AuthLayout>
  );
}
