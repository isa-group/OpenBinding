import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowRight, ArrowUpRight, Boxes, Braces, Check, Info, Network, Search, ServerCog, ShieldCheck, User, Waypoints } from 'lucide-react';
import { Link } from 'react-router-dom';
import { apiClient, HttpError, SESSION_ENDED_EVENT } from '../../api/client';
import { platformApi } from '../../api/platform';
import { Button } from '../../components/ui/Button';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { PRICING_VERSION, planSummaries } from '../../content/plans';
import { useAuth } from '../../contexts/auth';
import { useResource, type Resource } from '../../utils/useResource';
import { projectItems, publicationItems } from '../Public/exploreModel';
import {
  COMPATIBILITY_GATE, EXTENSION_ROUTES, LAYERS, PIPELINE, WORKFLOW_OPTIONS, type WorkflowOption,
} from './homeContent';
import './Home.css';

const RECENT_LIMIT = 3;

function Eyebrow({ children }: { children: string }) {
  return <span className="home-eyebrow">{children}</span>;
}

interface RuntimeCounts {
  profiles: number;
  dialects: number;
  engines: number;
}

export function Home() {
  const { user } = useAuth();
  const signedIn = Boolean(user);
  const [sessionEnded, setSessionEnded] = useState(false);
  const runtime = useResource<RuntimeCounts>(`runtime:${signedIn}`, async () => {
    const [profiles, dialects, engines] = await Promise.all([
      apiClient.getProfiles(),
      apiClient.getDialects(),
      // The full catalogue is for accounts; visitors get the public one.
      signedIn ? apiClient.getEngines() : apiClient.getPublicEngines(),
    ]);
    return { profiles: profiles.length, dialects: dialects.length, engines: engines.length };
  });

  useEffect(() => {
    // The client announces a session that ended without being asked to; this page then reads as a visitor's.
    const onEnded = () => setSessionEnded(true);
    window.addEventListener(SESSION_ENDED_EVENT, onEnded);
    return () => window.removeEventListener(SESSION_ENDED_EVENT, onEnded);
  }, []);

  return (
    <div className="home-page">
      <div className="home-glow home-glow-left" aria-hidden="true" />
      <div className="home-glow home-glow-right" aria-hidden="true" />
      <div className="home-inner">
        {sessionEnded && !signedIn && (
          <Notice tone="info" action={<Link to="/login">Log in again</Link>}>
            Your session expired, so you’re browsing as a visitor. Nothing private is shown on this page.
          </Notice>
        )}
        <Hero signedIn={signedIn} name={user?.username ?? ''} plan={user?.plan ?? ''} runtime={runtime} />
        <Pipeline />
        <RecentlyPublic />
        <Plans />
        <ExtendingBim executableProfiles={runtime.data?.profiles ?? 0} />
      </div>
    </div>
  );
}

function Hero({ signedIn, name, plan, runtime }: { signedIn: boolean; name: string; plan: string; runtime: Resource<RuntimeCounts> }) {
  const counts = runtime.data;

  return (
    <section aria-labelledby="home-hero-title" className="home-hero">
      <Eyebrow>BIM v1 · deterministic QoS binding</Eyebrow>
      <h1 id="home-hero-title">
        <span>Describe.</span>{' '}
        <span>Bind.</span>{' '}
        <span>Reproduce.</span>
      </h1>
      <p className="home-lede">
        OpenBinding validates BIM v1 service-composition packages, compiles them into a binding problem and re-evaluates every
        binding an engine returns, so results can be compared, published and verified by digest.
      </p>
      <div className="home-cards">
        <Link to="/workbench" viewTransition className="home-card">
          <span className="home-card-top"><span className="home-card-icon"><Check aria-hidden="true" /></span><span className="home-card-go is-filled" aria-hidden="true">↗</span></span>
          <strong>Validate a package</strong>
          <span>No account needed. Upload a .bim.zip and get localized diagnostics and digests. Nothing is executed.</span>
        </Link>
        <Link to="/explore" viewTransition className="home-card">
          <span className="home-card-top"><span className="home-card-icon"><Search aria-hidden="true" /></span><span className="home-card-go" aria-hidden="true">↗</span></span>
          <strong>Explore published results</strong>
          <span>Public projects, frozen report editions and engines, each one verifiable by its SHA-256 digest.</span>
        </Link>
        {signedIn ? (
          <Link to="/app" viewTransition className="home-card is-accent">
            <span className="home-card-top"><span className="home-card-icon is-round">{name.slice(0, 2).toUpperCase()}</span><span className="home-card-go is-filled" aria-hidden="true">↗</span></span>
            <strong>Go to your workspace</strong>
            <span>Signed in as {name} · {plan} plan. Organizations, projects and jobs live there.</span>
          </Link>
        ) : (
          <Link to="/register" viewTransition className="home-card is-accent">
            <span className="home-card-top"><span className="home-card-icon"><User aria-hidden="true" /></span><span className="home-card-go is-filled" aria-hidden="true">↗</span></span>
            <strong>Create an account</strong>
            <span>Start on BASIC: compose cases, run engines and publish studies. Verified Universidad de Sevilla accounts can get RESEARCH.</span>
          </Link>
        )}
      </div>
      <div className="home-quick">
        <Link to="/examples" viewTransition className="link-arrow">Learn with an example <ArrowRight aria-hidden="true" /></Link>
        <Link to="/language" viewTransition className="link-arrow">Explore extensibility <ArrowRight aria-hidden="true" /></Link>
        <div className="home-runtime" role="status" aria-label="Runtime catalogue status">
          {counts ? (
            <>
              <span className="is-live"><i className="status-dot" aria-hidden="true" /> Runtime catalogue connected</span>
              <span>{counts.profiles} executable profile{counts.profiles === 1 ? '' : 's'}</span>
              <span>{counts.dialects} installed dialect{counts.dialects === 1 ? '' : 's'}</span>
              <span>{counts.engines} {signedIn ? '' : 'public '}engine revision{counts.engines === 1 ? '' : 's'}</span>
            </>
          ) : runtime.status === 'error' ? (
            <span className="is-offline"><i className="status-dot" aria-hidden="true" /> Runtime catalogue unavailable</span>
          ) : (
            <span><i className="status-dot" aria-hidden="true" /> Checking the runtime catalogue…</span>
          )}
        </div>
      </div>
    </section>
  );
}

