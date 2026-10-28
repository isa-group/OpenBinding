import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Layers, Search } from 'lucide-react';
import { apiClient, HttpError } from '../../api/client';
import { Action } from '../../components/ui/Action';
import { CopyField } from '../../components/ui/CopyField';
import { DataTable } from '../../components/ui/DataTable';
import { EmptyState } from '../../components/ui/EmptyState';
import { ErrorState } from '../../components/ui/ErrorState';
import { FilterPills } from '../../components/ui/FilterPills';
import { Notice } from '../../components/ui/Notice';
import { PageHeader } from '../../components/ui/PageHeader';
import { Skeleton } from '../../components/ui/Skeleton';
import { TabBar, TabPanel } from '../../components/ui/TabBar';
import { useAuth } from '../../contexts/auth';
import { shortDigest } from '../../utils/digest';
import { useResource, type Resource } from '../../utils/useResource';
import { StatusChip, ViewSource } from './EngineParts';
import {
  adapterRows, dialectRows, mediaLabel, resourceRows,
  type AdapterRow, type DialectRow, type ResourceRow,
} from './languageModel';
import './LangExtensions.css';

type TabId = 'dialects' | 'adapters' | 'resources';
type Origin = 'all' | 'builtin' | 'community';

const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: 'dialects', label: 'Dialects' },
  { id: 'adapters', label: 'Adapters' },
  { id: 'resources', label: 'Registered resources' },
];

const ORIGINS = [
  { id: 'all', label: 'All' },
  { id: 'builtin', label: 'Built in' },
  { id: 'community', label: 'Approved submissions' },
] as const;

const FLOW = [
  { n: '1', title: 'Submit', text: 'A fixed revision, checked against the rules for dialects or resources.' },
  { n: '2', title: 'Approval', text: 'A platform administrator approves it.' },
  { n: '3', title: 'Installed', text: 'Everyone can use it. A resource must be written in an installed dialect.' },
] as const;

function statusOf(resource: Resource<unknown>): number | null {
  return resource.status === 'error' && resource.error instanceof HttpError ? resource.error.status : null;
}

