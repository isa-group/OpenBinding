import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Braces, Check, Copy, Download, FileJson2, Network, Search } from 'lucide-react';
import { apiClient, type BimSchemaKind } from '../../api/client';
import { Alert } from '../../components/ui/Alert';
import './Schemas.css';

type SchemaGroup = 'Core & compilation' | 'Profile resources' | 'Extension & execution';

interface SchemaCatalogItem {
  kind: BimSchemaKind;
  title: string;
  group: SchemaGroup;
  description: string;
  boundary: string;
  connectsTo: BimSchemaKind[];
  example?: string;
}

const SCHEMA_CATALOG: SchemaCatalogItem[] = [
  { kind: 'Instance', title: 'Instance', group: 'Core & compilation', description: 'Small portable root index: selects one installed Profile and maps logical ids to local or immutable registered resources by Profile role.', boundary: 'Portable source root', connectsTo: ['Profile', 'Application', 'CandidateCatalog', 'ConstraintSet', 'Optimization'], example: 'demo/01_simple_seq' },
  { kind: 'Profile', title: 'Profile', group: 'Core & compilation', description: 'Executable semantic frame: roles, cardinalities, output IR, capability and limit vocabularies, plus a pinned installed adapter.', boundary: 'Problem-family contract', connectsTo: ['Instance', 'Dialect', 'BindingProblem', 'Engine'] },
  { kind: 'BindingProblem', title: 'BindingProblem', group: 'Core & compilation', description: 'Closed compiled IR produced by qos-binding/v1. It is Profile output sent to engines, not another name for the source Instance package.', boundary: 'Compiled execution IR', connectsTo: ['Profile', 'Engine', 'engine-contract'], example: 'demo/05_multi_obj' },
  { kind: 'Application', title: 'Application', group: 'Profile resources', description: 'Tasks, typed metrics and the native or externally represented workflow for qos-binding/v1.', boundary: 'application role', connectsTo: ['Instance', 'BindingProblem'], example: 'demo/02_parallel' },
  { kind: 'CandidateCatalog', title: 'CandidateCatalog', group: 'Profile resources', description: 'Typed capabilities, provider/property data, metric bindings and deterministic finite scalar QoS values.', boundary: 'candidateCatalog role', connectsTo: ['Instance', 'Application', 'BindingProblem'], example: 'demo/08_dependencies' },
  { kind: 'ConstraintSet', title: 'ConstraintSet', group: 'Profile resources', description: 'Independent hard and soft assertions expressed as the BIM expression AST or restricted CEL.', boundary: 'constraintSet role', connectsTo: ['Instance', 'Optimization', 'BindingProblem'], example: 'demo/07_soft_constraints' },
  { kind: 'Optimization', title: 'Optimization', group: 'Profile resources', description: 'Exactly one satisfy, weighted, lexicographic or Pareto decision preference for the current Profile.', boundary: 'optimization role', connectsTo: ['Instance', 'ConstraintSet', 'BindingProblem'], example: 'demo/12_many_obj_pareto' },
  { kind: 'Placement', title: 'Placement', group: 'Profile resources', description: 'Optional qos-binding-placement/v1 resource for pools, demands, capacity, directed network effects, security and pricing constraints.', boundary: 'Dialect resource in application role', connectsTo: ['Dialect', 'Application', 'BindingProblem', 'Engine'], example: 'placement/01_small_placement' },
  { kind: 'RoutingOverlay', title: 'RoutingOverlay', group: 'Profile resources', description: 'Separate deterministic branch probabilities and expected-count values; workflow structure remains representation-neutral.', boundary: 'application role', connectsTo: ['Application', 'BindingProblem'], example: 'demo/03_xor_choice' },
  { kind: 'Dialect', title: 'Dialect', group: 'Extension & execution', description: 'Independently versioned source-language contract: compatible Profiles, exact resource types or extension points, emitted IR features and pinned adapter.', boundary: 'Replaceable source vocabulary', connectsTo: ['Profile', 'Application', 'BindingProblem', 'Engine'] },
  { kind: 'Engine', title: 'Engine', group: 'Extension & execution', description: 'Portable immutable execution resource with Profile/IR-targeted modes, feature selectors, closed options, limits and truthful guarantees.', boundary: 'Public capability declaration', connectsTo: ['Profile', 'BindingProblem', 'EngineRegistration'], example: 'demo/10_large_scale' },
  { kind: 'EngineRegistration', title: 'EngineRegistration', group: 'Extension & execution', description: 'Private deployment manifest pinned to one exact Engine revision, HTTPS endpoint and bim-engine/v1 protocol digest.', boundary: 'Deployment and federation', connectsTo: ['Engine', 'engine-contract'] },
  { kind: 'engine-contract', title: 'Engine protocol', group: 'Extension & execution', description: 'Pinned bim-engine/v1 OpenAPI protocol between the gateway and local or remote Engine deployments. Only compiled Profile IR crosses it.', boundary: 'Engine protocol', connectsTo: ['BindingProblem', 'EngineRegistration'] },
];

