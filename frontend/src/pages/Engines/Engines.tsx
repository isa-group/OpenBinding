import { useMemo, useState } from 'react';
import { Monitor, Search } from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  apiClient,
  HttpError,
  type EngineCatalogEntry,
  type EngineRegistrationRevision,
} from '../../api/client';
import { platformApi, type EngineRevision } from '../../api/platform';
import { Button } from '../../components/ui/Button';
import { DataTable } from '../../components/ui/DataTable';
import { EmptyState } from '../../components/ui/EmptyState';
import { FilterPills } from '../../components/ui/FilterPills';
import { Notice } from '../../components/ui/Notice';
import { PageHeader } from '../../components/ui/PageHeader';
import { Skeleton } from '../../components/ui/Skeleton';
import { useAuth } from '../../contexts/auth';
import { useResource } from '../../utils/useResource';
import {
  BUILTIN_NAMESPACE, engineRows, familyOptions, glyphOf, modeRows, shortDigest,
  type EngineRow, type ModeRow,
} from './enginesModel';
import { MyDeployments } from './MyDeployments';
import './Engines.css';

interface CatalogData {
  /** Whose view this is; the last list is only kept for a failed refresh by the same account. */
  forUser: string | null;
  engines: EngineCatalogEntry[];
  fellBackToPublic: boolean;
  revisions: EngineRevision[];
  registrations: EngineRegistrationRevision[];
}

/** Public engines for a visitor; for a signed-in account the visible list plus what the gateway says about each revision. */
async function loadCatalog(username: string | null): Promise<CatalogData> {
  if (!username) return { forUser: null, engines: await apiClient.getPublicEngines(), fellBackToPublic: false, revisions: [], registrations: [] };
  const catalog = await apiClient.getCatalogEngines();
  if (catalog.fellBackToPublic) return { ...catalog, forUser: username, revisions: [], registrations: [] };
  // Visibility and publication are extras: the list is useful without them.
  const [revisions, registrations] = await Promise.all([
    platformApi.engineRevisions().then((body) => body.revisions ?? [], () => []),
    apiClient.listEngineRegistrations().catch(() => []),
  ]);
  return { ...catalog, forUser: username, revisions, registrations };
}

function statusOf(error: unknown): number | null {
  return error instanceof HttpError ? error.status : null;
}

