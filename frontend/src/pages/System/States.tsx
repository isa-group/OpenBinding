import { useCallback, useEffect, useRef, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import type { LimitUsage } from '../../api/auth';
import type { PlatformOutletContext } from '../../components/PlatformShell/PlatformShell';
import { QuotaBar } from '../../components/QuotaBar';
import { Chip } from '../../components/ui/Chip';
import { ErrorState, StateAction } from '../../components/ui/ErrorState';
import { FilterPills } from '../../components/ui/FilterPills';
import { PageHeader } from '../../components/ui/PageHeader';
import { formatDate } from '../../utils/format';
import './States.css';

type Family = 'all' | 'session' | 'permission' | 'quota' | 'availability' | 'warnings';

const FAMILIES = [
  { id: 'all', label: 'All' },
  { id: 'session', label: 'Session' },
  { id: 'permission', label: 'Permission & privacy' },
  { id: 'quota', label: 'Quota' },
  { id: 'availability', label: 'Busy & unavailable' },
  { id: 'warnings', label: 'Warnings & dates' },
] as const;

type TokenState = 'absent' | 'loading' | 'present' | 'expired';

const TOKEN_STATES: Record<TokenState, { label: string; verdict: string; text: string }> = {
  absent: {
    label: 'Absent',
    verdict: 'can’t confirm',
    text: 'No pricing token yet. We don’t say what your plan allows; actions stay available and the server decides.',
  },
  loading: {
    label: 'Loading',
    verdict: 'checking…',
    text: 'Checking your plan features. Nothing is enabled or blocked on stale data meanwhile.',
  },
  present: {
    label: 'Present',
    verdict: 'confirmed',
    text: 'Features shown come from a signed token. They only guide the interface; the server still checks every action and your real balance.',
  },
  expired: {
    label: 'Expired',
    verdict: 'can’t confirm',
    text: 'The token expired. We hide the feature states until a fresh one arrives instead of trusting old data.',
  },
};

const ANATOMY = [
  {
    title: 'Busy job slots (429)',
    format: 'Format used by most routes',
    rows: [
      ['Error name', 'Headline: “All your job slots are busy”'],
      ['Status 429', 'Code chip “429”'],
      ['Explanation', 'Body text'],
      ['Limit 1 · used 1', 'Gauge: 1 of 1 slots'],
      ['Retry after 15 s', 'Countdown and Retry button'],
    ],
  },
  {
    title: 'Monthly quota used up (402)',
    format: 'Format used by the remaining routes',
    rows: [
      ['Error code', 'Headline: “You’ve used this month’s study runs”'],
      ['Message', 'Body text'],
      ['Limit 10 · used 10', 'Gauge: 10 of 10 study runs'],
      ['Unit run/month', 'Gauge label'],
      ['Renews on a date', 'Renewal date under the gauge'],
    ],
  },
] as const;

/** First day of next month, 00:00 UTC: the example renewal date of the quota card. */
function nextRenewal(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/**
 * Reference gallery of the platform's states and recoverable errors: what each failure says, what it
 * shows and where it sends the person. The cards use the same ErrorState component as the screens.
 * The figures (limits, names, dates) are examples; nothing here calls the API.
 */
export function States() {
  const platform = useOutletContext<PlatformOutletContext | undefined>();
  const [family, setFamily] = useState<Family>('all');
  const [token, setToken] = useState<TokenState>('absent');
  const [checking, setChecking] = useState(false);
  const [now] = useState(() => new Date());
  const checkTimer = useRef<number | undefined>(undefined);
  const stopChecking = useCallback(() => window.clearTimeout(checkTimer.current), []);

  useEffect(() => stopChecking, [stopChecking]);

  const shows = (id: Exclude<Family, 'all'>) => family === 'all' || family === id;
  const organization = platform?.organization;
  const orgName = organization?.name ?? 'your organization';
  const role = organization?.effective_role ?? 'MEMBER';
  const membersPath = organization ? `/app/${organization.slug}/settings/members` : '/app';

  const renewal = nextRenewal(now);
  const daysToRenew = Math.max(0, Math.ceil((renewal.getTime() - now.getTime()) / 86_400_000));
  const studyRuns: LimitUsage = {
    limit_id: 'studyRuns', limit: 10, used: 10, remaining: 0, unit: 'run/month', renews_at: renewal.toISOString(),
  };

  const tryAgain = () => {
    setChecking(true);
    stopChecking();
    checkTimer.current = window.setTimeout(() => setChecking(false), 1200);
  };

  return (
    <div className="states-page">
      <PageHeader
        eyebrow="System"
        title="States and recoverable errors"
        lede="Every action can fail even when the screen allowed it. These are the messages the platform reuses, each with what happened and how to recover. Two error shapes come from the API (problem+json and detail objects); the screens show them the same way. Names, limits and dates below are examples."
      />

      <FilterPills options={FAMILIES} value={family} onChange={(id) => setFamily(id as Family)} ariaLabel="Filter states" />

      <div className="states-grid">
        {shows('session') && (
          <ErrorState variant="401" code="unauthorized · invalid_token" />
        )}

        {shows('permission') && (
          <>
            <ErrorState
              variant="403"
              code="organization_forbidden"
              title={`This needs ADMIN in ${orgName}`}
              details={(
                <span className="states-chips">
                  <Chip>Needed · ADMIN</Chip>
                  <Chip>Yours · {role}</Chip>
                </span>
              )}
              actions={<StateAction tone="link" to={membersPath}>See who manages this organization</StateAction>}
            >
              Your effective role there is lower than the one this needs. Ask an owner or admin to change your role. Your plan and your CAS identity don’t change roles.
            </ErrorState>
            <ErrorState
              variant="403"
              code="insufficient_api_key_permission"
              title="This API key can’t do that"
              details={<span className="states-chips"><span className="states-missing">missing · engines:execute</span></span>}
              actions={<StateAction tone="link" to="/app/account/keys/new">Create a key with this permission</StateAction>}
            >
              The request needs <code>engines:execute</code>, which this key doesn’t include. A key can never exceed its account; create a key with the permission instead.
            </ErrorState>
            <ErrorState
              variant="403"
              code="feature_not_entitled"
              title="Your plan doesn’t include this"
              actions={(
                <>
                  <StateAction to="/pricing">Compare plans</StateAction>
                  <StateAction to="/pricing">Request an agreement</StateAction>
                </>
              )}
            >
              Retrying won’t help. Paid plans are arranged by agreement; there’s no checkout.
            </ErrorState>
            <ErrorState
              variant="404"
              code="not_found"
              title="Job not found"
              actions={<StateAction tone="link" to="/app/jobs">Go to my jobs</StateAction>}
            />
          </>
        )}

        {shows('quota') && (
          <>
            <ErrorState
              variant="402"
              code="quota_exceeded · studyRuns"
              title="You’ve used all your study runs for this month"
              details={<QuotaBar limit={studyRuns} />}
            >
              Renews {formatDate(renewal.toISOString())} (in {daysToRenew} {daysToRenew === 1 ? 'day' : 'days'}). Reducing the time budget doesn’t help here: it’s the number of study runs that ran out.
            </ErrorState>
            <ErrorState
              variant="402"
              code="sponsor_quota_exceeded · members"
              title="The sponsor can’t add more members"
              actions={(
                <>
                  <StateAction tone="link" to={membersPath}>Free up a seat</StateAction>
                  <StateAction tone="link" to="/pricing">Contact about a larger agreement</StateAction>
                </>
              )}
            >
              Members are counted once across every organization the sponsor pays for. The sponsor only pays for usage; it doesn’t grant any authority.
            </ErrorState>
            <ErrorState
              variant="402"
              code="instance_complexity_too_large"
              title="This problem is bigger than your plan allows"
              actions={<StateAction tone="link" to="/app">Open my workspace</StateAction>}
            >
              Your plan accepts binding spaces up to a fixed number of combinations. There’s no smaller version to run: reduce candidates or tasks, or ask for an agreement. The measured size is shown only when the API returns it.
            </ErrorState>
          </>
        )}

        {shows('availability') && (
          <>
            <ErrorState
              variant="429"
              code="concurrency_limit_exceeded · Retry-After 15"
              retryAfter={15}
              onRetry={() => undefined}
              actions={<StateAction tone="link" to="/app/jobs">View the running job</StateAction>}
            >
              You have 1 of 1 concurrent jobs running. If a monthly quota were also exhausted you’d see the 402 instead, because waiting wouldn’t help.
            </ErrorState>
            <ErrorState
              variant="503"
              code="pricing_unavailable"
              title="We can’t check your quota right now"
              onRetry={tryAgain}
              checking={checking}
            >
              The pricing service didn’t answer. This says nothing about your balance: you haven’t run out. Try again in a moment; nothing retries automatically.
            </ErrorState>
          </>
        )}

        {shows('warnings') && (
          <>
            <ErrorState
              status="OPTION_CLAMPED"
              tone="warning"
              code="warning, not an error"
              title="Your job ran with a smaller budget"
              details={(
                <table className="states-table">
                  <caption className="sr-only">Options that were reduced to the plan’s ceiling</caption>
                  <thead>
                    <tr><th scope="col">Option</th><th scope="col">Requested</th><th scope="col">Applied</th><th scope="col">Unit</th></tr>
                  </thead>
                  <tbody>
                    <tr><th scope="row"><code>iterations</code></th><td>100,000</td><td><strong>10,000</strong></td><td>iteration</td></tr>
                  </tbody>
                </table>
              )}
              actions={null}
            >
              The plan’s ceiling for this option applied. The job was created; its result says it used the reduced budget.
            </ErrorState>
            <ErrorState
              status="token"
              code="plan features shown in the browser"
              title={`Plan features: ${TOKEN_STATES[token].verdict}`}
              details={(
                <FilterPills
                  ariaLabel="Token state"
                  value={token}
                  onChange={(id) => setToken(id as TokenState)}
                  options={(Object.keys(TOKEN_STATES) as TokenState[]).map((id) => ({ id, label: TOKEN_STATES[id].label }))}
                />
              )}
              actions={null}
            >
              {TOKEN_STATES[token].text}
            </ErrorState>
            <ErrorState status="dates" code="expiry and renewal" title="Things that expire or renew" actions={null}>
              <span className="states-dates">
                <span><strong>API key</strong> · stops working on its expiry date. Rotate or create a new one.</span>
                <span><strong>Invitation</strong> · valid for 7 days from the day it is created, and works once.</span>
                <span><strong>Plan contract</strong> · renews on the date your usage page shows. A new pricing version applies when it renews.</span>
                <span><strong>Contract pending</strong> · if pricing was down at sign-up, your plan is settled on your next visit.</span>
              </span>
            </ErrorState>
          </>
        )}
      </div>

      <section className="states-anatomy" aria-labelledby="states-anatomy-title">
        <h2 id="states-anatomy-title">How an error becomes a message</h2>
        <p>
          The platform answers errors in two formats. Both are turned into the same kind of message, so people never see the raw answer.
          Left: what the answer carries. Right: where it shows.
        </p>
        <div className="states-anatomy-grid">
          {ANATOMY.map((card) => (
            <article key={card.title} className="states-anatomy-card">
              <strong>{card.title}</strong>
              <span>{card.format}</span>
              <ul>
                {card.rows.map(([from, to]) => (
                  <li key={from}>
                    <span className="states-from">{from}</span>
                    <span className="states-arrow"><span aria-hidden="true">→</span><span className="sr-only"> is shown as </span></span>
                    <span className="states-to">{to}</span>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