function DialectCard({ row, open, onToggle }: { row: DialectRow; open: boolean; onToggle: () => void }) {
  return (
    <article className="lang-card" aria-label={`Dialect ${row.name} ${row.version}`}>
      <header>
        <div className="lang-card-title">
          <h3>{row.name} <span>{row.version}</span></h3>
          <span className="lang-ref is-mono">{row.namespace} · <span title={row.digest}>{shortDigest(row.digest)}</span></span>
        </div>
        <span className="lang-chips">
          <StatusChip tone="success">Installed</StatusChip>
          <StatusChip tone={row.provenance.kind === 'builtin' ? 'info' : 'plain'}>{row.provenance.label}</StatusChip>
        </span>
      </header>
      {row.description && <p>{row.description}</p>}
      <dl className="lang-facts">
        <div><dt>Works with</dt><dd>{row.profiles.length ? row.profiles.map((profile) => <span key={profile} className="eng-value is-mono">{profile}</span>) : '—'}</dd></div>
        <div><dt>Adds</dt><dd>{row.resourceTypes.length} resource type{row.resourceTypes.length === 1 ? '' : 's'} · {row.extensionPoints.length} extension point{row.extensionPoints.length === 1 ? '' : 's'}</dd></div>
        <div><dt>Adapter</dt><dd className="is-mono">{row.adapter.id} {row.adapter.version}</dd></div>
        <div><dt>Provenance</dt><dd>{row.provenance.text}</dd></div>
      </dl>
      <Action size="sm" variant="secondary" className="lang-toggle" aria-expanded={open} onClick={onToggle}>
        {open ? 'Hide details' : `Details of ${row.name}`}
      </Action>
      {open && (
        <div className="lang-details">
          <h4>Resource types it adds</h4>
          {row.resourceTypes.length === 0 ? <span className="eng-muted">None. This dialect adds extension points instead.</span> : (
            <DataTable label={`Resource types of ${row.name}`} minWidth={560}>
              <thead><tr><th scope="col">Kind</th><th scope="col">Roles</th><th scope="col">File format</th><th scope="col">Schema fingerprint</th></tr></thead>
              <tbody>
                {row.resourceTypes.map((type) => (
                  <tr key={`${type.apiVersion}/${type.kind}/${type.mediaType}`}>
                    <td className="is-mono">{type.kind}</td>
                    <td>{type.roles.join(', ') || '—'}</td>
                    <td>{mediaLabel(type.mediaType)}{type.xmlRoot ? ` · root ${type.xmlRoot.localName}` : ''}</td>
                    <td className="is-mono" title={type.schemaDigest}>{shortDigest(type.schemaDigest)}</td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}
          {row.extensionPoints.length > 0 && (
            <>
              <h4>Extension points</h4>
              <ul className="lang-points">
                {row.extensionPoints.map((point) => (
                  <li key={`${point.target.kind}${point.pointer}`}>
                    <StatusChip tone="info">{point.target.kind}</StatusChip>
                    <span aria-hidden="true">→</span>
                    <code>{point.pointer}</code>
                    <small title={point.schemaDigest}>schema {shortDigest(point.schemaDigest)}</small>
                  </li>
                ))}
              </ul>
            </>
          )}
          {row.irFeatures.length > 0 && (
            <>
              <h4>Features it adds to problems</h4>
              <span className="lang-chips">
                {row.irFeatures.map((feature) => <StatusChip key={`${feature.dimension}=${feature.value}`} tone="info">{feature.dimension} = {feature.value}</StatusChip>)}
              </span>
            </>
          )}
          <h4>Adapter</h4>
          <dl className="lang-facts">
            <div><dt>Id</dt><dd className="is-mono">{row.adapter.id}</dd></div>
            <div><dt>Version</dt><dd className="is-mono">{row.adapter.version}</dd></div>
          </dl>
          <CopyField value={row.adapter.binaryDigest} label={`${row.adapter.id} binary fingerprint`} truncate />
          <ViewSource value={row.document} sourceLabel={`${row.name} dialect source`} filename={`${row.name}.dialect.json`} />
        </div>
      )}
    </article>
  );
}

function AdaptersTable({ rows }: { rows: AdapterRow[] }) {
  return (
    <DataTable label="Installed adapters" minWidth={640}>
      <thead><tr><th scope="col">Adapter</th><th scope="col">Version</th><th scope="col">Binary fingerprint</th><th scope="col">Used by</th><th scope="col">Status</th></tr></thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            <td className="is-mono">{row.id}</td>
            <td>{row.version}</td>
            <td className="is-mono" title={row.binaryDigest}>{shortDigest(row.binaryDigest)}</td>
            <td>
              <span className="lang-chips">
                {row.usedBy.map((use) => <span key={`${use.kind}${use.label}`} className="eng-value">{use.kind} · {use.label}</span>)}
              </span>
            </td>
            <td><StatusChip tone="success">Installed</StatusChip></td>
          </tr>
        ))}
      </tbody>
    </DataTable>
  );
}

function ResourcesTable({ rows }: { rows: ResourceRow[] }) {
  return (
    <DataTable label="Registered resources" minWidth={760}>
      <thead>
        <tr>
          <th scope="col">Resource</th><th scope="col">Kind</th><th scope="col">Role</th><th scope="col">Written in</th><th scope="col">Provenance</th><th scope="col">Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            <td>
              <strong>{row.name}</strong> <span className="lang-version">{row.version}</span>
              <span className="lang-ref is-mono">{row.namespace} · <span title={row.digest}>{shortDigest(row.digest)}</span></span>
            </td>
            <td className="is-mono">{row.kind}</td>
            <td>{row.role}</td>
            <td><span className="is-mono">{row.dialect}</span> · {mediaLabel(row.mediaType)}</td>
            <td><StatusChip tone={row.provenance.kind === 'builtin' ? 'info' : 'plain'}>{row.provenance.label}</StatusChip></td>
            <td><StatusChip tone="success">Published</StatusChip></td>
          </tr>
        ))}
      </tbody>
    </DataTable>
  );
}

