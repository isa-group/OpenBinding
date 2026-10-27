import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { casesApi, type SnapshotAnalysis, type SnapshotPins } from '../../api/cases';
import { platformApi } from '../../api/platform';
import type { Organization, Project, Snapshot } from '../../api/platform';
import { parseBindingSpace } from '../../components/BindingSpaceBadge/bindingSpace';
import { SourceView } from '../../components/rendering/SourceView';
import { Action } from '../../components/ui/Action';
import { Chip } from '../../components/ui/Chip';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { TabBar, TabPanel } from '../../components/ui/TabBar';
import { useCopy } from '../../components/ui/useCopy';
import { useAuth } from '../../contexts/auth';
import { shortDigest } from '../../utils/digest';
import { formatBytes, formatDateTime } from '../../utils/format';
import { readZipArchive, type ZipArchive } from '../../utils/zipExplorer';
import { useResource } from '../../utils/useResource';
import { saveBytes } from '../Project/download';
import { ProjectGate, ProjectSkeleton } from '../Project/parts';
import { loadCases } from '../Project/projectData';
import { useRouteProject } from '../Project/useRouteProject';
import { formatFeature } from '../../utils/featureRange';
import { rangeCandidates, readBindingProblem, powerText, type BindingModel } from './bindingModel';
import { classifyAuthError, marker, snapshotFailureKind, type AuthFailure } from './caseErrors';
import { CaseFrame, CaseMissing } from './parts';
// The snapshot styles keep the name of the page that used to hold them.
import '../Platform/SnapshotPage.css';

type Analysis = { state: 'ok'; result: SnapshotAnalysis } | { state: 'failed'; failure: AuthFailure };
type DownloadKind = 'archive' | 'source' | 'ir';
type Download = { state: 'busy' | 'done' } | { state: 'failed'; message: string };

const FINGERPRINTS: ReadonlyArray<{ key: 'instance' | 'package' | 'compiled'; label: string; what: string }> = [
  { key: 'instance', label: 'Instance', what: 'What was described' },
  { key: 'package', label: 'Package', what: 'The .bim.zip as uploaded' },
  { key: 'compiled', label: 'Compiled form', what: 'What engines read' },
];

const SNAPSHOT_TABS = [{ id: 'overview', label: 'Overview' }, { id: 'source', label: 'Source' }] as const;

/** The case revision that points at this snapshot, if the project has one. */
async function findOrigin(org: string, project: string, snapshotId: string) {
  try {
    for (const entry of await loadCases(org, project)) {
      const revision = entry.revisions.find((candidate) => candidate.source_snapshot_id === snapshotId);
      if (revision) return { item: entry.item, revision };
    }
  } catch {
    /* the case list is a convenience here, never a reason to hide the snapshot */
  }
  return null;
}

function Pins({ pins }: { pins: SnapshotPins }) {
  const files = Object.entries(pins.fileDigests);
  const resources = Object.entries(pins.resourceDigests);
  return (
    <details className="snap-pins">
      <summary>Per-file and per-resource fingerprints</summary>
      <div className="snap-pins-grid">
        <table className="case-table">
          <caption>Files ({files.length})</caption>
          <thead><tr><th scope="col">File</th><th scope="col">Fingerprint</th></tr></thead>
          <tbody>{files.map(([path, digest]) => <tr key={path}><th scope="row"><code>{path}</code></th><td><code title={digest}>{digest}</code></td></tr>)}</tbody>
        </table>
        <table className="case-table">
          <caption>Resources ({resources.length})</caption>
          <thead><tr><th scope="col">Resource</th><th scope="col">Fingerprint</th></tr></thead>
          <tbody>{resources.map(([id, digest]) => <tr key={id}><th scope="row"><code>{id}</code></th><td><code title={digest}>{digest}</code></td></tr>)}</tbody>
        </table>
      </div>
    </details>
  );
}

