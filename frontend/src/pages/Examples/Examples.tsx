import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { ArrowRight, BookOpen, Check, FlaskConical, Layers3, Search, Waypoints } from 'lucide-react';
import { Link } from 'react-router-dom';
import { apiClient } from '../../api/client';
import { Alert } from '../../components/ui/Alert';
import './Examples.css';

const preloadPlayground = () => { void import('../Playground/Playground'); };

type Track = 'demo' | 'placement' | 'literature';
type Shape = 'sequence' | 'parallel' | 'exclusive' | 'loop' | 'conflict' | 'objective' | 'shared' | 'placement' | 'research' | 'bpmn';

interface LessonMeta {
  title: string;
  concept: string;
  outcome: string;
  shape: Shape;
  level: number;
  tags: string[];
  compatibility?: string;
}

const LESSONS: Record<string, LessonMeta> = {
  'demo/01_simple_seq': { title: 'A first binding', concept: 'Basic sequence', outcome: 'Connect one Application, one CandidateCatalog and one Optimization through explicit resource references.', shape: 'sequence', level: 1, tags: ['sequence', 'binding'] },
  'demo/02_parallel': { title: 'Parallel aggregation', concept: 'Parallel flow', outcome: 'See how deterministic metric aggregation follows a parallel workflow block.', shape: 'parallel', level: 1, tags: ['parallel', 'aggregation'] },
  'demo/03_xor_choice': { title: 'Probabilistic routing', concept: 'Exclusive branch', outcome: 'Add a separate RoutingOverlay with explicit probabilities while the workflow stays structural.', shape: 'exclusive', level: 2, tags: ['routing', 'probabilities'] },
  'demo/04_conflict': { title: 'Read an infeasible result', concept: 'Conflicting constraints', outcome: 'Trace a deliberately unsatisfiable package from analysis to an INFEASIBLE-compatible result.', shape: 'conflict', level: 2, tags: ['constraints', 'diagnostics'] },
  'demo/05_multi_obj': { title: 'Balance cost and latency', concept: 'Weighted objective', outcome: 'Encode a deterministic trade-off with explicit weighted terms and normalization.', shape: 'objective', level: 2, tags: ['weighted', 'optimization'] },
  'demo/06_loops': { title: 'Repeat with a declared count', concept: 'Loop semantics', outcome: 'Use repeat.count or repeat.expectedCount as deterministic aggregation multipliers.', shape: 'loop', level: 2, tags: ['repeat', 'aggregation'] },
  'demo/07_soft_constraints': { title: 'Prefer, do not forbid', concept: 'Soft constraints', outcome: 'Connect an explicit soft-constraint penalty to Optimization without weakening hard assertions.', shape: 'objective', level: 3, tags: ['soft constraint', 'penalty'] },
  'demo/08_dependencies': { title: 'Match typed capabilities', concept: 'Provider properties', outcome: 'Inspect typed capability matching and provider properties rather than task-to-candidate lists.', shape: 'sequence', level: 3, tags: ['capabilities', 'providers'] },
  'demo/09_mixed': { title: 'Compose the pieces', concept: 'Mixed structure', outcome: 'Combine sequence, exclusive routing and constraints in one modular package.', shape: 'exclusive', level: 3, tags: ['mixed', 'constraints'] },
  'demo/10_large_scale': { title: 'Push engine ceilings', concept: 'Scale and performance', outcome: 'Observe how problem size is checked against each compatible mode’s declared limits.', shape: 'parallel', level: 4, tags: ['limits', 'scale'], compatibility: 'Engine limits become part of the match.' },
  'demo/11_multi_obj_negative': { title: 'Normalize two objectives', concept: 'Multi-objective normalization', outcome: 'Inspect a two-term objective used to exercise normalization and mode compatibility.', shape: 'objective', level: 4, tags: ['normalization', 'multi-objective'] },
  'demo/12_many_obj_pareto': { title: 'Explore a Pareto problem', concept: 'Many-objective optimization', outcome: 'Require a mode that explicitly advertises Pareto support; heuristic does not imply a complete front.', shape: 'objective', level: 4, tags: ['pareto', 'compatibility'], compatibility: 'Requires optimization=pareto.' },
  'demo/13_fms': { title: 'Bind a feature-model composition', concept: 'Feature-model structure', outcome: 'Study a composition derived from a feature model through the same Profile roles.', shape: 'parallel', level: 5, tags: ['feature model', 'composition'] },
  'demo/14_shared_candidates': { title: 'Share one selected candidate', concept: 'Selected-candidate scope', outcome: 'See one candidate serve multiple tasks with explicit selected-candidate metric semantics.', shape: 'shared', level: 5, tags: ['sharing', 'metric scope'], compatibility: 'Requires metricScopes=selectedCandidate.' },
  'demo/15_bpmn_complete': { title: 'Orchestrate a complete BPMN workflow', concept: 'BPMN + routing + placement', outcome: 'Follow nested AND/XOR gateways, an exact multi-instance task, four QoS dimensions and edge/fog/cloud placement as one modular package.', shape: 'bpmn', level: 5, tags: ['BPMN', 'routing', 'placement', 'multi-instance'], compatibility: 'Requires BPMN lowering and Placement extension support.' },
  'demo/16_json_complete': { title: 'Prove BPMN and JSON are equivalent', concept: 'Native JSON twin', outcome: 'Compare the complete BPMN lesson with the same workflow authored directly as BIM JSON; both compile to the same canonical IR.', shape: 'parallel', level: 5, tags: ['JSON', 'BPMN', 'IR', 'regression'], compatibility: 'Every compatible engine must return the same result as lesson 15.' },
  'placement/01_small_placement': { title: 'Add placement to binding', concept: 'Placement Dialect', outcome: 'Compose pools, capacity, network latency, security and pricing with the base binding resources.', shape: 'placement', level: 4, tags: ['placement', 'dialect'], compatibility: 'Requires placement=placement and irExtensions=qos-binding-placement/v1.' },
  'placement/02_stock_market_sample': { title: 'Place a larger stock workflow', concept: 'Placement at mid scale', outcome: 'Explore a pruned 50-node infrastructure sample with on-demand pricing and capacity constraints.', shape: 'placement', level: 5, tags: ['placement', 'scale'], compatibility: 'Requires explicit Placement extension support.' },
  'placement/03_cloud_only': { title: 'Compare a cloud-only package', concept: 'Placement variant', outcome: 'Hold the problem family stable while changing the placement-aware infrastructure resource.', shape: 'placement', level: 4, tags: ['placement', 'cloud'], compatibility: 'Placement-aware mode only.' },
  'placement/04_edge_heavy': { title: 'Compare an edge-heavy package', concept: 'Placement variant', outcome: 'Contrast infrastructure choices without changing the stable BIM container or Profile roles.', shape: 'placement', level: 4, tags: ['placement', 'edge'], compatibility: 'Placement-aware mode only.' },
  'literature/benatallah': { title: 'Travel solution', concept: 'Benatallah et al. scenario', outcome: 'Inspect a representative research workflow as a modular deterministic BIM package.', shape: 'research', level: 5, tags: ['literature', 'travel'] },
  'literature/bultan': { title: 'Warehouse conversation', concept: 'Bultan et al. scenario', outcome: 'Study an e-commerce conversation workflow represented in the executable QoS Profile.', shape: 'research', level: 5, tags: ['literature', 'e-commerce'] },
  'literature/cremaschi': { title: 'Healthcare monitoring', concept: 'Cremaschi et al. scenario', outcome: 'Explore a monitoring and emergency-response composition using deterministic scalar QoS.', shape: 'research', level: 5, tags: ['literature', 'healthcare'] },
  'literature/netedu': { title: 'Transport agency', concept: 'Netedu et al. scenario', outcome: 'Follow a transport-agency case through the same source-to-IR boundary.', shape: 'research', level: 5, tags: ['literature', 'transport'] },
  'literature/pautasso': { title: 'RESTful e-commerce', concept: 'Pautasso scenario', outcome: 'Inspect an e-commerce composition adapted into native v1 resources.', shape: 'research', level: 5, tags: ['literature', 'REST'] },
  'literature/zhang': { title: 'Entertainment planner', concept: 'Zhang et al. scenario', outcome: 'Explore a personal entertainment planner with explicit resources and deterministic metrics.', shape: 'research', level: 5, tags: ['literature', 'planner'] },
};

