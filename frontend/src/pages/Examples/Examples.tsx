import { useMemo, useState } from 'react';
import { FlaskConical, Search, Waypoints } from 'lucide-react';
import { Link } from 'react-router-dom';
import { apiClient, HttpError } from '../../api/client';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { FilterPills } from '../../components/ui/FilterPills';
import { Notice } from '../../components/ui/Notice';
import { ProjectPicker } from '../../components/ui/ProjectPicker';
import { LanguageNav } from '../../components/ui/SectionNav';
import { Skeleton } from '../../components/ui/Skeleton';
import { useCopy } from '../../components/ui/useCopy';
import { useAuth } from '../../contexts/auth';
import { useResource } from '../../utils/useResource';
import { LESSONS, baseName, familyIdOf, familyOf, titleFromPath, type LessonMeta, type Shape } from './lessons';
import './Examples.css';

const FALLBACK_META = (path: string): LessonMeta => ({
  title: titleFromPath(path),
  concept: 'BIM package',
  outcome: 'Open the package in the workbench to see its Profile-directed resources.',
  shape: 'sequence',
  level: 5,
  tags: ['package'],
});

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

async function sha256(bytes: ArrayBuffer): Promise<string | null> {
  try {
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return `sha256-${[...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  } catch {
    return null;
  }
}

type Download =
  | { status: 'loading' }
  | { status: 'done'; digest: string | null; bytes: number }
  | { status: 'error'; code: string | null; message: string };

export function Examples() {
  const { user } = useAuth();
  const list = useResource('examples', () => apiClient.getBimExamples());
  const { copy, status: copyStatus } = useCopy();
  const [query, setQuery] = useState('');
  const [family, setFamily] = useState('all');
  const [downloads, setDownloads] = useState<Record<string, Download>>({});

  // Without the live list the bundled lesson index stands in, as it always has; opening a package still needs the gateway.
  const offline = list.status === 'error';
  const paths = useMemo(
    () => (offline ? Object.keys(LESSONS) : (list.data ?? []).filter((path) => path !== 'demo/05_single_obj_various')),
    [offline, list.data],
  );

  const examples = useMemo(() => paths.map((path) => ({ path, family: familyIdOf(path), meta: LESSONS[path] ?? FALLBACK_META(path) })), [paths]);
  const families = useMemo(() => {
    const order = ['demo', 'placement', 'bpmn', 'benchmark', 'literature'];
    const present = [...new Set(examples.map((example) => example.family))];
    return present.sort((a, b) => (order.indexOf(a) === -1 ? 99 : order.indexOf(a)) - (order.indexOf(b) === -1 ? 99 : order.indexOf(b)) || a.localeCompare(b));
  }, [examples]);

  const needle = query.trim().toLowerCase();
  const visible = examples.filter((example) => (
    (family === 'all' || example.family === family)
    && (!needle || `${example.path} ${example.meta.title} ${example.meta.concept} ${example.meta.tags.join(' ')}`.toLowerCase().includes(needle))
  ));
  const groups = families
    .map((id) => ({ family: familyOf(id), items: visible.filter((example) => example.family === id).sort((a, b) => a.meta.level - b.meta.level || a.path.localeCompare(b.path)) }))
    .filter((group) => group.items.length > 0);

  const download = async (path: string) => {
    setDownloads((current) => ({ ...current, [path]: { status: 'loading' } }));
    try {
      const bytes = await apiClient.getBimExamplePackage(path);
      const digest = await sha256(bytes);
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.bim+zip' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${baseName(path)}.bim.zip`;
      anchor.click();
      URL.revokeObjectURL(url);
      setDownloads((current) => ({ ...current, [path]: { status: 'done', digest, bytes: bytes.byteLength } }));
    } catch (error) {
      const code = error instanceof HttpError ? error.code ?? null : null;
      const message = error instanceof HttpError && error.status === 422
        ? 'This example package is corrupt (422 · invalid_example). The download stopped; other examples are unaffected.'
        : error instanceof Error ? error.message : 'The example could not be downloaded.';
      setDownloads((current) => ({ ...current, [path]: { status: 'error', code, message } }));
    }
  };

  return (
    <div className="examples-page">
      <div className="examples-head">
        <LanguageNav current="examples" />
        <h1>Example packages</h1>
        <p>
          Official BIM packages to learn from or start a case with. Download the .bim.zip or open it straight in the workbench to see its
          structure. All shipped lessons select <code>qos-binding/v1</code>; Placement demonstrates a compatible Dialect, not another Profile.
        </p>
      </div>

      <div className="examples-controls">
        <label className="examples-search">
          <span className="sr-only">Search examples</span>
          <Search aria-hidden="true" />
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by path…" autoComplete="off" spellCheck={false} />
        </label>
        <FilterPills
          ariaLabel="Family"
          options={[{ id: 'all', label: 'All' }, ...families.map((id) => ({ id, label: familyOf(id).label }))]}
          value={family}
          onChange={setFamily}
        />
      </div>

      <div aria-live="polite" aria-busy={list.status === 'loading'} className="examples-results">
        {list.status === 'loading' && <div className="examples-grid"><Skeleton /><Skeleton /><Skeleton /></div>}
        {offline && (
          <Notice tone="warning" title="Live catalogue unavailable" action={<Button size="sm" variant="secondary" onClick={list.reload}>Retry</Button>}>
            The example list couldn’t be loaded{list.error instanceof HttpError ? ` (HTTP ${list.error.status})` : ''}. Showing the bundled lesson index; opening a package still requires the gateway.
          </Notice>
        )}
        {list.status === 'ready' && examples.length === 0 && (
          <EmptyState icon={<FlaskConical />} title="No examples installed" action={<Link to="/workbench">Open the workbench</Link>}>
            This deployment doesn’t ship example packages. You can still validate your own package in the workbench.
          </EmptyState>
        )}
        {list.status !== 'loading' && examples.length > 0 && groups.length === 0 && (
          <EmptyState icon={<Search />} title="No example matches this view." action={<Button size="sm" variant="secondary" onClick={() => { setQuery(''); setFamily('all'); }}>Clear filters</Button>}>
            Try another search or family.
          </EmptyState>
        )}

        {groups.map((group) => (
          <section key={group.family.id} className="examples-group" aria-label={`${group.family.label} examples`}>
            <h2>{group.family.label} <span>· {group.items.length} {group.items.length === 1 ? 'package' : 'packages'}</span></h2>
            {group.family.description && <p>{group.family.description}</p>}
            <div className="examples-grid">
              {group.items.map(({ path, meta }) => {
                const state = downloads[path];
                return (
                  <article key={path} className="examples-card">
                    <div className="examples-card-head">
                      <span className="examples-glyph" aria-hidden="true">{group.family.glyph}</span>
                      <div>
                        <div className="examples-path">{path}</div>
                        <div className="examples-note">{meta.title} · {meta.concept}</div>
                      </div>
                      <span className="examples-level" title="Lesson level">Level {meta.level}</span>
                    </div>
                    <WorkflowGlyph shape={meta.shape} />
                    <p>{meta.outcome}</p>
                    {meta.compatibility && <small className="examples-compat"><Waypoints aria-hidden="true" /> {meta.compatibility}</small>}
                    <div className="examples-tags">{meta.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
                    {state?.status === 'done' && (
                      <div role="status" className="examples-done">
                        <span>{state.digest ?? `Downloaded ${state.bytes.toLocaleString('en-US')} bytes`}</span>
                        {state.digest && (
                          <button type="button" onClick={() => void copy(state.digest ?? '', path)}>{copyStatus(path) === 'copied' ? 'Copied' : 'Copy digest'}</button>
                        )}
                      </div>
                    )}
                    {state?.status === 'error' && (
                      <Notice tone="error" action={<Button size="sm" variant="secondary" onClick={() => void download(path)}>Retry</Button>}>{state.message}</Notice>
                    )}
                    <div className="examples-actions">
                      <Link className="examples-open" to={`/workbench?example=${encodeURIComponent(path)}`}>Open in workbench</Link>
                      <button type="button" disabled={state?.status === 'loading'} onClick={() => void download(path)}>
                        {state?.status === 'loading' ? 'Downloading…' : 'Download .bim.zip'}
                      </button>
                      {user
                        ? <ProjectPicker label="Import as case" destination={(org, project) => `/app/${org}/${project}/workbench?example=${encodeURIComponent(path)}`} />
                        : <Link className="examples-login" to="/login" title="Log in to import into a project">Log in to import</Link>}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