/** The Source tab: the compiled form, or the files of the package (the archive is read only when that view opens). */
// [impl->req~frontend-snapshot-source-tab~1]
function SourceViewer({ snapshot, snapshotId }: { snapshot: Snapshot; snapshotId: string }) {
  const [tab, setTab] = useState<'ir' | 'files'>('ir');
  const [file, setFile] = useState<string | null>(null);
  const archive = useResource<ZipArchive | null>(`archive:${snapshotId}:${tab === 'files' ? 'on' : 'off'}`, async () => (
    tab === 'files' ? readZipArchive(await platformApi.snapshotArchive(snapshotId)) : null
  ));
  const entries = (archive.data ?? archive.stale)?.entries.filter((entry) => !entry.dir) ?? [];
  const chosen = entries.find((entry) => entry.path === file) ?? entries[0];
  const text = useResource<string>(`archive-file:${snapshotId}:${chosen?.path ?? ''}`, async () => (chosen ? chosen.readText() : ''));

  return (
    <section className="snap-source" aria-label="Source">
      <div className="snap-source-body">
        <div className="snap-tabs" role="group" aria-label="Source to view">
          <button type="button" aria-pressed={tab === 'ir'} onClick={() => setTab('ir')} disabled={!snapshot.ir}>Compiled form (JSON)</button>
          <button type="button" aria-pressed={tab === 'files'} onClick={() => setTab('files')}>Files in the package</button>
        </div>
        {tab === 'ir' && snapshot.ir && (
          <SourceView source={snapshot.ir.document as object} label="Compiled form (JSON)" language="json" filename={`snapshot-${snapshotId}-compiled.json`} maxHeight="30rem" />
        )}
        {tab === 'ir' && !snapshot.ir && <p className="org-muted">No compiled form is stored for this snapshot.</p>}
        {tab === 'files' && archive.status === 'loading' && <Skeleton variant="tile" />}
        {tab === 'files' && archive.status === 'error' && (
          <Notice tone="warning" action={<Action variant="secondary" size="sm" onClick={archive.reload}>Retry</Action>}>
            The package couldn’t be opened{marker(classifyAuthError(archive.error))}.
          </Notice>
        )}
        {tab === 'files' && entries.length > 0 && (
          <div className="snap-files">
            <ul aria-label="Files in the package">
              {entries.map((entry) => (
                <li key={entry.path}>
                  <button type="button" aria-pressed={entry.path === chosen?.path} onClick={() => setFile(entry.path)}>
                    <code>{entry.path}</code><small>{formatBytes(entry.size)?.split(' (')[0] ?? ''}</small>
                  </button>
                </li>
              ))}
            </ul>
            <SourceView source={text.data ?? text.stale ?? ''} label={chosen?.path ?? 'file'} language={chosen?.path.endsWith('.json') ? 'json' : 'text'} filename={chosen?.name} maxHeight="30rem" />
          </div>
        )}
      </div>
    </section>
  );
}

function Summary({ analysis, model, originLink }: { analysis: Analysis | undefined; model: BindingModel | null; originLink: ReactNode }) {
  if (!analysis) return <div role="status" aria-busy="true"><span className="sr-only">Reading what the engines receive…</span><Skeleton variant="tile" /></div>;
  if (analysis.state === 'failed' && analysis.failure.status === 409) {
    return (
      <Notice tone="error">
        The compiled form doesn’t match this snapshot any more (409 · analysis unavailable), so its summary is hidden. Downloads and fingerprints are still exact.
      </Notice>
    );
  }
  const combos = analysis.state === 'ok' ? parseBindingSpace(analysis.result.analysis.bindingSpace) : null;
  const figures = analysis.state === 'ok'
    ? [
      { value: String(analysis.result.analysis.tasks), label: 'tasks' },
      { value: String(analysis.result.analysis.candidates), label: 'candidates' },
      { value: String(analysis.result.analysis.constraints), label: 'rules' },
      { value: String(model?.criteria.length ?? '—'), label: 'goal terms' },
      { value: combos ? `10^${Math.round(combos.log10 * 10) / 10}` : '—', label: 'combinations' },
    ]
    : model
      ? [
        { value: String(model.tasks.length), label: 'tasks' },
        { value: String(model.candidateCount), label: 'candidates' },
        { value: String(model.rules.length), label: 'rules' },
        { value: String(model.criteria.length), label: 'goal terms' },
        { value: powerText(model.log10), label: 'combinations (up to)' },
      ]
      : [];
  return (
    <>
      {analysis.state === 'failed' && (
        <Notice tone="warning">
          {analysis.failure.kind === 'quota'
            ? `This snapshot is bigger than your plan allows you to run${marker(analysis.failure)}. The figures below are read from the compiled form.`
            : `The gateway’s own analysis isn’t available right now${marker(analysis.failure)}. The figures below are read from the compiled form.`}
        </Notice>
      )}
      {figures.length === 0 && <p className="org-muted">There is no compiled form to summarize for this snapshot.</p>}
      {figures.length > 0 && (
        <ul className="case-glance" aria-label="What the engines receive">
          {figures.map((figure) => <li key={figure.label}><b>{figure.value}</b><span>{figure.label}</span></li>)}
        </ul>
      )}
      {analysis.state === 'ok' && combos && combos.bigVal > 1n && (
        <span className="org-muted">Exactly {combos.exact} possible bindings.</span>
      )}
      {analysis.state === 'ok' && Array.isArray(analysis.result.compatibleModes) && (
        <span className="org-muted">{analysis.result.compatibleModes.length === 1 ? '1 engine mode can run it.' : `${analysis.result.compatibleModes.length} engine modes can run it.`}</span>
      )}
      <RangeNotice model={model} analysis={analysis} />
      {originLink}
    </>
  );
}