const TRACK_COPY: Record<Track, { label: string; description: string }> = {
  demo: { label: 'Core lessons', description: 'A progressive sequence from one binding to advanced compatibility features.' },
  placement: { label: 'Placement extension', description: 'The installed Placement Dialect adds source and IR features inside the application role.' },
  literature: { label: 'Research scenarios', description: 'Representative service-composition cases expressed through the same deterministic Profile.' },
};

function trackOf(path: string): Track {
  return path.startsWith('placement/') ? 'placement' : path.startsWith('literature/') ? 'literature' : 'demo';
}

function titleFromPath(path: string): string {
  return path.split('/').at(-1)?.replace(/^\d+_/, '').replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()) || path;
}

function WorkflowGlyph({ shape }: { shape: Shape }) {
  const parallel = shape === 'parallel' || shape === 'placement' || shape === 'bpmn';
  const branch = shape === 'exclusive' || shape === 'conflict' || shape === 'research';
  const loop = shape === 'loop';
  const shared = shape === 'shared';
  return (
    <svg className={`workflow-glyph glyph-${shape}`} viewBox="0 0 220 88" role="img" aria-label={`${shape} workflow glyph`}>
      <path className="glyph-line" d="M20 44 H65" />
      <circle className="glyph-node" cx="15" cy="44" r="7" />
      {parallel && <><path className="glyph-line" d="M65 44 C80 44 80 20 96 20 H135 C150 20 150 44 165 44" /><path className="glyph-line" d="M65 44 C80 44 80 68 96 68 H135 C150 68 150 44 165 44" /><rect className="glyph-block" x="101" y="12" width="28" height="16" /><rect className="glyph-block" x="101" y="60" width="28" height="16" /></>}
      {branch && <><path className="glyph-line" d="M65 44 L92 18 H137 L165 44" /><path className="glyph-line" d="M65 44 L92 70 H137 L165 44" /><path className="glyph-diamond" d="M65 35 L74 44 L65 53 L56 44 Z" /></>}
      {loop && <><rect className="glyph-block" x="88" y="34" width="36" height="20" /><path className="glyph-line" d="M65 44 H88 M124 44 H165 M124 34 C145 5 78 4 88 34" /></>}
      {shared && <><path className="glyph-line" d="M65 44 H92 M92 44 L122 20 M92 44 L122 68 M122 20 L165 44 M122 68 L165 44" /><circle className="glyph-accent" cx="122" cy="20" r="7" /><circle className="glyph-accent" cx="122" cy="68" r="7" /></>}
      {!parallel && !branch && !loop && !shared && <><rect className="glyph-block" x="76" y="34" width="36" height="20" /><rect className="glyph-block" x="128" y="34" width="36" height="20" /><path className="glyph-line" d="M65 44 H76 M112 44 H128 M164 44 H180" /></>}
      <path className="glyph-line" d={parallel || branch || loop || shared ? 'M165 44 H200' : 'M180 44 H200'} />
      <circle className="glyph-node glyph-end" cx="205" cy="44" r="7" />
    </svg>
  );
}

