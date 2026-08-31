import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Braces, Check, GitBranch, PackageCheck, Puzzle, ShieldCheck } from 'lucide-react';
import { Liquid } from 'liquid-gooey';
import { Link } from 'react-router-dom';
import { apiClient, type BimDialect, type BimProfile } from '../../api/client';
import { Alert } from '../../components/ui/Alert';
import './Profiles.css';

interface RoleDisplay {
  id: string;
  resourceTypes: Array<{ apiVersion: string; kind: string; minimum: number; maximum?: number }>;
  extensionTypes: string;
}

interface DialectDisplay {
  id: string;
  namespace: string;
  compatibleProfiles: string[];
  types: Array<{ apiVersion: string; kind: string; roles: string[]; mediaType: string }>;
  extensionPoints: number;
  features: Array<{ dimension: string; value: string }>;
  adapter: string;
  source: 'runtime' | 'bundled';
}

const FALLBACK_ROLES: RoleDisplay[] = [
  {
    id: 'application',
    resourceTypes: [
      { apiVersion: 'qos-binding/v1', kind: 'Application', minimum: 1, maximum: 1 },
      { apiVersion: 'qos-binding/v1', kind: 'RoutingOverlay', minimum: 0, maximum: 1 },
      { apiVersion: 'omg/bpmn/2.0.2', kind: 'BPMN', minimum: 0 },
    ],
    extensionTypes: 'installed',
  },
  { id: 'candidateCatalog', resourceTypes: [{ apiVersion: 'qos-binding/v1', kind: 'CandidateCatalog', minimum: 1 }], extensionTypes: 'installed' },
  { id: 'constraintSet', resourceTypes: [{ apiVersion: 'qos-binding/v1', kind: 'ConstraintSet', minimum: 0 }], extensionTypes: 'installed' },
  { id: 'optimization', resourceTypes: [{ apiVersion: 'qos-binding/v1', kind: 'Optimization', minimum: 1, maximum: 1 }], extensionTypes: 'installed' },
];

const FALLBACK_DIALECTS: DialectDisplay[] = [
  {
    id: 'qos-binding/v1', namespace: 'bim.builtin', compatibleProfiles: ['qos-binding/v1'], extensionPoints: 0,
    types: [
      { apiVersion: 'qos-binding/v1', kind: 'Application', roles: ['application'], mediaType: 'application/json' },
      { apiVersion: 'qos-binding/v1', kind: 'CandidateCatalog', roles: ['candidateCatalog'], mediaType: 'application/json' },
      { apiVersion: 'qos-binding/v1', kind: 'ConstraintSet', roles: ['constraintSet'], mediaType: 'application/json' },
      { apiVersion: 'qos-binding/v1', kind: 'Optimization', roles: ['optimization'], mediaType: 'application/json' },
      { apiVersion: 'qos-binding/v1', kind: 'RoutingOverlay', roles: ['application'], mediaType: 'application/json' },
    ],
    features: [], adapter: 'bim-core@1.0.0', source: 'bundled',
  },
  {
    id: 'bpmn-workflow/v1', namespace: 'bim.builtin', compatibleProfiles: ['qos-binding/v1'], extensionPoints: 0,
    types: [{ apiVersion: 'omg/bpmn/2.0.2', kind: 'BPMN', roles: ['application'], mediaType: 'application/vnd.omg.bpmn+xml' }],
    features: [], adapter: 'bim-bpmn@1.0.0', source: 'bundled',
  },
  {
    id: 'qos-binding-placement/v1', namespace: 'bim.builtin', compatibleProfiles: ['qos-binding/v1'], extensionPoints: 0,
    types: [{ apiVersion: 'qos-binding-placement/v1', kind: 'Placement', roles: ['application'], mediaType: 'application/json' }],
    features: [
      { dimension: 'placement', value: 'placement' },
      { dimension: 'irExtensions', value: 'qos-binding-placement/v1' },
    ],
    adapter: 'bim-placement@1.0.0', source: 'bundled',
  },
];

