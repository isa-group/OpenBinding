import { lazy, Suspense, useMemo, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { Check, ChevronDown, ChevronUp, FileText, Minus, MoveRight } from 'lucide-react';
import { Default, ErrorFallback, Feature, Loading, On } from 'space-react-client';
import { apiClient } from '../../api/client';
import { Action } from '../../components/ui/Action';
import { Chip } from '../../components/ui/Chip';
import { EmptyState } from '../../components/ui/EmptyState';
import { FilterPills } from '../../components/ui/FilterPills';
import { Modal } from '../../components/ui/Modal';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { useAuth } from '../../contexts/auth';
import { shortDigest } from '../../utils/digest';
import { formatDate } from '../../utils/format';
import { usePricingTokenStatus } from '../../utils/pricingToken';
import { safeExternalHref } from '../../utils/url';
import { useResource } from '../../utils/useResource';
import { classifyAuthError } from '../Auth/authErrors';
import { readCatalog, type Cell, type PlanColumn, type PricingView, type RowGroup } from './pricingModel';
import './Pricing.css';

const PricingDocument = lazy(() => import('./PricingDocument'));

/** Groups that start open: the first two feature groups and the monthly allowances. */
function openByDefault(groupId: string, index: number): boolean {
  return index < 2 || groupId === 'limit-monthly';
}

const GATE_COUNT: Record<number, string> = { 1: 'One', 2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five' };

const LIMIT_OUTCOMES = [
  {
    mark: 'Reduced',
    title: 'Budgets above your ceiling are lowered',
    body: 'A time budget or iteration count above your plan runs at the ceiling, with an OPTION_CLAMPED note showing requested and applied values.',
  },
  {
    mark: 'Wait',
    title: 'A plan allowance reached or busy slots',
    body: 'A plan allowance that is full (402) stays full until you free something or change plan. Busy job slots (429) free up in seconds.',
  },
  {
    mark: 'Rejected',
    title: 'The problem is too big for the plan',
    body: 'A binding space above your complexity ceiling can’t run in a smaller form. Reduce candidates or tasks, or ask for an agreement.',
  },
];

function CellView({ cell }: { cell: Cell }) {
  switch (cell.kind) {
    case 'yes':
      return <span className="pricing-cell-yes"><Check aria-hidden="true" />Included</span>;
    case 'no':
      return <span className="pricing-cell-no"><Minus aria-hidden="true" />Not included</span>;
    case 'addon':
      return <span className="pricing-cell-addon">With add-on</span>;
    case 'value':
      return (
        <>
          <span className="pricing-cell-value">{cell.text}</span>
          {cell.exact && <span className="pricing-cell-exact">{cell.exact}</span>}
        </>
      );
  }
}

function describeLoadFailure(error: unknown): string {
  const failure = classifyAuthError(error);
  if (failure.code === 'pricing_digest_mismatch' || failure.status === 502) {
    return 'The pricing document doesn’t match its recorded digest (502 · pricing_digest_mismatch), so it isn’t shown. Showing unverified plans could mislead you.';
  }
  if (failure.status === 503) {
    return 'Pricing can’t be loaded right now (503 · pricing_unavailable). The catalog is hidden rather than showing figures we can’t verify.';
  }
  if (failure.kind === 'network') return 'Pricing can’t be reached right now. Check your connection and try again.';
  return `Pricing couldn’t be loaded${failure.status ? ` (${failure.status})` : ''}. Try again in a moment.`;
}

function planCta(plan: PlanColumn, signedIn: boolean, current: boolean, onContact: (plan: string) => void) {
  if (current) return null;
  if (plan.byAgreement) return <Action variant="secondary" size="md" onClick={() => onContact(plan.id)}>Contact us</Action>;
  if (plan.id === 'RESEARCH') {
    return signedIn
      ? <Action variant="primary" to="/app/account/identities">Link CAS identity</Action>
      : <Action variant="primary" to="/login">Log in with CAS</Action>;
  }
  if (!signedIn && plan.priceLabel === 'Free') return <Action variant="primary" to="/register">Sign up</Action>;
  return null;
}

function Matrix({ view, highlight, plan }: { view: PricingView; highlight: string; plan: string | null }) {
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  const [contactPlan, setContactPlan] = useState<string | null>(null);
  const columns = view.plans.length;

  const isOpen = (group: RowGroup, index: number) => openByDefault(group.id, index) !== toggled.has(group.id);
  const toggle = (id: string) => setToggled((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const highlightIndex = highlight === 'all' ? -1 : view.plans.findIndex((item) => item.id === highlight);

  return (
    <>
      <div className="pricing-scroller">
        <div className="pricing-matrix" style={{ '--pricing-columns': columns } as CSSProperties}>
          <div className="pricing-plans" role="list" aria-label="Plans">
            <span aria-hidden="true" />
            {view.plans.map((item, index) => {
              const current = plan === item.id;
              return (
                <div key={item.id} role="listitem" className="pricing-plan">
                  <div className={`pricing-plan-tile is-tone-${index % 4}${highlightIndex === index ? ' is-picked' : ''}`}>
                    <span className="pricing-plan-name">{item.id}</span>
                    <span className="pricing-plan-price">{item.priceLabel}</span>
                    <span className="pricing-plan-unit">{item.unitLabel}</span>
                  </div>
                  <span className="pricing-plan-desc">{item.description}</span>
                  {current && <Chip tone="accent">Your current plan</Chip>}
                  {planCta(item, plan !== null, current, setContactPlan)}
                </div>
              );
            })}
          </div>

          {view.groups.map((group, groupIndex) => {
            const open = isOpen(group, groupIndex);
            const panelId = `pricing-group-${group.id}`;
            return (
              <section key={group.id} className="pricing-group">
                <h3>
                  <button type="button" aria-expanded={open} aria-controls={panelId} onClick={() => toggle(group.id)}>
                    <span>{group.title} <span className="pricing-group-note">· {group.note}</span></span>
                    {open ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
                  </button>
                </h3>
                {open && (
                  <table id={panelId} className="pricing-table">
                    <caption className="sr-only">{group.title}: {group.note}</caption>
                    <thead className="sr-only">
                      <tr>
                        <th scope="col">{group.title}</th>
                        {view.plans.map((item) => <th key={item.id} scope="col">{item.id}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {group.rows.map((row) => (
                        <tr key={row.id}>
                          <th scope="row">
                            <span className="pricing-row-name">
                              {row.name}
                            </span>
                            <span className="pricing-row-desc">{row.description}</span>
                            {row.appliesTo.length > 0 && (
                              <span className="pricing-affects">
                                Applies to{row.appliesTo.map((name) => <span key={name} className="pricing-affects-chip">{name}</span>)}
                              </span>
                            )}
                          </th>
                          {row.cells.map((cell, index) => (
                            <td key={view.plans[index].id} data-plan={view.plans[index].id} className={highlightIndex === index ? 'is-picked' : undefined} title={cell.kind === 'value' ? cell.exact : undefined}>
                              <CellView cell={cell} />
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>
            );
          })}
        </div>
      </div>
      {contactPlan && <ContactDialog plan={contactPlan} onClose={() => setContactPlan(null)} />}
    </>
  );
}

/**
 * Paid plans are arranged by agreement and there is no channel for it in this interface: the dialog says what
 * to bring and sends nothing. (There is no contact address in the deployment's configuration to point at.)
 */
function ContactDialog({ plan, onClose }: { plan: string; onClose: () => void }) {
  return (
    <Modal title={`Ask about ${plan}`} onClose={onClose}>
      <p>{plan} is arranged as an institutional agreement. An administrator updates your contract; nothing is charged here.</p>
      <ul className="pricing-contact-list">
        <li>Who it’s for: your organization or group</li>
        <li>What you need: concurrent jobs, studies, storage</li>
        <li>Add-ons you’d need</li>
      </ul>
      <p className="pricing-contact-note">This page doesn’t send anything. Take these details to the people who run this OpenBinding deployment, or to your institution’s administrator.</p>
      <div className="ui-modal-actions"><Action variant="primary" onClick={onClose} data-autofocus>Got it</Action></div>
    </Modal>
  );
}

function Entitlements({ view, plan }: { view: PricingView; plan: string }) {
  const token = usePricingTokenStatus();
  const note = token === 'valid'
    ? `Read from your signed pricing token for the ${plan} plan.`
    : 'We can’t confirm your features right now, so none is shown as enabled or disabled.';
  return (
    <section aria-labelledby="pricing-mine" className="pricing-mine">
      <div className="pricing-mine-head">
        <h2 id="pricing-mine">Available to your account</h2>
      </div>
      <p className="pricing-mine-note">{note}</p>
      <div className="pricing-mine-grid">
        {view.features.map((feature) => (
          <div key={feature.id} className="pricing-mine-item">
            <span>{feature.name}</span>
            <Feature id={`${view.saasName.toLowerCase()}-${feature.id}`}>
              <On><span className="pricing-state is-on">Enabled</span></On>
              <Default><span className="pricing-state">Not enabled</span></Default>
              <Loading><span className="pricing-state is-wait" aria-live="polite">Checking…</span></Loading>
              <ErrorFallback><span className="pricing-state is-unknown">Can’t confirm</span></ErrorFallback>
            </Feature>
          </div>
        ))}
      </div>
      <p className="pricing-mine-foot">
        <Link to="/app/account/usage" viewTransition>See your plan</Link>
        <span>These states only guide the interface. The server checks every action.</span>
      </p>
    </section>
  );
}

/** The plans, rendered from the same document the gateway serves and SPACE enforces. */
export function Pricing() {
  const { user } = useAuth();
  const catalog = useResource('pricing-catalog', () => apiClient.getPricingCatalog());
  const current = useResource('pricing-current', () => apiClient.getCurrentPricing());
  const [highlight, setHighlight] = useState('all');
  const [showDocument, setShowDocument] = useState(false);

  const view = useMemo(() => (catalog.data ? readCatalog(catalog.data) : null), [catalog.data]);
  const noRelease = current.status === 'error' && classifyAuthError(current.error).status === 404;
  const loading = catalog.status === 'loading' || current.status === 'loading';
  const failed = !noRelease && (catalog.status === 'error' || (catalog.status === 'ready' && view === null));
  const release = current.data;
  const plan = user?.plan ?? null;
  // Nothing about a pricing is announced while there is no live release to announce it for.
  const released = noRelease ? null : view;

  const pills = useMemo(() => [
    { id: 'all', label: 'Compare all' },
    ...(view?.plans ?? []).map((item) => ({ id: item.id, label: item.id })),
  ], [view]);

  const withoutAddOns = (view?.plans ?? []).filter((item) => !(view?.addOns ?? []).some((addOn) => addOn.plans.includes(item.id))).map((item) => item.id);

  const retry = () => { catalog.reload(); current.reload(); };

  return (
    <div className="pricing-page">
      <header className="pricing-head">
        <h1>Plans for every kind of binding work</h1>
        <p>
          Start free. Research accounts are free with a verified Universidad de Sevilla identity. Larger capacity
          is arranged by institutional agreement; there’s no checkout.
        </p>
        {released && (
          <div className="pricing-chips">
            <Chip>Pricing version <span className="pricing-mono">{released.version}</span></Chip>
            {formatDate(released.createdAt) && <Chip>Published {formatDate(released.createdAt)}</Chip>}
            {released.currency && <Chip>{released.currency}{released.periods ? ` · ${released.periods}` : ''}</Chip>}
            {release?.digest && <span title={release.digest}><Chip>Fingerprint {shortDigest(release.digest)}</Chip></span>}
          </div>
        )}
      </header>

      {released?.developmentCopy && (
        <Notice tone="warning" title="Development pricing.">
          These figures come from the {released.version} development copy and aren’t verified against the live pricing. If they differ, the live release applies.
        </Notice>
      )}

      <div aria-live="polite" aria-busy={loading} className="pricing-body">
        {loading && (
          <>
            <div className="pricing-skeleton-row"><Skeleton variant="card" /><Skeleton variant="card" /><Skeleton variant="card" /><Skeleton variant="card" /></div>
            <Skeleton variant="panel" />
          </>
        )}

        {!loading && noRelease && (
          <EmptyState icon={<FileText />} title="No public pricing release is live">
            There’s no live pricing to show right now (404). Accounts keep the plan they already have.
          </EmptyState>
        )}

        {!loading && failed && (
          <Notice tone="error" action={<Action variant="secondary" size="sm" onClick={retry}>Retry</Action>}>
            {catalog.status === 'error' ? describeLoadFailure(catalog.error) : 'The pricing document has no plans to show.'}
          </Notice>
        )}

        {!loading && !noRelease && !failed && view && catalog.data && (
          <>
            <h2 className="sr-only">Compare plans</h2>
            <FilterPills options={pills} value={highlight} onChange={setHighlight} ariaLabel="Highlight a plan" />
            <Matrix view={view} highlight={highlight} plan={plan} />
            <p className="pricing-legend">
              Rounded figures show the exact value underneath. Monthly limits renew each month; capacity limits are freed when
              work finishes; per-request ceilings apply to each job. Sponsored limits count across every organization a sponsor backs.
            </p>

            {view.gates.length > 0 && (
              <section aria-labelledby="pricing-gates" className="pricing-section">
                <h2 id="pricing-gates">What has to have room before you start</h2>
                <p>
                  {GATE_COUNT[view.gates.length] ?? view.gates.length} {view.gates.length === 1 ? 'feature also checks' : 'features also check'} your
                  limits each time you start something. Everything else only needs to be included in your plan.
                </p>
                <div className="pricing-gates">
                  {view.gates.map((gate) => (
                    <div key={gate.starts} className="pricing-gate">
                      <span className="pricing-gate-title"><span aria-hidden="true"><MoveRight /></span>Start {gate.starts}</span>
                      <span className="pricing-gate-lead">Needs all of:</span>
                      <ul>
                        {gate.needs.map((need) => <li key={need}><Check aria-hidden="true" />{need}</li>)}
                      </ul>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {user && <Entitlements view={view} plan={user.plan} />}

            {view.addOns.length > 0 && (
              <section aria-labelledby="pricing-addons" className="pricing-section">
                <h2 id="pricing-addons" className="pricing-section-center">Add-ons</h2>
                <p className="pricing-section-center">
                  Arranged under an agreement, in whole packs.
                  {withoutAddOns.length > 0 && ` ${withoutAddOns.join(' and ')} ${withoutAddOns.length === 1 ? 'has' : 'have'} no add-ons.`}
                </p>
                <div className="pricing-addons">
                  {view.addOns.map((addOn) => {
                    const available = user ? addOn.plans.includes(user.plan) : null;
                    return (
                      <article key={addOn.id} className="pricing-addon">
                        <div className="pricing-addon-head">
                          <span className="pricing-addon-initial" aria-hidden="true">{addOn.initial}</span>
                          <span className="pricing-addon-id">{addOn.id}</span>
                          <span className="pricing-contact-pill">Contact us</span>
                        </div>
                        <span className="pricing-addon-effect">{addOn.effect}</span>
                        <span className="pricing-addon-meta">For {addOn.plans.join(', ')} · {addOn.quantity} · per {addOn.per}</span>
                        {available !== null && (
                          <span className={`pricing-state pricing-addon-mine${available ? ' is-on' : ''}`}>
                            {available ? 'Available under agreement' : 'Not available on your plan'}
                          </span>
                        )}
                      </article>
                    );
                  })}
                </div>
              </section>
            )}

            <section aria-labelledby="pricing-limits" className="pricing-section">
              <h2 id="pricing-limits">What happens when you reach a limit</h2>
              <div className="pricing-outcomes">
                {LIMIT_OUTCOMES.map((outcome) => (
                  <div key={outcome.mark} className="pricing-outcome">
                    <span className="pricing-outcome-mark">{outcome.mark}</span>
                    <strong>{outcome.title}</strong>
                    <span>{outcome.body}</span>
                  </div>
                ))}
              </div>
              {user && <Link to="/app/system/states" viewTransition>See every state in the gallery</Link>}
            </section>

            {view.researchDescription !== null && (
              <section className="pricing-research" aria-label="RESEARCH for Universidad de Sevilla">
                <span className="pricing-research-tile" aria-hidden="true">US</span>
                <div>
                  <strong>RESEARCH for Universidad de Sevilla</strong>
                  <p>
                    Free for accounts with a verified CAS identity. It’s a plan, not a role: it doesn’t make you an admin or change
                    your organization roles. Unlinking the identity can move you back to BASIC.
                  </p>
                </div>
                <Action variant="primary" to={user ? '/app/account/identities' : '/login'}>{user ? 'Manage identities' : 'Log in with CAS'}</Action>
              </section>
            )}

            <section className="pricing-document" aria-label="Full pricing document">
              <Action variant="secondary" size="sm" onClick={() => setShowDocument((open) => !open)} aria-expanded={showDocument} aria-controls="pricing-document-body">
                {showDocument ? 'Hide the full pricing document' : 'Show the full pricing document'}
              </Action>
              <p>
                The same document drawn by <code>pricing-renderer</code>.
                {safeExternalHref(release?.url) && <> Published in <a href={safeExternalHref(release?.url)} target="_blank" rel="noopener noreferrer">SPHERE</a>; enforced by{' '}
                  <a href="https://github.com/isa-group/space" target="_blank" rel="noopener noreferrer">SPACE</a>.</>}
              </p>
              <div id="pricing-document-body">
                {showDocument && (
                  <Suspense fallback={<Skeleton variant="panel" />}>
                    <PricingDocument catalog={catalog.data} />
                  </Suspense>
                )}
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
