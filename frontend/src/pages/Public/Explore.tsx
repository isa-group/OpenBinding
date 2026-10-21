import { useState } from 'react';
import { Info, Search } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { apiClient, HttpError } from '../../api/client';
import { platformApi } from '../../api/platform';
import { Button } from '../../components/ui/Button';
import { CopyField } from '../../components/ui/CopyField';
import { Notice } from '../../components/ui/Notice';
import { PageHeader } from '../../components/ui/PageHeader';
import { Skeleton } from '../../components/ui/Skeleton';
import { TabBar, TabPanel } from '../../components/ui/TabBar';
import { useCopy } from '../../components/ui/useCopy';
import { useAuth } from '../../contexts/auth';
import { useResource } from '../../utils/useResource';
import {
  EXPLORE_TABS, engineItems, projectItems, publicationItems, searchText,
  type EngineItem, type ExploreItem, type ExploreTab, type ProjectItem, type PublicationItem,
} from './exploreModel';
import './Explore.css';

const EMPTY: Record<ExploreTab, { title: string; hint: string }> = {
  projects: { title: 'No public projects yet', hint: 'Projects appear here when an organization makes one public.' },
  publications: { title: 'No public publications yet', hint: 'A publication appears when a project admin publishes a frozen report edition.' },
  engines: { title: 'No public engines', hint: 'Private engines need an account and are never listed here.' },
};

function parseTab(value: string | null): ExploreTab {
  return EXPLORE_TABS.some((tab) => tab.id === value) ? value as ExploreTab : 'publications';
}

function failureText(error: unknown): string {
  if (error instanceof HttpError) return `HTTP ${error.status}`;
  return 'the gateway can’t be reached';
}

interface TabData {
  status: 'loading' | 'ready' | 'error';
  items: ExploreItem[];
  error: unknown;
  retry: () => void;
}

export function ExplorePage() {
  const [params, setParams] = useSearchParams();
  const tab = parseTab(params.get('tab'));
  const projects = useResource('projects', () => platformApi.publicProjects());
  const publications = useResource('publications', () => platformApi.publicPublications());
  const engines = useResource('engines', () => apiClient.getPublicEngines());
  // "See its publications" opens the tab with a search already typed; a new number rebuilds the tab.
  const [preset, setPreset] = useState({ n: 0, query: '' });

  const projectList = projects.data ?? null;
  const publicationList = publications.data ?? null;
  const data: Record<ExploreTab, TabData> = {
    projects: {
      status: projects.status, error: projects.error, retry: projects.reload,
      items: projectList ? projectItems(projectList, publicationList) : [],
    },
    publications: {
      status: publications.status, error: publications.error, retry: publications.reload,
      items: publicationList ? publicationItems(publicationList, projectList ?? []) : [],
    },
    engines: {
      status: engines.status, error: engines.error, retry: engines.reload,
      items: engines.data ? engineItems(engines.data) : [],
    },
  };

  const countOf = (id: ExploreTab) => (data[id].status === 'ready' ? data[id].items.length : data[id].status === 'error' ? '–' : '…');
  const select = (id: string) => {
    setPreset((current) => ({ n: current.n + 1, query: '' }));
    setParams({ tab: id });
  };
  const showPublicationsOf = (project: ProjectItem) => {
    setPreset((current) => ({ n: current.n + 1, query: project.project.name }));
    setParams({ tab: 'publications' });
  };

  return (
    <div className="explore-page">
      <PageHeader
        eyebrow="Explore"
        title="Public work on OpenBinding"
        lede="Projects their owners made public, frozen report editions and the engines anyone can run. Only public content is listed; private work never appears here."
      />
      <TabBar
        prefix="explore"
        ariaLabel="Explore sections"
        value={tab}
        onChange={select}
        items={EXPLORE_TABS.map((item) => ({ id: item.id, label: item.label, count: countOf(item.id) }))}
      />
      <TabPanel prefix="explore" active={tab}>
        <ExploreTabContent key={`${tab}:${preset.n}`} tab={tab} data={data[tab]} initialQuery={preset.query} onShowPublications={showPublicationsOf} />
      </TabPanel>
    </div>
  );
}

interface ContentProps {
  tab: ExploreTab;
  data: TabData;
  initialQuery: string;
  onShowPublications: (project: ProjectItem) => void;
}