const ROLE_COPY: Record<string, { title: string; copy: string }> = {
  application: { title: 'Problem structure', copy: 'Tasks, metrics and a workflow expressed by an allowed source Dialect. Routing, BPMN and Placement occupy this Profile role without becoming extra core roles.' },
  candidateCatalog: { title: 'Available choices', copy: 'One or more catalogs publish typed capabilities, providers, properties and finite scalar metric values. They do not contain task-to-candidate lists.' },
  constraintSet: { title: 'Conditions', copy: 'Optional hard and soft assertions stay independently versioned. Soft constraints carry explicit penalties consumed by Optimization.' },
  optimization: { title: 'Decision preference', copy: 'Exactly one resource selects satisfy, weighted, lexicographic or Pareto semantics for this Profile.' },
};

const FALLBACK_DIMENSIONS = [
  ['workflowNodes', 'closed'], ['aggregations', 'closed'], ['metricScopes', 'closed'], ['constraints', 'closed'],
  ['optimization', 'closed'], ['expressions', 'closed'], ['placement', 'closed'], ['irExtensions', 'open'],
] as const;

function majorId(name: string, version: string): string {
  return `${name}/v${version.split('.')[0] || '1'}`;
}

function dialectDisplay(dialect: BimDialect): DialectDisplay {
  return {
    id: majorId(dialect.metadata.name, dialect.metadata.version),
    namespace: dialect.metadata.namespace,
    compatibleProfiles: dialect.spec.compatibleProfiles,
    types: dialect.spec.resourceTypes.map((type) => ({
      apiVersion: type.apiVersion,
      kind: type.kind,
      roles: type.roles,
      mediaType: type.mediaType,
    })),
    extensionPoints: dialect.spec.extensionPoints.length,
    features: dialect.spec.irFeatures,
    adapter: `${dialect.spec.adapter.id}@${dialect.spec.adapter.version}`,
    source: 'runtime',
  };
}

function cardinality(minimum: number, maximum?: number): string {
  if (minimum === 1 && maximum === 1) return 'exactly 1';
  if (minimum === 0 && maximum === 1) return '0 or 1';
  if (minimum === 0 && maximum === undefined) return '0 or more';
  if (minimum === 1 && maximum === undefined) return '1 or more';
  return maximum === undefined ? `${minimum} or more` : `${minimum}–${maximum}`;
}

