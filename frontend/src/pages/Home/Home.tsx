import { useEffect, useState } from 'react';
import {
  ArrowRight,
  Boxes,
  Braces,
  Check,
  Network,
  ServerCog,
  ShieldCheck,
  Waypoints,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { apiClient } from '../../api/client';
import { useAuth } from '../../contexts/auth';
import './Home.css';

const PIPELINE = [
  {
    id: 'source',
    step: '01',
    label: 'Instance package',
    title: 'Portable source, not a monolith',
    copy: 'A small instance.json selects a Profile and indexes typed local or immutable registered resources by role.',
    pin: 'instance.json + resource digests',
  },
  {
    id: 'contract',
    step: '02',
    label: 'Profile + Dialects',
    title: 'The problem contract chooses the vocabulary',
    copy: 'The Profile owns roles, cardinalities, IR and feature vocabularies. Installed Dialects contribute exact resource languages and lowering adapters.',
    pin: 'schema + adapter digests',
  },
  {
    id: 'ir',
    step: '03',
    label: 'BindingProblem IR',
    title: 'Different source languages meet at one boundary',
    copy: 'The host resolves and validates the package, then adapters lower it to the closed IR declared by the selected Profile.',
    pin: 'bim/v1 BindingProblem',
  },
  {
    id: 'engine',
    step: '04',
    label: 'Compatible mode',
    title: 'Compatibility is computed, never guessed',
    copy: 'A mode must match the exact Profile, IR identity, every emitted feature selector, limits and a pinned EngineRegistration.',
    pin: 'Engine + Registration + mode',
  },
  {
    id: 'result',
    step: '05',
    label: 'Verified result',
    title: 'The gateway remains the trust boundary',
    copy: 'The engine receives compiled IR only. OpenBinding reevaluates every returned decision and keeps full provenance.',
    pin: 'decision + evaluator provenance',
  },
] as const;

const EXTENSION_ROUTES = [
  {
    index: 'A',
    title: 'Add a compatible Dialect',
    tag: 'Reuse the Profile + IR',
    copy: 'Introduce a whole typed resource or a schema-pinned inline vocabulary in a role the Profile already opens. The installed adapter must lower it deterministically and declare the IR features it emits.',
  },
  {
    index: 'B',
    title: 'Define an explicit specialization',
    tag: 'Reuse contracts, narrow the frame',
    copy: 'A new Profile may reuse compatible resource identities and shared Dialects while declaring stricter roles, cardinalities or feature vocabularies. Its manifest is complete: BIM has no implicit extends shortcut.',
  },
  {
    index: 'C',
    title: 'Open a new problem family',
    tag: 'Change semantics + IR',
    copy: 'When the decision meaning, determinism, roles or output contract changes, define a separate Profile and matching Engine modes without changing the stable Instance container.',
  },
] as const;

const WORKFLOW_OPTIONS = {
  native: {
    label: 'Native JSON',
    status: 'Installed',
    source: 'qos-binding/v1 · Application',
    adapter: 'qos-binding adapter',
    detail: 'Compact structured workflow blocks live in the Application resource.',
  },
  bpmn: {
    label: 'BPMN 2.0.2',
    status: 'Installed',
    source: 'omg/bpmn/2.0.2 · BPMN',
    adapter: 'bpmn-workflow/v1 adapter',
    detail: 'Normative BPMN XML keeps its QName and enters the application role as a typed resource.',
  },
  vendor: {
    label: 'Vendor language',
    status: 'Extension contract',
    source: 'vendor.example/v1 · Workflow',
    adapter: 'reviewed vendor adapter',
    detail: 'A vendor can supply another source vocabulary only after its exact schema and lowering adapter are installed. Packages cannot install code.',
  },
} as const;

type WorkflowOption = keyof typeof WORKFLOW_OPTIONS;

export function Home() {
  const { user } = useAuth();
  const signedIn = Boolean(user);
  const [activeStage, setActiveStage] = useState<(typeof PIPELINE)[number]['id']>('contract');
  const [workflow, setWorkflow] = useState<WorkflowOption>('bpmn');
  const [runtime, setRuntime] = useState<{ profiles: number; dialects: number; engines: number; available: boolean }>({
    profiles: 0,
    dialects: 0,
    engines: 0,
    available: false,
  });

  useEffect(() => {
    let cancelled = false;
    const catalogue = signedIn
      ? Promise.all([apiClient.getProfiles(), apiClient.getDialects(), apiClient.getEngines()])
      : Promise.all([apiClient.getProfiles(), apiClient.getDialects()]).then(([profiles, dialects]) => [profiles, dialects, []] as const);
    void catalogue
      .then(([profiles, dialects, engines]) => {
        if (!cancelled) setRuntime({ profiles: profiles.length, dialects: dialects.length, engines: engines.length, available: true });
      })
      .catch(() => {
        if (!cancelled) setRuntime((current) => ({ ...current, available: false }));
      });
    return () => { cancelled = true; };
  }, [signedIn]);

  const stage = PIPELINE.find((item) => item.id === activeStage) ?? PIPELINE[1];
  const workflowOption = WORKFLOW_OPTIONS[workflow];

  return (
    <div className="home-page">
      <section className="home-hero">
        <div className="home-hero-copy">
          <span className="kicker">BIM v1 language · OpenBinding host</span>
          <h1>Describe a binding problem once. Change how it is written. Change who solves it.</h1>
          <p className="home-definition">
            BIM v1 is a language container for service-composition and binding problems.
            It separates the stable package from problem Profiles, source Dialects and solver Engines.
          </p>
          <div className="home-actions">
            <Link to="/examples" viewTransition className="home-action primary">
              Learn with an example <ArrowRight aria-hidden="true" />
            </Link>
            <Link to="/profiles" viewTransition className="home-action secondary">
              Explore extensibility
            </Link>
          </div>
          <div className="runtime-line" aria-label="Runtime catalogue status">
            <span className={runtime.available ? 'is-live' : 'is-offline'}><i className="status-dot" /> {runtime.available ? 'Runtime catalogue connected' : 'Runtime catalogue unavailable'}</span>
            {runtime.available && <><span>{runtime.profiles} executable profile{runtime.profiles === 1 ? '' : 's'}</span><span>{runtime.dialects} installed dialects</span>{signedIn ? <span>{runtime.engines} engine revision{runtime.engines === 1 ? '' : 's'}</span> : <span>Sign in to inspect engine revisions</span>}</>}
          </div>
        </div>

        <div className="pipeline-field" aria-label="BIM compilation journey">
          <div className="pipeline-field-heading">
            <span className="micro-label">Select a boundary</span>
            <span>Source → verified decision</span>
          </div>
          <div className="pipeline-buttons">
            {PIPELINE.map((item) => (
              <button
                key={item.id}
                type="button"
                className={item.id === activeStage ? 'is-active' : ''}
                aria-pressed={item.id === activeStage}
                onClick={() => setActiveStage(item.id)}
              >
                <span>{item.step}</span>
                <strong>{item.label}</strong>
                <ArrowRight aria-hidden="true" />
              </button>
            ))}
          </div>
          <div className="pipeline-detail" key={stage.id}>
            <span className="micro-label">{stage.pin}</span>
            <h2>{stage.title}</h2>
            <p>{stage.copy}</p>
          </div>
        </div>
      </section>

      <nav className="home-journey" aria-label="Progressive BIM journey">
        {[
          ['01', 'Understand', '/', 'Why the layers exist'],
          ['02', 'Explore', '/profiles', 'Profiles and Dialects'],
          ['03', 'Compose', '/examples', 'Typed resources in context'],
          ['04', 'Experiment', '/playground', 'Live package and feedback'],
          ['05', 'Inspect', '/schemas', 'Contracts and protocol'],
        ].map(([number, label, to, detail]) => (
          <Link key={to} to={to} viewTransition>
            <span>{number}</span><strong>{label}</strong><small>{detail}</small>
          </Link>
        ))}
      </nav>

      <section className="extension-section">
        <header className="home-section-header">
          <div><span className="section-label">Extensibility is the architecture</span><h2>A stable core, plural problem families.</h2></div>
          <p>
            BIM does not freeze every domain into one QoS schema. It keeps identity, packaging,
            resolution and provenance common, while explicit contracts own the meaning.
          </p>
        </header>

        <div className="layer-ledger">
          <article className="layer-core">
            <span>Stable BIM core</span><Boxes aria-hidden="true" />
            <h3>Container &amp; identity</h3>
            <p>Envelopes, role indexes, immutable references, schemas, digests, diagnostics and provenance.</p>
            <small>Never owns task, metric, workflow or objective meaning.</small>
          </article>
          <article className="layer-profile">
            <span>Problem Profile</span><Braces aria-hidden="true" />
            <h3>Semantic frame</h3>
            <p>Roles, cardinalities, output IR, capability vocabulary, limits, determinism and adapter.</p>
            <small>{runtime.available && runtime.profiles > 1 ? `${runtime.profiles} Profiles are executable on this host.` : <>Only <code>qos-binding/v1</code> is executable today.</>}</small>
          </article>
          <article className="layer-dialect">
            <span>Source Dialects</span><Waypoints aria-hidden="true" />
            <h3>Replaceable vocabulary</h3>
            <p>Exact resource types or inline extension points with schema-pinned lowering.</p>
            <small>QoS JSON, BPMN and Placement are independently versioned.</small>
          </article>
          <article className="layer-engine">
            <span>Engine modes</span><ServerCog aria-hidden="true" />
            <h3>Truthful execution</h3>
            <p>Exact Profile/IR support, feature selectors, options, ceilings and guarantees.</p>
            <small>No wildcard promise over an open extension vocabulary.</small>
          </article>
        </div>

        <div className="extension-routes">
          {EXTENSION_ROUTES.map((route) => (
            <article key={route.index}>
              <span className="extension-index">{route.index}</span>
              <div><small>{route.tag}</small><h3>{route.title}</h3></div>
              <p>{route.copy}</p>
            </article>
          ))}
        </div>
        <p className="extension-caveat">
          “Specialize” means publishing a new, explicit Profile contract that may reuse shared resource languages.
          It does not mean a package can inherit or override a host Profile at runtime.
        </p>
      </section>

      <section className="workflow-section">
        <header className="home-section-header">
          <div><span className="section-label">Vendor-neutral source</span><h2>Swap the workflow language, keep the boundary.</h2></div>
          <p>
            A Profile opens roles. Compatible Dialects let standards bodies or vendors supply source
            vocabularies without teaching every solver to parse them.
          </p>
        </header>

        <div className="workflow-lab">
          <div className="workflow-tabs" role="tablist" aria-label="Workflow source language">
            {(Object.keys(WORKFLOW_OPTIONS) as WorkflowOption[]).map((key) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={workflow === key}
                className={workflow === key ? 'is-active' : ''}
                onClick={() => setWorkflow(key)}
              >
                <span>{WORKFLOW_OPTIONS[key].status}</span>{WORKFLOW_OPTIONS[key].label}
              </button>
            ))}
          </div>
          <div className="workflow-route" role="tabpanel" key={workflow}>
            <article>
              <span className="micro-label">Typed source</span>
              <Braces aria-hidden="true" />
              <h3>{workflowOption.source}</h3>
              <p>{workflowOption.detail}</p>
            </article>
            <ArrowRight className="workflow-arrow" aria-hidden="true" />
            <article>
              <span className="micro-label">Installed boundary</span>
              <Waypoints aria-hidden="true" />
              <h3>{workflowOption.adapter}</h3>
              <p>Validate exact syntax, lower deterministically and emit declared IR features.</p>
            </article>
            <ArrowRight className="workflow-arrow" aria-hidden="true" />
            <article className="workflow-output">
              <span className="micro-label">Profile output</span>
              <Network aria-hidden="true" />
              <h3>bim/v1 BindingProblem</h3>
              <p>Engines consume the compiled semantics, not the vendor source document.</p>
            </article>
          </div>
          <div className="workflow-proof">
            <Check aria-hidden="true" />
            <p>Equivalent native JSON and BPMN lowerings may share a semantic IR identity; source files, Dialects and adapters remain separately pinned in provenance.</p>
          </div>
        </div>
      </section>

      <section className="compatibility-section">
        <div className="compatibility-copy">
          <span className="section-label">Solver compatibility &amp; federation</span>
          <h2>The match closes before work crosses a boundary.</h2>
          <p>
            OpenBinding compiles first, finds exact compatible modes second, and only then routes the IR
            to a pinned local or remote EngineRegistration. Remote engines never receive the source package.
          </p>
          <Link to="/engines" viewTransition className="link-arrow">Inspect engine modes <ArrowRight aria-hidden="true" /></Link>
        </div>
        <div className="compatibility-gate">
          <header><ShieldCheck aria-hidden="true" /><div><span className="micro-label">Fail-closed gate</span><h3>Every line must match</h3></div></header>
          <ol>
            <li><Check aria-hidden="true" /><span><strong>Profile</strong><small>exact versioned id</small></span><code>qos-binding/v1</code></li>
            <li><Check aria-hidden="true" /><span><strong>IR</strong><small>exact apiVersion + kind</small></span><code>bim/v1 · BindingProblem</code></li>
            <li><Check aria-hidden="true" /><span><strong>Features</strong><small>actual lowered values ⊆ selectors</small></span><code>none · only · all*</code></li>
            <li><Check aria-hidden="true" /><span><strong>Limits</strong><small>problem size within ceilings</small></span><code>Profile vocabulary</code></li>
            <li><Check aria-hidden="true" /><span><strong>Deployment</strong><small>immutable registration + protocol</small></span><code>bim-engine/v1</code></li>
          </ol>
          <footer><span>* <code>all</code> is legal only for closed dimensions.</span><strong>Gateway reevaluates the decision on return.</strong></footer>
        </div>
      </section>

      <section className="home-next">
        <span className="section-label">Continue the journey</span>
        <h2>See the first executable Profile as a contract, then take it apart.</h2>
        <div>
          <Link to="/profiles" viewTransition className="home-action primary">Explore Profiles <ArrowRight aria-hidden="true" /></Link>
          <Link to="/examples" viewTransition className="home-action secondary">Choose a lesson</Link>
        </div>
      </section>
    </div>
  );
}