/** The ranges a package carries, and what that means for the engines: only a mode that declares interval values can run it. */
function RangeNotice({ model, analysis }: { model: BindingModel | null; analysis: Analysis }) {
  const ranged = model ? rangeCandidates(model) : [];
  if (ranged.length === 0) return null;
  const modes = analysis.state === 'ok' && Array.isArray(analysis.result.compatibleModes) ? analysis.result.compatibleModes : null;
  const refused = modes ? modes.filter((mode) => typeof mode === 'object' && mode !== null && (mode as { compatible?: unknown }).compatible === false).length : null;
  return (
    <section className="case-ranges" aria-label="Range features">
      <Notice tone="warning" title={ranged.length === 1 ? '1 candidate has range features' : `${ranged.length} candidates have range features`}>
        Engines that only accept single values can’t run it{refused ? ` (${refused} of ${modes?.length ?? 0} modes listed refuse it)` : ''}.
        {' '}Only a mode that declares interval values accepts ranges. <Link className="ui-notice-link" to="/engines" viewTransition>See the engines</Link>
      </Notice>
      <ul className="case-range-list" aria-label="Candidates with ranges">
        {ranged.map((entry) => (
          <li key={`${entry.task}/${entry.candidate}`}>
            <code>{entry.candidate}</code>
            {entry.features.map((feature) => (
              <span key={feature.name} className="case-range" title={formatFeature(feature.value, { long: true })}>{feature.name} {formatFeature(feature.value)}</span>
            ))}
          </li>
        ))}
      </ul>
    </section>
  );
}