export function Profiles() {
  const [profiles, setProfiles] = useState<BimProfile[]>([]);
  const [dialects, setDialects] = useState<BimDialect[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState('qos-binding/v1');
  const [selectedRole, setSelectedRole] = useState('application');
  const [selectedDialect, setSelectedDialect] = useState('bpmn-workflow/v1');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([apiClient.getProfiles(), apiClient.getDialects()])
      .then(([profileData, dialectData]) => {
        if (cancelled) return;
        setProfiles(profileData);
        setDialects(dialectData);
        const initialProfile = profileData.find((item) => item.id === 'qos-binding/v1') ?? profileData[0];
        if (initialProfile) {
          setSelectedProfileId(initialProfile.id);
          setSelectedRole(Object.keys(initialProfile.spec.roles)[0] ?? 'application');
        }
        const initialDialect = dialectData.find((item) => majorId(item.metadata.name, item.metadata.version) === 'bpmn-workflow/v1') ?? dialectData[0];
        if (initialDialect) setSelectedDialect(majorId(initialDialect.metadata.name, initialDialect.metadata.version));
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'The runtime catalogue could not be loaded.');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const profile = profiles.find((item) => item.id === selectedProfileId);
  const roles = useMemo<RoleDisplay[]>(() => profile
    ? Object.entries(profile.spec.roles).map(([id, role]) => ({ id, resourceTypes: role.resourceTypes, extensionTypes: role.extensionTypes }))
    : FALLBACK_ROLES, [profile]);
  const activeRole = roles.find((role) => role.id === selectedRole) ?? roles[0];
  const roleCopy = ROLE_COPY[activeRole?.id] ?? { title: activeRole?.id || 'Role', copy: 'This role is declared by the selected Profile.' };
  const dialectViews = dialects.length ? dialects.map(dialectDisplay) : FALLBACK_DIALECTS;
  const activeDialect = dialectViews.find((item) => item.id === selectedDialect) ?? dialectViews[0];
  const dimensions = profile
    ? Object.entries(profile.spec.capabilityVocabulary.dimensions).map(([name, value]) => [name, value.openValues ? 'open' : 'closed'] as const)
    : FALLBACK_DIMENSIONS;
  const limits = profile?.spec.limitVocabulary ?? ['maxTasks', 'maxCandidates', 'maxIterations', 'maxPopulation', 'maxSolutions', 'maxTimeBudgetMs'];
  const selectProfile = (id: string) => {
    setSelectedProfileId(id);
    const nextProfile = profiles.find((item) => item.id === id);
    if (nextProfile) setSelectedRole(Object.keys(nextProfile.spec.roles)[0] ?? 'application');
    const compatibleDialect = dialectViews.find((item) => item.compatibleProfiles.includes(id));
    if (compatibleDialect) setSelectedDialect(compatibleDialect.id);
  };

  return (
    <div className="profiles-page page-shell">
      <header className="page-intro profiles-intro">
        <div>
          <span className="kicker">02 · Explore the semantic frame</span>
          <h1 className="page-title">Profiles define what kind of binding problem this is.</h1>
        </div>
        <div>
          <p className="page-lede">
            The BIM core stays small. A Profile declares roles, allowed typed resources, cardinalities,
            output IR, feature vocabulary, limits and an installed adapter. Dialects decide how those roles are written.
          </p>
          <div className="catalog-state">
            <span className={!loading && !error ? 'is-live' : 'is-fallback'}><i className="status-dot" /> {loading ? 'Reading runtime catalogue…' : error ? 'Showing bundled contract facts' : 'Runtime catalogue is authoritative'}</span>
          </div>
        </div>
      </header>

      {error && <Alert type="warning" title="Runtime catalogue unavailable">{error} The explorer keeps the bundled v1 contract visible and marks it as a fallback.</Alert>}

      <section className="profile-explorer" aria-labelledby="profile-explorer-title">
        <div className="profile-index">
          <span className="section-label">Executable Profiles</span>
          <h2 id="profile-explorer-title">Runtime problem contracts</h2>
          <div className="profile-list">
            {(profiles.length ? profiles : [{ id: 'qos-binding/v1', metadata: { description: 'Deterministic scalar-QoS service composition and binding' } }]).map((item) => (
              <button
                key={item.id}
                type="button"
                className={selectedProfileId === item.id ? 'is-active' : ''}
                aria-pressed={selectedProfileId === item.id}
                onClick={() => selectProfile(item.id)}
              >
                <span>{profiles.length ? 'Executable on this host' : 'Bundled v1 contract'}</span>
                <strong>{item.id}</strong>
                <small>{item.metadata.description}</small>
              </button>
            ))}
          </div>
          <p className="profile-now-note">
            {profiles.length > 1 ? <><strong>This host:</strong> {profiles.length} executable Profiles are installed. Select one to inspect its complete contract.</> : <><strong>Today:</strong> only <code>qos-binding/v1</code> is shipped as an executable Profile. The extension model is broader than its first problem family.</>}
          </p>
        </div>

        <div className="profile-role-map">
          <div className="profile-role-heading">
            <div><span className="micro-label">Profile roles</span><h3>Choose a role to inspect its contract</h3></div>
            <code>{selectedProfileId}</code>
          </div>
          <Liquid
            className="role-liquid"
            blur={6}
            contrast={19}
            fill="var(--color-bg-elevated)"
            shadow="0 10px 24px rgba(23,33,29,.08)"
            filterPadding={18}
          >
            {roles.map((role, index) => (
              <Liquid.Item key={role.id} x={selectedRole === role.id ? 5 : 0} transition="snappy" delay={index * 18}>
                <button
                  type="button"
                  className={`liquid-role-button ${selectedRole === role.id ? 'is-active' : ''}`}
                  aria-pressed={selectedRole === role.id}
                  onClick={() => setSelectedRole(role.id)}
                >
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  <strong>{role.id}</strong>
                  <small>{role.resourceTypes.length} base type{role.resourceTypes.length === 1 ? '' : 's'} · {role.extensionTypes} extensions</small>
                </button>
              </Liquid.Item>
            ))}
          </Liquid>
          <p className="liquid-caption"><Puzzle aria-hidden="true" /> The restrained liquid seam appears only where Profile roles and typed resources conceptually join.</p>
        </div>

        <div className="role-detail" key={activeRole?.id}>
          <span className="micro-label">{activeRole?.id}</span>
          <h2>{roleCopy.title}</h2>
          <p>{roleCopy.copy}</p>
          <div className="role-type-list">
            {activeRole?.resourceTypes.map((type) => (
              <article key={`${type.apiVersion}/${type.kind}`}>
                <div><span>{type.apiVersion}</span><strong>{type.kind}</strong></div>
                <code>{cardinality(type.minimum, type.maximum)}</code>
              </article>
            ))}
          </div>
          <footer><Check aria-hidden="true" /> Compatible installed Dialects may contribute other resource types because this role sets <code>extensionTypes: installed</code>.</footer>
        </div>
      </section>

      <section className="profile-contract-section">
        <header className="profiles-section-header">
          <div><span className="section-label">One complete contract</span><h2>The Profile closes every semantic boundary.</h2></div>
          <p>There is no ambient compatibility. Every value below is either pinned by the Profile or compared against it.</p>
        </header>
        <div className="profile-contract-grid">
          <article className="contract-output">
            <span className="micro-label">Compilation output</span>
            <Braces aria-hidden="true" />
            <h3>{profile?.spec.output.apiVersion ?? 'bim/v1'} · {profile?.spec.output.kind ?? 'BindingProblem'}</h3>
            <p>Schema-pinned, closed IR sent under <code>{profile?.spec.output.engineProtocol ?? 'bim-engine/v1'}</code>.</p>
            <dl>
              <div><dt>Semantics</dt><dd>{profile?.spec.deterministic === false ? 'Non-deterministic' : 'Deterministic'}</dd></div>
              <div><dt>Adapter</dt><dd><code>{profile ? `${profile.spec.adapter.id}@${profile.spec.adapter.version}` : 'qos-binding-profile@1.0.0'}</code></dd></div>
            </dl>
          </article>
          <article className="contract-vocabulary">
            <span className="micro-label">Capability vocabulary</span>
            <h3>What modes may truthfully claim</h3>
            <div className="dimension-list">
              {dimensions.map(([name, openness]) => <span key={name} className={openness === 'open' ? 'is-open' : ''}><code>{name}</code><small>{openness}</small></span>)}
            </div>
            <p><code>irExtensions</code> is intentionally open. An Engine cannot use <code>all</code> for values that do not exist yet.</p>
          </article>
          <article className="contract-limits">
            <span className="micro-label">Limit vocabulary</span>
            <h3>Shared names, engine-specific ceilings</h3>
            <ul>{limits.map((limit) => <li key={limit}><Check aria-hidden="true" /><code>{limit}</code></li>)}</ul>
          </article>
        </div>
      </section>

      <section className="profile-extension-section">
        <header className="profiles-section-header">
          <div><span className="section-label">Reuse, specialize, or replace</span><h2>New problem Profiles can share a nucleus without sharing every rule.</h2></div>
          <p>A future contract chooses the smallest honest change. The UI distinguishes extension mechanisms from capabilities installed on this host.</p>
        </header>
        <div className="profile-evolution-map">
          <div className="shared-nucleus">
            <PackageCheck aria-hidden="true" />
            <span className="micro-label">Shared BIM nucleus</span>
            <h3>Instance envelope + resource identity + manifests + provenance</h3>
          </div>
          <article>
            <span>01 · Compatible Dialect</span><h3>Same Profile, new source vocabulary</h3>
            <p>Use an open role or declared inline extension point. Preserve the output IR and emit only declared features.</p>
            <code>schema + adapter + lowering</code>
          </article>
          <article>
            <span>02 · Specialized Profile</span><h3>Reuse typed languages, delimit the family</h3>
            <p>Declare a new full Profile with narrower roles, cardinalities, capability values or limits. Reused Dialects must explicitly list that Profile as compatible.</p>
            <code>no implicit extends field</code>
          </article>
          <article>
            <span>03 · Independent Profile</span><h3>Change the decision contract</h3>
            <p>Declare new roles, determinism, IR or semantics, then require Engine modes that explicitly target the new Profile and IR.</p>
            <code>new semantic boundary</code>
          </article>
        </div>
        <div className="profile-truth-note"><ShieldCheck aria-hidden="true" /><p>Profiles and Dialects become executable only through an atomic host installation. A BIM package can select installed contracts; it cannot install adapters, code or remote schemas.</p></div>
      </section>

      <section className="dialect-explorer">
        <header className="profiles-section-header">
          <div><span className="section-label">Vendor and standards vocabularies</span><h2>Dialects keep source ownership independent.</h2></div>
          <p>Each Dialect pins the identities it understands, the roles it may occupy, its schemas, adapter and emitted IR features.</p>
        </header>
        <div className="dialect-workbench">
          <div className="dialect-list" role="list">
            {dialectViews.map((dialect) => (
              <button key={dialect.id} type="button" className={activeDialect?.id === dialect.id ? 'is-active' : ''} onClick={() => setSelectedDialect(dialect.id)}>
                <span>{dialect.source === 'runtime' ? 'Installed on this host' : 'Bundled contract'}</span>
                <strong>{dialect.id}</strong>
                <small>{dialect.types.length} resource type{dialect.types.length === 1 ? '' : 's'} · {dialect.extensionPoints} inline points</small>
              </button>
            ))}
          </div>
          {activeDialect && <div className="dialect-detail" key={activeDialect.id}>
            <header><div><span className="micro-label">{activeDialect.namespace}</span><h3>{activeDialect.id}</h3></div><code>{activeDialect.adapter}</code></header>
            <div className="dialect-compatibility"><GitBranch aria-hidden="true" /><span>Compatible with</span>{activeDialect.compatibleProfiles.map((id) => <code key={id}>{id}</code>)}</div>
            <div className="dialect-types">
              {activeDialect.types.map((type) => <article key={`${type.apiVersion}/${type.kind}`}><div><span>{type.apiVersion}</span><strong>{type.kind}</strong></div><small>{type.mediaType}</small><p>role: {type.roles.join(', ')}</p></article>)}
            </div>
            <div className="dialect-features">
              <span className="micro-label">Emitted IR features</span>
              {activeDialect.features.length ? activeDialect.features.map((feature) => <code key={`${feature.dimension}/${feature.value}`}>{feature.dimension}={feature.value}</code>) : <p>No additional manifest-level IR feature declarations.</p>}
            </div>
          </div>}
        </div>
      </section>

      <section className="profiles-next">
        <span className="section-label">Next · See contracts in context</span>
        <h2>Open a progressive example, then watch analysis compute its compatible Engine modes.</h2>
        <div><Link to="/examples" viewTransition>Choose an example <ArrowRight aria-hidden="true" /></Link><Link to="/engines" viewTransition>Inspect engine compatibility</Link></div>
      </section>
    </div>
  );
}