export function Examples() {
  const [paths, setPaths] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [track, setTrack] = useState<'all' | Track>('all');
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    void apiClient.getBimExamples()
      .then((examples) => { if (!cancelled) setPaths(examples.filter((path) => path !== 'demo/05_single_obj_various')); })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : 'The example catalogue could not be loaded.');
          setPaths(Object.keys(LESSONS));
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const examples = useMemo(() => paths.map((path) => ({
    path,
    track: trackOf(path),
    meta: LESSONS[path] ?? { title: titleFromPath(path), concept: 'BIM package', outcome: 'Open the package to inspect its Profile-directed resources.', shape: 'sequence' as Shape, level: 5, tags: ['package'] },
  })).filter((example) => {
    const matchesTrack = track === 'all' || example.track === track;
    const haystack = `${example.path} ${example.meta.title} ${example.meta.concept} ${example.meta.tags.join(' ')}`.toLowerCase();
    return matchesTrack && haystack.includes(query.trim().toLowerCase());
  }).sort((a, b) => a.meta.level - b.meta.level || a.path.localeCompare(b.path)), [paths, query, track]);

  return (
    <div className="examples-page page-shell">
      <header className="page-intro examples-intro">
        <div>
          <span className="kicker">03 · Compose through examples</span>
          <h1 className="page-title">Learn one semantic move at a time.</h1>
        </div>
        <div>
          <p className="page-lede">
            Every lesson is a complete portable Instance package, not a single JSON object.
            Open one directly in the Playground to move between visual structure, forms and exact source.
          </p>
          <p className="example-profile-note"><Check aria-hidden="true" /> All shipped lessons select <code>qos-binding/v1</code>. Placement demonstrates a compatible Dialect, not another Profile.</p>
        </div>
      </header>

      {error && <Alert type="warning" title="Live catalogue unavailable">{error} Showing the bundled lesson index; opening a package still requires the gateway.</Alert>}

      <section className="lesson-orientation" aria-labelledby="lesson-orientation-title">
        <div><span className="section-label">Suggested start</span><h2 id="lesson-orientation-title">From three resources to an exact solver match.</h2></div>
        <ol>
          <li><span>01</span><strong>See the package</strong><p>Start with the root index and Profile roles.</p></li>
          <li><span>02</span><strong>Add one semantic feature</strong><p>Routing, a constraint, an objective mode or a Dialect.</p></li>
          <li><span>03</span><strong>Analyze before solving</strong><p>Let the host compile and compute exact compatible modes.</p></li>
        </ol>
      </section>

      <section className="lesson-catalog" aria-labelledby="lesson-catalog-title">
        <header className="lesson-controls">
          <div><span className="section-label">Runtime example catalogue</span><h2 id="lesson-catalog-title">{loading ? 'Reading lessons…' : `${examples.length} visible lesson${examples.length === 1 ? '' : 's'}`}</h2></div>
          <label className="lesson-search"><Search aria-hidden="true" /><span className="sr-only">Search lessons</span><input type="search" name="lesson-search" autoComplete="off" spellCheck={false} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search concept or resource…" /></label>
          <div className="lesson-filters" role="group" aria-label="Filter example track">
            {(['all', 'demo', 'placement', 'literature'] as const).map((value) => <button key={value} type="button" aria-pressed={track === value} className={track === value ? 'is-active' : ''} onClick={() => setTrack(value)}>{value === 'all' ? 'All tracks' : TRACK_COPY[value].label}</button>)}
          </div>
        </header>

        {!loading && examples.length === 0 ? (
          <div className="lesson-empty"><FlaskConical aria-hidden="true" /><h3>No lesson matches this view.</h3><button type="button" onClick={() => { setQuery(''); setTrack('all'); }}>Clear filters</button></div>
        ) : (
          <div className="lesson-rail">
            {examples.map((example, index) => {
              const trackCopy = TRACK_COPY[example.track];
              const transitionName = `example-${example.path.replace(/[^a-z0-9]+/gi, '-')}`;
              return (
                <article className={`lesson-row lesson-${example.track}`} key={example.path}>
                  <div className="lesson-marker"><span>{String(index + 1).padStart(2, '0')}</span><i /></div>
                  <div className="lesson-identity" style={{ viewTransitionName: transitionName } as CSSProperties}>
                    <span>{trackCopy.label} · level {example.meta.level}</span>
                    <h3>{example.meta.title}</h3>
                    <p>{example.meta.concept}</p>
                  </div>
                  <div className="lesson-shape"><WorkflowGlyph shape={example.meta.shape} /><code>{example.path}</code></div>
                  <div className="lesson-outcome">
                    <span className="micro-label">What this adds</span>
                    <p>{example.meta.outcome}</p>
                    {example.meta.compatibility && <small><Waypoints aria-hidden="true" /> {example.meta.compatibility}</small>}
                    <div>{example.meta.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
                  </div>
                  <Link
                    to={`/playground?example=${encodeURIComponent(example.path)}`}
                    viewTransition
                    className="lesson-open"
                    onPointerEnter={preloadPlayground}
                    onPointerDown={preloadPlayground}
                    onFocus={preloadPlayground}
                  >
                    <span>Open package</span><ArrowRight aria-hidden="true" />
                  </Link>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className="track-explainer">
        {(Object.entries(TRACK_COPY) as Array<[Track, (typeof TRACK_COPY)[Track]]>).map(([id, item]) => (
          <article key={id}>
            {id === 'demo' ? <Layers3 aria-hidden="true" /> : id === 'placement' ? <Waypoints aria-hidden="true" /> : <BookOpen aria-hidden="true" />}
            <span>{item.label}</span><h3>{id === 'demo' ? 'Build the vocabulary progressively.' : id === 'placement' ? 'See extension compatibility fail closed.' : 'Compare representations from research.'}</h3><p>{item.description}</p>
          </article>
        ))}
      </section>

      <section className="examples-next">
        <span className="section-label">Next · Experiment live</span>
        <h2>The Playground preserves the package while you switch between structure, forms, BPMN and source.</h2>
        <Link to="/playground" viewTransition>Open the starter package <ArrowRight aria-hidden="true" /></Link>
      </section>
    </div>
  );
}