function Pipeline() {
  const [active, setActive] = useState(0);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const stage = PIPELINE[active];

  const move = (index: number) => {
    const next = (index + PIPELINE.length) % PIPELINE.length;
    setActive(next);
    tabs.current[next]?.focus();
  };
  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const target: Record<string, number> = { ArrowRight: index + 1, ArrowDown: index + 1, ArrowLeft: index - 1, ArrowUp: index - 1, Home: 0, End: PIPELINE.length - 1 };
    if (!(event.key in target)) return;
    event.preventDefault();
    move(target[event.key]);
  };

  return (
    <section aria-labelledby="home-pipeline-title" className="home-section">
      <Eyebrow>How it works</Eyebrow>
      <h2 id="home-pipeline-title">From a package to evidence anyone can verify</h2>
      <div role="tablist" aria-label="Pipeline stages" className="home-stages">
        {PIPELINE.map((item, index) => (
          <button
            key={item.id}
            ref={(node) => { tabs.current[index] = node; }}
            id={`home-stage-${item.id}`}
            type="button"
            role="tab"
            aria-selected={index === active}
            aria-controls="home-stage-panel"
            tabIndex={index === active ? 0 : -1}
            onClick={() => setActive(index)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            <span className="home-stage-step">{item.step}</span>
            <strong>{item.title}</strong>
            <span className="home-stage-short">{item.short}</span>
          </button>
        ))}
      </div>
      <div id="home-stage-panel" role="tabpanel" aria-labelledby={`home-stage-${stage.id}`} aria-live="polite" className="home-stage-panel">
        <div>
          <span className="home-kicker">{stage.step} · {stage.title}</span>
          <p>{stage.long}</p>
          <code>{stage.pin}</code>
        </div>
        <Link to={stage.href} viewTransition className="home-cta">{stage.cta}</Link>
      </div>
    </section>
  );
}