function ExploreTabContent({ tab, data, initialQuery, onShowPublications }: ContentProps) {
  const { user } = useAuth();
  const [query, setQuery] = useState(initialQuery);
  const [group, setGroup] = useState('all');
  const [selectedId, setSelectedId] = useState('');
  const meta = EXPLORE_TABS.find((item) => item.id === tab) ?? EXPLORE_TABS[0];

  const groups = [...new Map(data.items.map((item) => [item.group, item.groupLabel])).entries()];
  const needle = query.trim().toLowerCase();
  const visible = data.items.filter((item) => (group === 'all' || item.group === group) && (!needle || searchText(item).includes(needle)));
  // Nothing chosen yet means the first row; a choice that a filter hides leaves the panel asking for another.
  const selected = selectedId ? visible.find((item) => item.id === selectedId) ?? null : visible[0] ?? null;

  return (
    <div className="explore-content">
      <div className="explore-controls">
        <label className="explore-search">
          <span className="sr-only">Search this tab</span>
          <Search aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`Search ${meta.noun}…`}
          />
        </label>
        {groups.length > 0 && (
          <div role="group" aria-label={tab === 'engines' ? 'Namespace filter' : 'Organization filter'} className="explore-pills">
            {[['all', tab === 'engines' ? 'All namespaces' : 'All organizations'] as const, ...groups].map(([key, label]) => (
              <button key={key} type="button" aria-pressed={group === key} onClick={() => setGroup(key)}>{label}</button>
            ))}
          </div>
        )}
        <span className="explore-cache-note">Filters apply to the loaded list · lists are cached for 60 s</span>
      </div>

      <div aria-live="polite" aria-busy={data.status === 'loading'}>
        {data.status === 'loading' && (
          <div className="explore-grid"><Skeleton /><Skeleton /><Skeleton /></div>
        )}
        {data.status === 'error' && (
          <Notice
            tone="error"
            action={<Button size="sm" variant="secondary" onClick={data.retry}>Retry</Button>}
          >
            {meta.label} couldn’t be loaded ({failureText(data.error)}). Your search and filters are kept.
          </Notice>
        )}
        {data.status === 'ready' && data.items.length === 0 && (
          <div className="explore-empty">
            <Search aria-hidden="true" />
            <strong>{EMPTY[tab].title}</strong>
            <span>{EMPTY[tab].hint}</span>
            {user && tab !== 'engines' && <Link to="/app">Open your projects</Link>}
          </div>
        )}
        {data.status === 'ready' && data.items.length > 0 && (
          <div className="explore-layout">
            <div className="explore-results">
              <span className="explore-count">{visible.length} public {visible.length === 1 ? meta.singular : meta.noun}</span>
              {visible.length === 0 && <div className="explore-none">No public {meta.noun} match “{query}”.</div>}
              <ul className="explore-grid">
                {visible.map((item) => (
                  <li key={item.id}>
                    <button type="button" aria-pressed={selected?.id === item.id} onClick={() => setSelectedId(item.id)}>
                      <span className="explore-card-meta">
                        <span className={`explore-glyph${item.tab === 'engines' ? ' is-engine' : ''}`} aria-hidden="true">{item.glyph}</span>
                        {item.meta}
                      </span>
                      <strong>{item.title}</strong>
                      <span className="explore-card-sub">{item.sub}</span>
                      <span className="explore-card-chips">{item.chips.map((chip) => <span key={chip}>{chip}</span>)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
            <aside aria-label="Details" className="explore-details">
              {!selected && <span className="explore-details-empty">Select an item to see its citation, digest and where to verify it.</span>}
              {selected?.tab === 'publications' && <PublicationDetails item={selected} />}
              {selected?.tab === 'projects' && <ProjectDetails item={selected} signedIn={Boolean(user)} onShowPublications={onShowPublications} />}
              {selected?.tab === 'engines' && <EngineDetails item={selected} />}
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}

function PublicationDetails({ item }: { item: PublicationItem }) {
  const { copy, status } = useCopy();
  return (
    <>
      <span className="explore-kind">Publication</span>
      <h2>{item.title}</h2>
      <dl>
        <dt>Authors</dt><dd>{item.authors ?? 'Not listed'}</dd>
        <dt>Year</dt><dd>{item.year ?? 'Not listed'}</dd>
        <dt>Published</dt><dd>{item.published ?? 'Not listed'}</dd>
        <dt>Where</dt><dd>{item.where}</dd>
      </dl>
      {item.digest && (
        <div className="explore-field">
          <span>Report edition digest</span>
          <CopyField value={item.digest} label="digest" truncate />
        </div>
      )}
      <div className="explore-citation">
        <span>Citation (as listed)</span>
        {item.citation}
        <button type="button" onClick={() => void copy(item.citation)}>{status() === 'copied' ? 'Citation copied' : 'Copy citation'}</button>
      </div>
      <small>BibTeX and a ready-made reference are generated on the verification page.</small>
      {item.digest
        ? <Link className="explore-action" to={`/resolve/report/${item.digest}`}>Open verification</Link>
        : <span className="explore-details-empty">This publication lists no digest, so it cannot be verified from here.</span>}
    </>
  );
}

function ProjectDetails({ item, signedIn, onShowPublications }: { item: ProjectItem; signedIn: boolean; onShowPublications: (item: ProjectItem) => void }) {
  return (
    <>
      <span className="explore-kind">Public project</span>
      <h2>{item.project.name}</h2>
      <p>{item.sub}</p>
      <dl>
        <dt>Organization</dt><dd>{item.organization.name} ({item.organization.slug})</dd>
        <dt>Slug</dt><dd className="is-mono">{item.project.slug}</dd>
        <dt>Publications</dt><dd>{item.publications}</dd>
      </dl>
      <div className="explore-info">
        <Info aria-hidden="true" />
        <span>Public projects are listed here and their publications verify by digest. Opening the project itself requires membership.</span>
      </div>
      {signedIn
        ? <Link className="explore-action" to={`/app/${item.organization.slug}/${item.project.slug}`}>Open project</Link>
        : <Link className="explore-action" to="/login">Log in to open as a member</Link>}
      <Button variant="secondary" onClick={() => onShowPublications(item)}>See its publications</Button>
    </>
  );
}

function EngineDetails({ item }: { item: EngineItem }) {
  return (
    <>
      <span className="explore-kind">Engine revision</span>
      <h2 className="is-mono">{item.ref}</h2>
      <dl>
        <dt>Modes</dt><dd>{item.modes}</dd>
        <dt>Options</dt><dd>{item.options}</dd>
        <dt>Digest</dt><dd className="is-mono">{item.digest}</dd>
      </dl>
      <Link className="explore-action" to={`/engines/${item.namespace}/${item.name}/${item.version}`}>Open engine</Link>
    </>
  );
}