function SnapshotBody({ organization, project, snapshotId }: { organization: Organization; project: Project; snapshotId: string }) {
  const { user } = useAuth();
  const { copy, status } = useCopy();
  const root = `/app/${organization.slug}/${project.slug}`;
  const snapshot = useResource(`snapshot:${snapshotId}`, () => platformApi.snapshot(snapshotId));
  const pins = useResource<SnapshotPins | null>(`pins:${snapshotId}`, () => casesApi.instance(snapshotId).catch(() => null));
  const origin = useResource(`origin:${organization.slug}/${project.slug}/${snapshotId}`, () => findOrigin(organization.slug, project.slug, snapshotId));
  const analysis = useResource<Analysis>(`analysis:${snapshotId}`, () => casesApi.analyseSnapshot(snapshotId).then(
    (result): Analysis => ({ state: 'ok', result }),
    (caught: unknown): Analysis => ({ state: 'failed', failure: classifyAuthError(caught) }),
  ));
  const [downloads, setDownloads] = useState<Partial<Record<DownloadKind, Download>>>({});
  const [view, setView] = useState<'overview' | 'source'>('overview');

  const trail = [{ label: 'Workbench', to: `${root}/workbench` }, { label: `Snapshot ${snapshotId.slice(0, 4)}…${snapshotId.slice(-2)}` }];
  const failure = snapshot.status === 'error' ? classifyAuthError(snapshot.error) : null;

  if (snapshot.status === 'loading') {
    return (
      <CaseFrame organization={organization} project={project} trail={trail}>
        <div role="status" aria-busy="true"><span className="sr-only">Loading the snapshot…</span><Skeleton variant="card" /><Skeleton variant="panel" /></div>
      </CaseFrame>
    );
  }
  if (failure || !snapshot.data) {
    const kind = failure ? snapshotFailureKind(failure) : 'missing';
    return (
      <CaseFrame organization={organization} project={project} trail={trail}>
        {kind === 'key' && (
          <Notice tone="warning">This API key doesn’t include “read instances” (403). Use a session or a key with that permission.</Notice>
        )}
        {kind === 'missing' && (
          <CaseMissing title="Snapshot not found" actions={<Action to={`${root}/cases`} variant="primary">All cases</Action>}>
            Snapshots open for whoever made them, or for members of an organization whose cases use them. Otherwise we answer as if it didn’t exist (404).
          </CaseMissing>
        )}
        {kind === 'other' && failure && (
          <Notice tone="error" action={<Action variant="secondary" size="sm" onClick={snapshot.reload}>Retry</Action>}>
            The snapshot couldn’t be loaded{marker(failure)}.
          </Notice>
        )}
      </CaseFrame>
    );
  }

  const data = snapshot.data;
  const model = data.ir ? readBindingProblem(data.ir.document) : null;
  const digests: Record<'instance' | 'package' | 'compiled', string | null> = { instance: data.instanceDigest, package: data.packageDigest, compiled: data.ir?.digest ?? null };
  const mine = Boolean(user && data.ownerId && data.ownerId === user.id);
  const found = origin.data;
  const originLink = found
    ? <Link to={`${root}/cases/${found.item.slug}/revisions/${found.revision.revision}`} viewTransition>See the full model of revision {found.revision.revision}</Link>
    : null;

  const download = async (kind: DownloadKind) => {
    setDownloads((current) => ({ ...current, [kind]: { state: 'busy' } }));
    try {
      if (kind === 'archive') saveBytes(await platformApi.snapshotArchive(snapshotId), `snapshot-${snapshotId}.bim.zip`, 'application/zip');
      else if (kind === 'source') saveBytes(await casesApi.instanceSource(snapshotId), `snapshot-${snapshotId}-source.bim.zip`, 'application/vnd.bim+zip');
      else saveBytes(new TextEncoder().encode(JSON.stringify(await casesApi.instanceIr(snapshotId), null, 2)).buffer as ArrayBuffer, `snapshot-${snapshotId}-compiled.json`, 'application/json');
      setDownloads((current) => ({ ...current, [kind]: { state: 'done' } }));
    } catch (caught) {
      const reason = classifyAuthError(caught);
      setDownloads((current) => ({ ...current, [kind]: { state: 'failed', message: `The download didn’t finish${marker(reason)}.` } }));
    }
  };

  const downloadCards: Array<{ kind: DownloadKind; label: string; detail: string }> = [
    { kind: 'archive', label: 'Package archive', detail: `snapshot-${snapshotId.slice(0, 8)}.bim.zip · ${formatBytes(data.archiveSize) ?? 'size unknown'}` },
    { kind: 'source', label: 'Source files', detail: 'As uploaded, before compiling' },
    { kind: 'ir', label: 'Compiled form', detail: 'For tools that read the engine input (JSON)' },
  ];

  return (
    <CaseFrame organization={organization} project={project} trail={trail}>
      <header className="proj-title-row">
        <div className="proj-title">
          <h1>Compiled snapshot</h1>
          <p>
            Made by {mine ? 'you' : 'a member'} · {formatDateTime(data.createdAt) ?? 'sealed'}
            {found && <> · from <Link to={`${root}/cases/${found.item.slug}`} viewTransition>{found.item.name}</Link> revision {found.revision.revision}</>}
            {' '}· never changes
          </p>
        </div>
        <div className="proj-actions">
          {project.access !== 'public_read' && <Action to={`${root}/jobs/new?snapshot=${encodeURIComponent(snapshotId)}`} variant="primary">Run from this snapshot</Action>}
          <Action variant={project.access === 'public_read' ? 'primary' : 'secondary'} onClick={() => void copy([`instance ${data.instanceDigest}`, `package ${data.packageDigest}`, ...(data.ir ? [`compiled ${data.ir.digest}`] : [])].join('\n'), 'all')}>
            {status('all') === 'copied' ? `Copied all ${data.ir ? 'three' : 'two'}` : status('all') === 'failed' ? 'Copy failed' : 'Copy all fingerprints'}
          </Action>
        </div>
      </header>

      <TabBar items={SNAPSHOT_TABS} value={view} onChange={(id) => setView(id as 'overview' | 'source')} ariaLabel="Snapshot views" prefix="snap-view" />
      <TabPanel prefix="snap-view" active={view}>
      {view === 'source' && <SourceViewer snapshot={data} snapshotId={snapshotId} />}
      {view === 'overview' && (
      <>
      <section className="org-section" aria-labelledby="sd-fingerprints">
        <h2 id="sd-fingerprints">Fingerprints</h2>
        <div className="snap-digests">
          {FINGERPRINTS.map((entry) => {
            const digest = digests[entry.key];
            return (
              <div className="snap-digest" key={entry.key}>
                <span className="snap-digest-label">{entry.label}</span>
                <code title={digest ?? undefined}>{digest ? shortDigest(digest) : 'not stored'}</code>
                <span className="org-muted">{entry.what}</span>
                {digest && (
                  <button type="button" className="case-link-button" onClick={() => void copy(digest, entry.key)} aria-label={`Copy full ${entry.label.toLowerCase()} fingerprint`}>
                    {status(entry.key) === 'copied' ? 'Copied' : status(entry.key) === 'failed' ? 'Copy failed' : 'Copy full fingerprint'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
        {pins.data && <Pins pins={pins.data} />}
      </section>

      <section className="org-section" aria-labelledby="sd-language">
        <h2 id="sd-language">Exact language used</h2>
        {model ? (
          <div className="proj-chips">
            <Chip tone="accent">Profile · {model.profile ?? 'not stated'}</Chip>
            <Chip>{model.dialects.length === 0 ? 'Dialects · none' : `Dialects · ${model.dialects.map((dialect) => dialect.label).join(', ')}`}</Chip>
            <Chip>{model.adapters.length === 0 ? 'Adapters · none stated' : `Adapters · ${model.adapters.join(', ')}`}</Chip>
          </div>
        ) : <p className="org-muted">The compiled form isn’t stored, so the language it used can’t be listed.</p>}
      </section>

      <section className="org-section" aria-labelledby="sd-engines">
        <h2 id="sd-engines">What the engines receive</h2>
        <Summary analysis={analysis.data} model={model} originLink={originLink} />
      </section>

      <section className="org-section" aria-labelledby="sd-downloads">
        <h2 id="sd-downloads">Downloads</h2>
        <div className="snap-downloads">
          {downloadCards.map((card) => {
            const state = downloads[card.kind];
            return (
              <button type="button" key={card.kind} className="snap-download" onClick={() => void download(card.kind)} disabled={state?.state === 'busy'}>
                <strong>{card.label}</strong>
                <span>{card.detail}</span>
                <em>{state?.state === 'busy' ? 'Preparing…' : state?.state === 'done' ? 'Downloaded' : state?.state === 'failed' ? state.message : 'Download'}</em>
              </button>
            );
          })}
        </div>
      </section>
      </>
      )}
      </TabPanel>
    </CaseFrame>
  );
}

/** A compiled snapshot (`snap-detail`, `/app/:org/:project/snapshots/:snapshot`): its fingerprints, what engines receive and the files to download. */
export function SnapshotDetail() {
  const { snapshot: snapshotId = '' } = useParams();
  const { orgSlug, projectSlug, organization, project, waiting, failure, reload } = useRouteProject();
  if (waiting) return <ProjectSkeleton />;
  if (!organization || !project) {
    return <ProjectGate failure={organization ? failure : null} orgSlug={orgSlug} projectSlug={projectSlug} organizationName={organization?.name} onRetry={reload} />;
  }
  return <SnapshotBody key={snapshotId} organization={organization} project={project} snapshotId={snapshotId} />;
}