function RecentlyPublic() {
  const publications = useResource('home-publications', () => platformApi.publicPublications());
  const projects = useResource('home-projects', () => platformApi.publicProjects());
  const engines = useResource('home-engines', () => apiClient.getPublicEngines());
  const resources = [publications, projects, engines];

  const loading = resources.some((resource) => resource.status === 'loading');
  const failed = publications.status === 'error' && projects.status === 'error';
  const reload = () => resources.forEach((resource) => { if (resource.status === 'error') resource.reload(); });

  const publicationCards = publicationItems(publications.data ?? [], projects.data ?? []).slice(0, RECENT_LIMIT);
  const projectCards = projectItems(projects.data ?? [], publications.data ?? null).slice(0, RECENT_LIMIT);
  const engineList = engines.data ?? [];
  const engineNames = [...new Set(engineList.map((engine) => engine.name))];
  const namespaces = [...new Set(engineList.map((engine) => engine.namespace))];
  const versions = [...new Set(engineList.map((engine) => engine.version))];
  const empty = publicationCards.length === 0 && projectCards.length === 0 && engineList.length === 0;

  return (
    <section aria-labelledby="home-recent-title" className="home-section">
      <div className="home-section-head">
        <div>
          <Eyebrow>Recently public</Eyebrow>
          <h2 id="home-recent-title">Publications and public projects</h2>
        </div>
        <Link to="/explore" viewTransition>View all in Explore</Link>
      </div>
      <div aria-live="polite" aria-busy={loading}>
        {loading && (
          <>
            <div className="home-recent"><Skeleton /><Skeleton /><Skeleton /></div>
            <span className="sr-only">Loading recent publications</span>
          </>
        )}
        {!loading && failed && (
          <Notice tone="error" action={<Button size="sm" variant="secondary" onClick={reload}>Retry</Button>}>
            Recent publications couldn’t be loaded ({publications.error instanceof HttpError ? `HTTP ${publications.error.status}` : 'the gateway can’t be reached'}).
            The rest of the page still works.
          </Notice>
        )}
        {!loading && !failed && empty && (
          <div className="home-empty">
            <Network aria-hidden="true" />
            <strong>Nothing has been published yet</strong>
            <span>When a team freezes a report and publishes it, it appears here with its citation and digest. Meanwhile, the language guide explains what a package contains.</span>
            <Link to="/language">Read the language guide</Link>
          </div>
        )}
        {!loading && !failed && !empty && (
          <ul className="home-recent">
            {publicationCards.map((item) => (
              <li key={item.id}>
                <Link to={item.digest ? `/resolve/report/${item.digest}` : '/explore?tab=publications'} viewTransition className="home-recent-card">
                  <span className="home-recent-meta"><span className="home-tile" aria-hidden="true">{item.glyph}</span>{item.meta}</span>
                  <strong>{item.title}</strong>
                  <span className="home-recent-sub">{item.sub}</span>
                  <span className="home-recent-chips">{[...item.chips, 'Public'].map((chip) => <span key={chip}>{chip}</span>)}</span>
                </Link>
              </li>
            ))}
            {projectCards.map((item) => (
              <li key={item.id}>
                <Link to="/explore?tab=projects" viewTransition className="home-recent-card">
                  <span className="home-recent-meta"><span className="home-tile" aria-hidden="true">{item.glyph}</span>{item.meta}</span>
                  <strong>{item.title}</strong>
                  <span className="home-recent-sub">{item.sub}</span>
                  <span className="home-recent-chips">{item.chips.map((chip) => <span key={chip}>{chip}</span>)}</span>
                </Link>
              </li>
            ))}
            {engineList.length > 0 && (
              <li>
                <Link to="/engines" viewTransition className="home-recent-card">
                  <span className="home-recent-meta">Public engines</span>
                  <strong>{engineList.length} public engine revision{engineList.length === 1 ? '' : 's'}</strong>
                  <span className="home-recent-sub is-mono">{engineNames.join(' · ')}</span>
                  <span className="home-recent-chips">{[...namespaces, ...versions.map((version) => `v${version}`)].map((chip) => <span key={chip}>{chip}</span>)}</span>
                </Link>
              </li>
            )}
          </ul>
        )}
      </div>
    </section>
  );
}

function Plans() {
  return (
    <section aria-labelledby="home-plans-title" className="home-section">
      <div className="home-section-head">
        <div>
          <Eyebrow>Plans</Eyebrow>
          <h2 id="home-plans-title">Free to start, institutional when you scale</h2>
        </div>
        <Link to="/pricing" viewTransition>Compare plans</Link>
      </div>
      <ul className="home-plans">
        {planSummaries.map((plan) => (
          <li key={plan.name}>
            <span className="home-kicker">{plan.name}</span>
            <strong>{plan.price}</strong>
            <span>{plan.how}</span>
            <span className="home-plan-chips">{plan.chips.map((chip) => <span key={chip}>{chip}</span>)}</span>
          </li>
        ))}
      </ul>
      <span className="home-fineprint"><Info aria-hidden="true" />Headline limits from pricing {PRICING_VERSION}; the Pricing page shows the live document. No checkout: paid plans are arranged by agreement.</span>
    </section>
  );
}

const LAYER_ICONS = { core: Boxes, profile: Braces, dialect: Waypoints, engine: ServerCog } as const;