/** lang-extensions: the dialects, adapters and resources that extend the language, with their version and where they come from. */
export function LangExtensions({ embedded = false }: { embedded?: boolean } = {}) {
  const { user, isAdmin } = useAuth();
  const username = user?.username ?? '';
  const [params, setParams] = useSearchParams();
  const tabParam = params.get('tab');
  const tab: TabId = TABS.some((item) => item.id === tabParam) ? tabParam as TabId : 'dialects';
  const [query, setQuery] = useState('');
  const [origin, setOrigin] = useState<Origin>('all');
  const [open, setOpen] = useState<string[]>([]);

  const dialects = useResource(`lang-dialects:${username}`, () => apiClient.getDialects());
  const profiles = useResource(`lang-profiles:${username}`, () => apiClient.getProfiles().catch(() => []));
  const resources = useResource(`lang-resources:${username}`, () => apiClient.getRegisteredResources());

  const dialectList = useMemo(() => dialectRows(dialects.data ?? dialects.stale ?? []), [dialects.data, dialects.stale]);
  const adapterList = useMemo(
    () => adapterRows(dialects.data ?? dialects.stale ?? [], profiles.data ?? profiles.stale ?? []),
    [dialects.data, dialects.stale, profiles.data, profiles.stale],
  );
  const resourceList = useMemo(() => resourceRows(resources.data ?? resources.stale ?? []), [resources.data, resources.stale]);

  const needle = query.trim().toLowerCase();
  const byOrigin = (kind: 'builtin' | 'community') => origin === 'all' || origin === kind;
  const shownDialects = dialectList.filter((row) => byOrigin(row.provenance.kind)
    && (!needle || `${row.namespace}/${row.name} ${row.version} ${row.adapter.id} ${row.resourceTypes.map((type) => type.kind).join(' ')}`.toLowerCase().includes(needle)));
  const shownAdapters = adapterList.filter((row) => !needle || `${row.id} ${row.version} ${row.usedBy.map((use) => use.label).join(' ')}`.toLowerCase().includes(needle));
  const shownResources = resourceList.filter((row) => byOrigin(row.provenance.kind)
    && (!needle || `${row.namespace}/${row.name} ${row.version} ${row.kind} ${row.role} ${row.dialect}`.toLowerCase().includes(needle)));

  const resourceTypeCount = dialectList.reduce((total, row) => total + row.resourceTypes.length, 0);
  const active = tab === 'dialects' ? dialects : tab === 'adapters' ? dialects : resources;
  const activeStatus = statusOf(active) ?? (tab === 'adapters' ? statusOf(profiles) : null);
  const loading = active.status === 'loading' && !(active.data ?? active.stale);
  const unauthorized = activeStatus === 401;
  const forbidden = activeStatus === 403;
  const failed = active.status === 'error' && !unauthorized && !forbidden;
  const ready = !unauthorized && !forbidden && !loading;

  const setTab = (id: string) => {
    const next = new URLSearchParams(params);
    if (id === 'dialects') next.delete('tab'); else next.set('tab', id);
    setParams(next, { replace: true });
  };
  const toggle = (key: string) => setOpen((current) => (current.includes(key) ? current.filter((item) => item !== key) : [...current, key]));

  return (
    <div className="lang-page">
      {!embedded && (
        <nav aria-label="Breadcrumb" className="eng-crumbs">
          <span className="eng-crumb"><Link to="/app" viewTransition>Home</Link><span aria-hidden="true">/</span></span>
          <span className="eng-crumb"><span aria-current="page">Language extensions</span></span>
        </nav>
      )}
      <PageHeader
        eyebrow="Language"
        title="Language extensions"
        lede="Teach OpenBinding new kinds of resources. A dialect declares them; registered resources are documents written in them. Each submission is a fixed revision that an administrator approves before anyone can use it."
        actions={embedded ? undefined : <Action to="/language" variant="secondary">Profiles and installed dialects</Action>}
      />

      <section className="lang-kpis" aria-label="What is installed">
        <div><strong>{dialects.status === 'ready' ? dialectList.length : '…'}</strong><span>Dialects installed</span></div>
        <div><strong>{dialects.status === 'ready' ? adapterList.length : '…'}</strong><span>Adapters</span></div>
        <div><strong>{dialects.status === 'ready' ? resourceTypeCount : '…'}</strong><span>Resource types</span></div>
        <div><strong>{resources.status === 'ready' ? resourceList.length : '…'}</strong><span>Registered resources</span></div>
      </section>

      <TabBar
        prefix="lang-ext"
        ariaLabel="Sections"
        value={tab}
        onChange={setTab}
        items={[
          { id: 'dialects', label: 'Dialects', count: dialects.status === 'ready' ? dialectList.length : '…' },
          { id: 'adapters', label: 'Adapters', count: dialects.status === 'ready' ? adapterList.length : '…' },
          { id: 'resources', label: 'Registered resources', count: resources.status === 'ready' ? resourceList.length : '…' },
        ]}
      />

      <TabPanel prefix="lang-ext" active={tab}>
        {ready && (
          <div className="lang-controls">
            <label className="lang-search">
              <span className="sr-only">Search extensions</span>
              <Search aria-hidden="true" />
              <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by name, kind or adapter…" autoComplete="off" spellCheck={false} />
            </label>
            {tab !== 'adapters' && <FilterPills ariaLabel="Provenance" options={ORIGINS} value={origin} onChange={(id) => setOrigin(id as Origin)} />}
          </div>
        )}

        {loading && (
          <div className="lang-skeleton" aria-busy="true" aria-live="polite">
            <span className="sr-only">Loading language extensions</span>
            <Skeleton variant="tile" /><Skeleton variant="tile" /><Skeleton variant="tile" />
          </div>
        )}

        {unauthorized && <ErrorState variant="401" layout="card" />}

        {forbidden && (
          <Notice tone="error" title="This API key can’t read the language catalog (403)" action={<Link to="/app/account/keys">Manage API keys</Link>}>
            The key behind this session doesn’t include the permission to read this part of the language. Use your session, or a key that does.
          </Notice>
        )}

        {failed && (
          <Notice tone="error" action={<Action size="sm" variant="secondary" onClick={() => { dialects.reload(); profiles.reload(); resources.reload(); }}>Retry</Action>}>
            {active.stale ? 'The list couldn’t refresh. You’re seeing the last one loaded.' : 'The language extensions couldn’t be loaded'} ({statusOf(active) ? `HTTP ${statusOf(active)}` : 'the gateway can’t be reached'}).
          </Notice>
        )}

        {tab === 'dialects' && ready && !failed && dialects.status === 'ready' && (
          dialectList.length === 0 ? (
            <EmptyState icon={<Layers />} dashed title="No dialects installed">
              Dialects appear here once an administrator approves them. Until then the language is the one the profiles define.
            </EmptyState>
          ) : shownDialects.length === 0 ? (
            <EmptyState icon={<Search />} title="No dialect matches">Clear the search or the provenance filter to see every dialect.</EmptyState>
          ) : (
            <ul className="lang-grid" aria-label="Installed dialects">
              {shownDialects.map((row) => (
                <li key={row.key}><DialectCard row={row} open={open.includes(row.key)} onToggle={() => toggle(row.key)} /></li>
              ))}
            </ul>
          )
        )}

        {tab === 'adapters' && ready && !failed && dialects.status === 'ready' && (
          adapterList.length === 0 ? (
            <EmptyState icon={<Layers />} dashed title="No adapters installed">An adapter is the code that lowers a dialect or profile to the engine language. None is installed.</EmptyState>
          ) : shownAdapters.length === 0 ? (
            <EmptyState icon={<Search />} title="No adapter matches">Clear the search to see every adapter.</EmptyState>
          ) : (
            <>
              <AdaptersTable rows={shownAdapters} />
              <span className="eng-muted">An adapter is deployed with the gateway. Approving a dialect never installs code: its adapter must already be deployed.</span>
            </>
          )
        )}

        {tab === 'resources' && ready && !failed && resources.status === 'ready' && (
          resourceList.length === 0 ? (
            <EmptyState icon={<Layers />} dashed title="No resources registered yet">
              Registered resources appear here once an administrator approves them. A resource has to be written in an installed dialect.
            </EmptyState>
          ) : shownResources.length === 0 ? (
            <EmptyState icon={<Search />} title="No resource matches">Clear the search or the provenance filter to see every resource.</EmptyState>
          ) : (
            <ResourcesTable rows={shownResources} />
          )
        )}
      </TabPanel>

      <section className="lang-flow" aria-label="How an extension becomes available">
        {FLOW.map((step) => (
          <div key={step.n}>
            <span aria-hidden="true">{step.n}</span>
            <span><strong>{step.title}</strong>{step.text}</span>
          </div>
        ))}
      </section>
      <span className="eng-muted">
        Submissions are made through the API (<code>POST /v1/dialects</code>, <code>POST /v1/resources</code>) and are not listed here until approved.
        {isAdmin && <> Approving is moderation: it needs a platform administrator account and the “moderate extensions” permission. See <Link to="/app/admin/moderation">Moderation</Link>.</>}
      </span>
    </div>
  );
}