const GROUPS: SchemaGroup[] = ['Core & compilation', 'Profile resources', 'Extension & execution'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fileStem(kind: BimSchemaKind): string {
  return kind.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

function valueType(value: unknown): string {
  if (!isRecord(value)) return Array.isArray(value) ? 'array' : typeof value;
  if (typeof value.type === 'string') return value.type;
  if (typeof value.$ref === 'string') return value.$ref.split('/').at(-1) || '$ref';
  if (Array.isArray(value.oneOf)) return `oneOf · ${value.oneOf.length}`;
  if (Array.isArray(value.anyOf)) return `anyOf · ${value.anyOf.length}`;
  return 'object';
}

export function Schemas() {
  const [selectedKind, setSelectedKind] = useState<BimSchemaKind>('Instance');
  const [schemas, setSchemas] = useState<Partial<Record<BimSchemaKind, Record<string, unknown>>>>({});
  const [loadingSchema, setLoadingSchema] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [view, setView] = useState<'map' | 'json'>('map');
  const [copiedPath, setCopiedPath] = useState('');

  useEffect(() => {
    if (schemas[selectedKind]) return;
    let cancelled = false;
    void apiClient.getBimSchema(selectedKind)
      .then((schema) => {
        if (!cancelled) setSchemas((current) => ({ ...current, [selectedKind]: schema }));
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : `Failed to load the ${selectedKind} schema`);
      })
      .finally(() => { if (!cancelled) setLoadingSchema(false); });
    return () => { cancelled = true; };
  }, [schemas, selectedKind]);

  const schema = schemas[selectedKind];
  const selectedItem = SCHEMA_CATALOG.find((item) => item.kind === selectedKind) ?? SCHEMA_CATALOG[0];
  const rootProperties = useMemo(() => {
    if (!schema) return [];
    const properties = isRecord(schema.properties) ? schema.properties : isRecord(schema.openapi) ? schema.openapi : {};
    return Object.entries(properties).filter(([name]) => name.toLowerCase().includes(searchQuery.trim().toLowerCase()));
  }, [schema, searchQuery]);
  const definitions = schema && isRecord(schema.$defs) ? Object.keys(schema.$defs) : [];
  const required = schema && Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === 'string') : [];

  const selectKind = (kind: BimSchemaKind) => {
    setSelectedKind(kind);
    setLoadingSchema(!schemas[kind]);
    setSearchQuery('');
    setExpandedPaths(new Set());
    setError(null);
    setCopiedPath('');
  };

  const downloadSchema = () => {
    if (!schema) return;
    const blob = new Blob([JSON.stringify(schema, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `bim-v1-${fileStem(selectedKind)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const copyToClipboard = (path: string) => {
    void navigator.clipboard.writeText(path).then(() => {
      setCopiedPath(path);
      window.setTimeout(() => setCopiedPath((current) => current === path ? '' : current), 1200);
    });
  };

  const togglePath = (path: string) => {
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const renderJsonTree = (value: unknown, path = '', level = 0): ReactElement => {
    if (value === null) return <span className="json-null">null</span>;
    if (typeof value !== 'object') return <span className={`json-${typeof value}`}>{JSON.stringify(value)}</span>;
    if (Array.isArray(value)) {
      if (value.length === 0) return <span className="json-array">[]</span>;
      const isExpanded = expandedPaths.has(path);
      return <div className="json-node">
        <button type="button" className="json-toggle" aria-expanded={isExpanded} onClick={() => togglePath(path)}>{isExpanded ? '−' : '+'} [{value.length}]</button>
        {isExpanded && <div className="json-children">{value.map((item, index) => <div key={index} className="json-item"><span className="json-key">{index}</span>{renderJsonTree(item, `${path}[${index}]`, level + 1)}</div>)}</div>}
      </div>;
    }
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object);
    if (keys.length === 0) return <span className="json-object">{'{}'}</span>;
    const isExpanded = expandedPaths.has(path) || level === 0;
    return <div className="json-node">
      {level > 0 ? <button type="button" className="json-toggle" aria-expanded={isExpanded} onClick={() => togglePath(path)}>{isExpanded ? '−' : '+'} {'{'}</button> : <span className="json-toggle">{'{'}</span>}
      {isExpanded && <div className="json-children">{keys.map((key) => {
        const childPath = path ? `${path}.${key}` : key;
        return <div key={key} className="json-item"><span className="json-key">{key}</span><button type="button" className="json-copy" onClick={() => copyToClipboard(childPath)} aria-label={`Copy JSON path ${childPath}`}><Copy aria-hidden="true" /> {copiedPath === childPath ? 'Copied' : 'Path'}</button>{renderJsonTree(object[key], childPath, level + 1)}</div>;
      })}</div>}
      <span className="json-bracket">{'}'}</span>
    </div>;
  };

  return (
    <div className="schemas-page page-shell">
      <header className="page-intro schemas-intro">
        <div><span className="kicker">05 · Inspect the contracts</span><h1 className="page-title">The specification is a connected system.</h1></div>
        <div><p className="page-lede">Move from the stable Instance container through Profile-directed resources and compiled IR to extension manifests and the Engine protocol. The exact JSON remains one click away.</p></div>
      </header>

      <section className="schema-workbench" aria-labelledby="schema-workbench-title">
        <aside className="schema-catalogue">
          <span className="section-label">Contract catalogue</span>
          <h2 id="schema-workbench-title">BIM v1 boundaries</h2>
          <label className="schema-kind-field">
            <span>Contract</span>
            <select aria-label="BIM v1 contract" value={selectedKind} onChange={(event) => selectKind(event.target.value as BimSchemaKind)}>
              {GROUPS.map((group) => <optgroup key={group} label={group}>{SCHEMA_CATALOG.filter((item) => item.group === group).map((item) => <option key={item.kind} value={item.kind}>{item.title}</option>)}</optgroup>)}
            </select>
          </label>
          <nav aria-label="BIM contract kinds">
            {GROUPS.map((group) => <section key={group}><h3>{group}</h3>{SCHEMA_CATALOG.filter((item) => item.group === group).map((item) => <button key={item.kind} type="button" className={selectedKind === item.kind ? 'is-active' : ''} aria-pressed={selectedKind === item.kind} onClick={() => selectKind(item.kind)}><span>{item.boundary}</span><strong>{item.title}</strong></button>)}</section>)}
          </nav>
        </aside>

        <div className="schema-content">
          <header className="schema-summary">
            <div><span className="micro-label">{selectedItem.group} · {selectedItem.boundary}</span><h2>{selectedItem.title}</h2><p>{selectedItem.description}</p></div>
            <div className="schema-summary-actions">
              <button type="button" onClick={downloadSchema} disabled={!schema}><Download aria-hidden="true" /> Download JSON</button>
              <Link to="/examples" viewTransition>See examples <ArrowRight aria-hidden="true" /></Link>
            </div>
          </header>

          <div className="schema-connections">
            <span className="micro-label">Connected contracts</span>
            <div><strong>{selectedItem.title}</strong><ArrowRight aria-hidden="true" />{selectedItem.connectsTo.map((kind) => <button key={kind} type="button" onClick={() => selectKind(kind)}>{SCHEMA_CATALOG.find((item) => item.kind === kind)?.title ?? kind}</button>)}</div>
            {selectedItem.example && <Link to={`/playground?example=${encodeURIComponent(selectedItem.example)}`} viewTransition>Open a connected package <code>{selectedItem.example}</code><ArrowRight aria-hidden="true" /></Link>}
          </div>

          <div className="schema-toolbar">
            <div className="schema-view-tabs" role="tablist" aria-label="Schema view">
              <button type="button" role="tab" aria-selected={view === 'map'} className={view === 'map' ? 'is-active' : ''} onClick={() => setView('map')}><Network aria-hidden="true" /> Property map</button>
              <button type="button" role="tab" aria-selected={view === 'json'} className={view === 'json' ? 'is-active' : ''} onClick={() => setView('json')}><FileJson2 aria-hidden="true" /> Exact JSON</button>
            </div>
            <label className="schema-search"><Search aria-hidden="true" /><span className="sr-only">Search schema properties</span><input type="search" name="schema-search" autoComplete="off" spellCheck={false} value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Filter root properties…" /></label>
          </div>

          {loadingSchema ? <div className="loading-state">Loading the pinned contract…</div> : error ? <Alert type="error" title="Schema unavailable">{error}</Alert> : !schema ? <Alert type="info">Select a BIM v1 contract.</Alert> : view === 'map' ? (
            <div className="schema-map" role="tabpanel">
              <div className="schema-facts">
                <article><span>Schema identity</span><code>{typeof schema.$id === 'string' ? schema.$id : typeof schema.protocol === 'string' ? schema.protocol : selectedItem.title}</code></article>
                <article><span>Root properties</span><strong>{rootProperties.length}</strong></article>
                <article><span>Required at root</span><strong>{required.length}</strong></article>
                <article><span>Reusable definitions</span><strong>{definitions.length}</strong></article>
              </div>
              <div className="property-map-heading"><div><Braces aria-hidden="true" /><span><small>Structure</small><strong>Root property map</strong></span></div><p>Required fields and references are shown without hiding the exact schema.</p></div>
              <div className="property-map">
                {rootProperties.length ? rootProperties.map(([name, value]) => {
                  const node = isRecord(value) ? value : {};
                  return <article key={name}><div><code>{name}</code>{required.includes(name) && <span>required</span>}</div><strong>{valueType(value)}</strong><p>{typeof node.description === 'string' ? node.description : typeof node.$ref === 'string' ? `Resolves ${node.$ref}` : 'See the exact JSON contract for nested constraints.'}</p><button type="button" onClick={() => copyToClipboard(`properties.${name}`)}><Copy aria-hidden="true" /> {copiedPath === `properties.${name}` ? 'Copied' : 'Copy path'}</button></article>;
                }) : <div className="property-map-empty"><p>{searchQuery ? 'No root property matches this filter.' : 'This document wraps its contract under a protocol or reusable definitions. Open Exact JSON to inspect it.'}</p></div>}
              </div>
              {definitions.length > 0 && <div className="definition-index"><span className="micro-label">$defs index</span><div>{definitions.map((name) => <button key={name} type="button" onClick={() => { setView('json'); setExpandedPaths(new Set(['$defs', `$defs.${name}`])); }}>{name}</button>)}</div></div>}
            </div>
          ) : (
            <div className="schema-json-panel" role="tabpanel"><div className="json-tree">{renderJsonTree(schema)}</div></div>
          )}
        </div>
      </section>

      <section className="schema-principles">
        <article><Check aria-hidden="true" /><span>Stable core</span><h3>Container contracts do not absorb domain semantics.</h3></article>
        <article><Check aria-hidden="true" /><span>Installed extension</span><h3>Schema validation without explicit lowering is not executable.</h3></article>
        <article><Check aria-hidden="true" /><span>Exact boundary</span><h3>Digests pin Profiles, Dialects, adapters, IR, Engines and protocol.</h3></article>
      </section>
    </div>
  );
}