function ExtendingBim({ executableProfiles: executable }: { executableProfiles: number }) {
  const [workflow, setWorkflow] = useState<WorkflowOption>('bpmn');
  const option = WORKFLOW_OPTIONS[workflow];

  return (
    <>
      <section aria-labelledby="home-extend-title" className="home-section">
        <div className="home-section-head is-split">
          <div>
            <Eyebrow>Extensibility is the architecture</Eyebrow>
            <h2 id="home-extend-title">A stable core, plural problem families.</h2>
          </div>
          <p>BIM does not freeze every domain into one QoS schema. It keeps identity, packaging, resolution and provenance common, while explicit contracts own the meaning.</p>
        </div>
        <ul className="home-layers">
          {LAYERS.map((layer) => {
            const Icon = LAYER_ICONS[layer.id];
            return (
              <li key={layer.id} className={`is-${layer.id}`}>
                <span className="home-kicker">{layer.label}</span>
                <Icon aria-hidden="true" />
                <h3>{layer.title}</h3>
                <p>{layer.copy}</p>
                <small>
                  {layer.id === 'profile'
                    ? (executable > 1 ? `${executable} Profiles are executable on this host.` : <>Only <code>qos-binding/v1</code> is executable today.</>)
                    : layer.note}
                </small>
              </li>
            );
          })}
        </ul>
        <ul className="home-routes">
          {EXTENSION_ROUTES.map((route) => (
            <li key={route.index}>
              <span className="home-route-index" aria-hidden="true">{route.index}</span>
              <div><small>{route.tag}</small><h3>{route.title}</h3></div>
              <p>{route.copy}</p>
            </li>
          ))}
        </ul>
        <p className="home-fineprint">
          “Specialize” means publishing a new, explicit Profile contract that may reuse shared resource languages. It does not mean a
          package can inherit or override a host Profile at runtime.
        </p>
      </section>

      <section aria-labelledby="home-workflow-title" className="home-section">
        <div className="home-section-head is-split">
          <div>
            <Eyebrow>Vendor-neutral source</Eyebrow>
            <h2 id="home-workflow-title">Swap the workflow language, keep the boundary.</h2>
          </div>
          <p>A Profile opens roles. Compatible Dialects let standards bodies or vendors supply source vocabularies without teaching every solver to parse them.</p>
        </div>
        <div className="home-lab">
          <div role="tablist" aria-label="Workflow source language" className="home-lab-tabs">
            {(Object.keys(WORKFLOW_OPTIONS) as WorkflowOption[]).map((key) => (
              <button key={key} type="button" role="tab" id={`home-workflow-${key}`} aria-selected={workflow === key} aria-controls="home-workflow-panel" onClick={() => setWorkflow(key)}>
                <span>{WORKFLOW_OPTIONS[key].status}</span>{WORKFLOW_OPTIONS[key].label}
              </button>
            ))}
          </div>
          <div id="home-workflow-panel" role="tabpanel" aria-labelledby={`home-workflow-${workflow}`} className="home-lab-route">
            <article>
              <span className="home-kicker">Typed source</span>
              <Braces aria-hidden="true" />
              <h3>{option.source}</h3>
              <p>{option.detail}</p>
            </article>
            <ArrowRight className="home-lab-arrow" aria-hidden="true" />
            <article>
              <span className="home-kicker">Installed boundary</span>
              <Waypoints aria-hidden="true" />
              <h3>{option.adapter}</h3>
              <p>Validate exact syntax, lower deterministically and emit declared IR features.</p>
            </article>
            <ArrowRight className="home-lab-arrow" aria-hidden="true" />
            <article className="is-output">
              <span className="home-kicker">Profile output</span>
              <Network aria-hidden="true" />
              <h3>bim/v1 BindingProblem</h3>
              <p>Engines consume the compiled semantics, not the vendor source document.</p>
            </article>
          </div>
          <p className="home-lab-proof">
            <Check aria-hidden="true" />
            Equivalent native JSON and BPMN lowerings may share a semantic IR identity; source files, Dialects and adapters remain separately pinned in provenance.
          </p>
        </div>
      </section>

      <section aria-labelledby="home-gate-title" className="home-gate">
        <div className="home-gate-copy">
          <Eyebrow>Solver compatibility &amp; federation</Eyebrow>
          <h2 id="home-gate-title">The match closes before work crosses a boundary.</h2>
          <p>OpenBinding compiles first, finds exact compatible modes second, and only then routes the IR to a pinned local or remote EngineRegistration. Remote engines never receive the source package.</p>
          <Link to="/engines" viewTransition className="link-arrow">Inspect engine modes <ArrowUpRight aria-hidden="true" /></Link>
        </div>
        <div className="home-gate-card">
          <header><ShieldCheck aria-hidden="true" /><div><span className="home-kicker">Fail-closed gate</span><h3>Every line must match</h3></div></header>
          <ol>
            {COMPATIBILITY_GATE.map((row) => (
              <li key={row.name}><Check aria-hidden="true" /><span><strong>{row.name}</strong><small>{row.rule}</small></span><code>{row.value}</code></li>
            ))}
          </ol>
          <footer><span>* <code>all</code> is legal only for closed dimensions.</span><strong>Gateway reevaluates the decision on return.</strong></footer>
        </div>
      </section>
    </>
  );
}