export function Engines() {
  const { user } = useAuth();
  const username = user?.username ?? null;
  const catalog = useResource(`engines:${username ?? 'visitor'}`, () => loadCatalog(username));
  const [query, setQuery] = useState('');
  const [family, setFamily] = useState('all');
  const [compared, setCompared] = useState<string[]>([]);

  // On a failed refresh the last list that arrived stays on screen, but never one that belonged to another account.
  const data = catalog.data ?? (catalog.stale?.forUser === username ? catalog.stale : undefined);
  const rows = useMemo(
    () => (data ? engineRows(data.engines, { username, revisions: data.revisions, registrations: data.registrations }) : []),
    [data, username],
  );
  const needle = query.trim().toLowerCase();
  const visible = rows.filter((row) => {
    const text = `${row.engine.namespace}/${row.engine.name} ${row.engine.version} ${row.engine.modes.map((mode) => mode.id).join(' ')}`.toLowerCase();
    return (family === 'all' || row.family === family) && (!needle || text.includes(needle));
  });
  const modes = visible.flatMap((row) => modeRows(row.engine));
  const comparing = compared.map((id) => modes.find((mode) => mode.id === id)).filter((mode): mode is ModeRow => Boolean(mode));

  const toggleCompare = (id: string) => {
    setCompared((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      return [...current, id].slice(-2);
    });
  };

  const status = catalog.status;
  const failure = status === 'error' ? statusOf(catalog.error) : null;
  const forbidden = failure === 403;
  const fellBack = Boolean(data?.fellBackToPublic);
  const sessionView = Boolean(user) && !fellBack;
  const showList = (data?.engines.length ?? 0) > 0 && !forbidden;

  return (
    <div className="engines-page">
      <PageHeader
        eyebrow="Engines"
        title="Engine catalog"
        lede="Every engine is addressed by its exact identity: namespace, name, version and digest. Pick the revision and mode you’ll run or study."
        actions={user && (
          <>
            <Link className="engines-action" to="/app/engines/registrations">My registrations</Link>
            <Link className="engines-action is-primary" to="/app/engines/new">Register engine</Link>
          </>
        )}
      />

      <Notice tone="info" action={!user ? <Link to="/login">Log in</Link> : undefined}>
        {sessionView
          ? 'Showing engines visible to your account: public revisions plus private ones you own. API keys see only the engines in their exact list.'
          : 'Showing public engines. Log in to also see private engines you own.'}
      </Notice>

      <div className="engines-controls">
        <label className="engines-search">
          <span className="sr-only">Search engines</span>
          <Search aria-hidden="true" />
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by name or namespace…" autoComplete="off" spellCheck={false} />
        </label>
        <FilterPills ariaLabel="Family" options={familyOptions(rows)} value={family} onChange={setFamily} />
      </div>

      <div className="engines-results" aria-live="polite" aria-busy={status === 'loading' && !data}>
        {status === 'loading' && !data && (
          <>
            <div className="engines-grid"><Skeleton /><Skeleton /><Skeleton /></div>
            <Skeleton variant="panel" />
          </>
        )}

        {forbidden && (
          <Notice tone="warning" title="This API key can’t list engines (403 · insufficient_api_key_permission)">
            Missing permission: <code>engines:read</code>. A key is always limited to what you choose when you create it; create a key that
            includes this permission. Engines outside a key’s exact list answer 404, so they never appear.{' '}
            <Link to="/app/account/keys">Manage API keys</Link>
          </Notice>
        )}

        {status === 'error' && !forbidden && (
          <Notice tone="error" action={<Button size="sm" variant="secondary" onClick={catalog.reload}>Retry</Button>}>
            {data
              ? `The catalog couldn’t refresh (${failure ?? 'network error'}). You’re seeing the last list loaded.`
              : `The catalog couldn’t be loaded (${failure ? `HTTP ${failure}` : 'the gateway can’t be reached'}).`}
          </Notice>
        )}

        {fellBack && (
          <Notice tone="info" action={<Link to="/login">Log in</Link>}>
            Your session expired (401), so the catalog fell back to the public view. Your private engines are hidden until you log in again.
          </Notice>
        )}

        {status === 'ready' && data && data.engines.length === 0 && (
          <EmptyState icon={<Monitor />} title="No engines visible to you">
            Private engines need an account, and you only see the ones you own or that were published. You can register a federated
            engine if your plan allows it (BASIC: 1 engine).
          </EmptyState>
        )}

        {showList && (
          <>
            <section aria-label="Engines" className="engines-section">
              <span className="engines-count">{visible.length} engine {visible.length === 1 ? 'revision' : 'revisions'}</span>
              {visible.length === 0 ? (
                <EmptyState icon={<Search />} title={`No revision matches “${query}”.`}>Clear the search or the family filter to see every engine.</EmptyState>
              ) : (
                <ul className="engines-grid">
                  {visible.map((row) => <EngineCard key={row.key} row={row} />)}
                </ul>
              )}
            </section>

            {modes.length > 0 && (
              <section aria-labelledby="cap-title" className="engines-section">
                <div className="engines-section-heading">
                  <h2 id="cap-title">Capabilities by mode</h2>
                  <span>Select two modes to compare them</span>
                </div>
                <DataTable label="Mode capabilities" minWidth={760}>
                  <thead>
                    <tr>
                      <th scope="col" className="engines-check-col"><span className="sr-only">Compare</span></th>
                      <th scope="col">Engine · mode</th>
                      <th scope="col">Placement</th>
                      <th scope="col">IR extensions</th>
                      <th scope="col">Options (unit, default)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {modes.map((mode) => (
                      <tr key={mode.id} className={compared.includes(mode.id) ? 'is-selected' : undefined}>
                        <td><input type="checkbox" checked={compared.includes(mode.id)} onChange={() => toggleCompare(mode.id)} aria-label={`Compare ${mode.label}`} /></td>
                        <td className="is-mono">{mode.label}</td>
                        <td>{mode.placement}</td>
                        <td className="is-mono">{mode.irExtensions}</td>
                        <td>{mode.options}</td>
                      </tr>
                    ))}
                  </tbody>
                </DataTable>
                {comparing.length === 2 && (
                  <div className="engines-compare" aria-label="Comparison">
                    {comparing.map((mode) => (
                      <div key={mode.id}>
                        <strong className="is-mono">{mode.label}</strong>
                        <span><span>Placement:</span> {mode.placement}</span>
                        <span><span>IR extensions:</span> {mode.irExtensions}</span>
                        <span><span>Options:</span> {mode.options}</span>
                      </div>
                    ))}
                  </div>
                )}
                <span className="engines-footnote">“Not declared” means the engine’s contract doesn’t list that capability; it isn’t a claim that the mode lacks it.</span>
              </section>
            )}

            <section aria-labelledby="rev-title" className="engines-section">
              <h2 id="rev-title">Revisions</h2>
              <DataTable label="Engine revisions" minWidth={760}>
                <thead>
                  <tr>
                    <th scope="col">Namespace</th>
                    <th scope="col">Name</th>
                    <th scope="col">Version</th>
                    <th scope="col">Digest</th>
                    <th scope="col">Visibility</th>
                    <th scope="col">Publication</th>
                    <th scope="col"><span className="sr-only">Open</span></th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((row) => (
                    <tr key={row.key}>
                      <td className="is-mono">{row.engine.namespace}</td>
                      <td className="is-mono">{row.engine.name}</td>
                      <td>{row.engine.version}</td>
                      <td className="is-mono" title={row.engine.digest}>{shortDigest(row.engine.digest)}</td>
                      <td>{row.visibility === 'public' ? 'Public' : 'Private'}</td>
                      <td>{row.publication.charAt(0).toUpperCase() + row.publication.slice(1)}</td>
                      <td><Link to={row.href} aria-label={`Open ${row.engine.name} ${row.engine.version}`}>Open</Link></td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            </section>
          </>
        )}
      </div>

      {user && <MyDeployments username={user.username} onChanged={catalog.reload} />}
    </div>
  );
}

function EngineCard({ row }: { row: EngineRow }) {
  const { engine } = row;
  const builtin = engine.namespace === BUILTIN_NAMESPACE;
  return (
    <li>
      <Link to={row.href} className="engines-card">
        <span className="engines-card-meta">
          <span className={`engines-glyph${builtin ? '' : ' is-private'}`} aria-hidden="true">{glyphOf(engine.name)}</span>
          <span className="is-mono">{engine.namespace}</span>
        </span>
        <span className="engines-card-title">{engine.name} <span>{engine.version}</span></span>
        <span className="engines-card-chips">
          {engine.modes.length === 0 && <span className="engines-mode">no modes advertised</span>}
          {engine.modes.map((mode) => <span key={mode.id} className="engines-mode">mode · {mode.id}</span>)}
        </span>
        <span className="engines-card-tags">
          <span className="is-mono" title={engine.digest}>{shortDigest(engine.digest)}</span>
          {row.chips.map((chip) => <span key={chip}>{chip}</span>)}
        </span>
      </Link>
    </li>
  );
}
