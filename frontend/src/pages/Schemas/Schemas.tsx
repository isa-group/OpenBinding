import { useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { apiClient, HttpError, type BimSchemaKind } from '../../api/client';
import { Button } from '../../components/ui/Button';
import { Chip } from '../../components/ui/Chip';
import { CopyField } from '../../components/ui/CopyField';
import { DataTable } from '../../components/ui/DataTable';
import { Notice } from '../../components/ui/Notice';
import { LanguageNav } from '../../components/ui/SectionNav';
import { Skeleton } from '../../components/ui/Skeleton';
import { useCopy } from '../../components/ui/useCopy';
import { useResource } from '../../utils/useResource';
import { SCHEMA_CATALOG, SCHEMA_GROUPS, resolveSchemaKind, schemaPath, type SchemaCatalogItem } from './schemaKinds';
import {
  buildFieldTree, flattenTree, isOpen, protocolOperations, schemaFacts,
  type Expansion, type Json,
} from './schemaTree';
import './Schemas.css';

function fileStem(kind: BimSchemaKind): string {
  return kind.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

function KindList({ current }: { current: BimSchemaKind | null }) {
  const [filter, setFilter] = useState('');
  const needle = filter.trim().toLowerCase();
  const matches = (item: SchemaCatalogItem) => !needle || `${item.kind} ${item.title}`.toLowerCase().includes(needle);
  return (
    <nav aria-label="Kinds" className="schemas-kinds">
      <label>
        <span className="sr-only">Filter kinds</span>
        <input type="search" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter kinds…" autoComplete="off" spellCheck={false} />
      </label>
      {SCHEMA_GROUPS.map((group) => {
        const items = SCHEMA_CATALOG.filter((item) => item.group === group && matches(item));
        return items.length > 0 && (
          <section key={group} aria-label={group}>
            <h2>{group}</h2>
            {items.map((item) => (
              <Link key={item.kind} to={schemaPath(item.kind)} aria-current={current === item.kind ? 'page' : undefined}>
                <span>{item.title}</span>
                <small>{item.boundary}</small>
              </Link>
            ))}
          </section>
        );
      })}
      {needle && SCHEMA_CATALOG.every((item) => !matches(item)) && <span className="schemas-none">No kind matches “{filter}”.</span>}
    </nav>
  );
}

function UnknownKind({ segment }: { segment: string }) {
  return (
    <Notice tone="error" title={`Unknown kind “${segment}” (404)`}>
      <span className="schemas-unknown">
        There’s no schema with that name. Valid kinds:
        <span className="schemas-unknown-kinds">
          {SCHEMA_CATALOG.map((item) => <Link key={item.kind} to={schemaPath(item.kind)}>{item.kind}</Link>)}
        </span>
      </span>
    </Notice>
  );
}

const LEGEND: ReadonlyArray<{ chip: string; className: string; text: string }> = [
  { chip: 'REQUIRED', className: 'is-required', text: 'must be present' },
  { chip: 'group', className: 'is-type', text: 'contains other fields' },
  { chip: 'list', className: 'is-type', text: 'repeats; “each item” shows one entry' },
  { chip: 'value', className: 'is-choice', text: 'allowed choices' },
];

function SchemaView({ kind, item }: { kind: BimSchemaKind; item: SchemaCatalogItem }) {
  const schema = useResource(`schema:${kind}`, () => apiClient.getBimSchema(kind));
  const { copy, status: copyStatus } = useCopy();
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<Expansion>('default');
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const payload: Json | undefined = schema.data;
  const tree = useMemo(() => (payload ? buildFieldTree(payload) : []), [payload]);
  const facts = useMemo(() => (payload ? schemaFacts(payload) : null), [payload]);
  const operations = useMemo(() => (kind === 'engine-contract' && payload ? protocolOperations(payload) : []), [kind, payload]);
  const state = { mode, overrides, query };
  const rows = flattenTree(tree, state);
  const protocolDigest = payload && typeof payload.digest === 'string' ? payload.digest : null;

  const toggle = (path: string, open: boolean) => setOverrides((current) => ({ ...current, [path]: !open }));
  const setAll = (next: Expansion) => {
    setMode(next);
    setOverrides({});
  };

  const download = () => {
    if (!payload) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `bim-v1-${fileStem(kind)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section aria-label="Schema" className="schemas-view" aria-live="polite" aria-busy={schema.status === 'loading'}>
      <div className="schemas-title">
        <div>
          <span className="schemas-boundary">{item.group} · {item.boundary}</span>
          <h2>{item.kind}</h2>
          {item.title !== item.kind && <span className="schemas-alias">{item.title}</span>}
          <p>{item.description}</p>
        </div>
        <div className="schemas-actions">
          <Button size="sm" variant="secondary" onClick={() => setAll('all')}>Expand all</Button>
          <Button size="sm" variant="secondary" onClick={() => setAll('none')}>Collapse all</Button>
          <Button size="sm" variant="ghost" onClick={download} disabled={!payload}><Download aria-hidden="true" /> Download JSON</Button>
        </div>
      </div>

      <div className="schemas-connections">
        <span>Connected contracts</span>
        <span className="schemas-unknown-kinds">
          {item.connectsTo.map((target) => <Link key={target} to={schemaPath(target)}>{SCHEMA_CATALOG.find((entry) => entry.kind === target)?.title ?? target}</Link>)}
        </span>
        {item.example && <Link className="schemas-example" to={`/workbench?example=${encodeURIComponent(item.example)}`}>Validate a package that uses it · <code>{item.example}</code></Link>}
      </div>

      <div className="schemas-legend" aria-label="Legend">
        {LEGEND.map((entry) => (
          <span key={entry.chip}><span className={`schemas-chip ${entry.className}`}>{entry.chip}</span>{entry.text}</span>
        ))}
      </div>

      {schema.status === 'loading' && (
        <>
          <Skeleton variant="tile" />
          <Skeleton variant="panel" />
        </>
      )}
      {schema.status === 'error' && (
        <Notice tone="error" action={<Button size="sm" variant="secondary" onClick={schema.reload}>Retry</Button>}>
          The {kind} schema couldn’t be loaded{schema.error instanceof HttpError ? ` (HTTP ${schema.error.status})` : ''}.
        </Notice>
      )}

      {payload && facts && (
        <>
          <dl className="schemas-facts">
            <div><dt>Schema identity</dt><dd className="is-mono">{facts.identity ?? item.title}</dd></div>
            <div><dt>{kind === 'engine-contract' ? 'Protocol schemas' : 'Root fields'}</dt><dd>{facts.rootFields}</dd></div>
            <div><dt>Required at root</dt><dd>{facts.requiredAtRoot}</dd></div>
            <div><dt>Reusable definitions</dt><dd>{facts.definitions}</dd></div>
          </dl>
          {protocolDigest && (
            <div className="schemas-digest"><span>Protocol digest</span><CopyField value={protocolDigest} label="protocol digest" truncate /></div>
          )}

          {tree.length > 0 ? (
            <>
              <label className="schemas-find">
                <span className="sr-only">Find a field</span>
                <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a field…" autoComplete="off" spellCheck={false} />
              </label>
              <div role="tree" aria-label={`${kind} fields`} className="schemas-tree">
                {rows.map(({ node, depth, hasChildren, matched }) => {
                  const open = isOpen(node, depth, state);
                  return (
                    <div
                      key={node.path}
                      role="treeitem"
                      aria-level={depth + 1}
                      aria-expanded={hasChildren ? open : undefined}
                      className={matched ? 'is-match' : undefined}
                      style={{ paddingInlineStart: `${14 + depth * 24}px` }}
                    >
                      {hasChildren
                        ? <button type="button" className="schemas-caret" aria-label={`${open ? 'Collapse' : 'Expand'} ${node.name}`} onClick={() => toggle(node.path, open)}>{open ? '−' : '+'}</button>
                        : <span className="schemas-caret-space" />}
                      <span className={node.name.startsWith('[') ? 'schemas-name' : 'schemas-name is-mono'}>{node.name === '[i]' ? 'each item' : node.name}</span>
                      <span className="schemas-chip is-type">{node.type}</span>
                      {node.required && <span className="schemas-chip is-required">REQUIRED</span>}
                      {node.unit && <Chip tone="accent">{node.unit}</Chip>}
                      <span className="schemas-desc">
                        {node.description}
                        {node.choices.map((choice) => <span key={choice} className="schemas-chip is-choice">{choice}</span>)}
                        {node.facts.map((fact) => <span key={fact} className="schemas-fact">{fact}</span>)}
                      </span>
                      <button type="button" className="schemas-copy" title={node.path || '/'} onClick={() => void copy(node.path, node.path)}>
                        {copyStatus(node.path) === 'copied' ? 'Copied' : 'Copy path'}
                      </button>
                    </div>
                  );
                })}
                {rows.length === 0 && <div className="schemas-none">No field matches “{query}”.</div>}
              </div>
            </>
          ) : (
            <div className="schemas-empty">This schema defines no named fields; it is a single value or a reference. Download it to see the exact document.</div>
          )}

          {operations.length > 0 && (
            <section aria-label="Protocol operations" className="schemas-operations">
              <h3>Calls of the protocol</h3>
              <DataTable label="Calls of the engine protocol" minWidth={520}>
                <thead><tr><th scope="col">Method</th><th scope="col">Path</th><th scope="col">What it does</th></tr></thead>
                <tbody>
                  {operations.map((operation) => (
                    <tr key={`${operation.method} ${operation.path}`}>
                      <td className="is-mono">{operation.method}</td>
                      <td className="is-mono">{operation.path}</td>
                      <td>{operation.summary || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            </section>
          )}
          <small className="schemas-note">Fields are read from the served schema (GET /v1/schemas/{kind}); the download is the exact document.</small>
        </>
      )}

      <div className="schemas-next">
        <span>See this kind in a full package.</span>
        <Link to="/examples">Open examples</Link>
        <Link to="/workbench">Validate a package</Link>
      </div>
    </section>
  );
}

/** `embedded`: shown inside the language hub, which draws the section navigation and gives the kind (`kind`) from its address. */
export function Schemas({ embedded = false, kind: kindProp }: { embedded?: boolean; kind?: string } = {}) {
  const { kind: paramKind = '' } = useParams();
  const segment = kindProp ?? paramKind;
  const kind = resolveSchemaKind(segment);
  const item = kind ? SCHEMA_CATALOG.find((entry) => entry.kind === kind) : undefined;

  return (
    <div className="schemas-page">
      <div className="schemas-head">
        {!embedded && <LanguageNav current="schemas" />}
        <h1>Schemas</h1>
        <p>
          What each part of a package contains: every field with its kind, whether it’s required, its unit and its allowed values. Use
          “Copy path” to match a validation message to its field.
        </p>
      </div>
      <div className="schemas-layout">
        <KindList current={kind} />
        {kind && item ? <SchemaView key={kind} kind={kind} item={item} /> : (
          <section aria-label="Schema" className="schemas-view"><UnknownKind segment={segment} /></section>
        )}
      </div>
    </div>
  );
}
