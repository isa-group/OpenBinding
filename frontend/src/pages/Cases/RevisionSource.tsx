import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Organization } from '../../api/platform';
import { problemsApi, type CompilationIr, type Problem, type ProblemCompilation, type ProblemRevision, type ProblemRevisionDetail } from '../../api/problems';
import { parseBindingSpace } from '../../components/BindingSpaceBadge/bindingSpace';
import { SourceView } from '../../components/rendering/SourceView';
import { Action } from '../../components/ui/Action';
import { Chip } from '../../components/ui/Chip';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { useCopy } from '../../components/ui/useCopy';
import { problemsPath } from '../../routes/paths/problems';
import { formatBytes } from '../../utils/format';
import { readZipArchive, type ZipArchive } from '../../utils/zipExplorer';
import { useResource } from '../../utils/useResource';
import { saveBytes } from '../../features/workspace/download';
import { formatFeature } from '../../utils/featureRange';
import { rangeCandidates, readBindingProblem, powerText, type BindingModel } from './bindingModel';
import { sourceFailureKind } from './caseErrors';
import { classifyAuthError, marker, type AuthFailure } from '../../shared/api/errors';
import { CaseMissing } from './parts';
// The source styles keep the name of the page that used to hold them.
import './RevisionSource.css';

type Compiled = { state: 'ok'; compilation: ProblemCompilation; ir: CompilationIr } | { state: 'failed'; failure: AuthFailure };
type DownloadKind = 'source' | 'ir';
type Download = { state: 'busy' | 'done' } | { state: 'failed'; message: string };

const FINGERPRINTS: ReadonlyArray<{ key: 'instance' | 'package' | 'compiled'; label: string; what: string }> = [
  { key: 'instance', label: 'Instance', what: 'What was described' },
  { key: 'package', label: 'Package', what: 'The .bim.zip as uploaded' },
  { key: 'compiled', label: 'Compiled form', what: 'What engines read (installed toolchain)' },
];

function Pins({ detail }: { detail: ProblemRevisionDetail }) {
  const { copy, status } = useCopy();
  const files = detail.files.map((file) => [file.path, file.digest] as const);
  const resources = Object.entries(detail.resource_digests);
  const copyCell = (kind: string, name: string, digest: string) => {
    const key = `${kind}:${name}`;
    return (
      <button type="button" className="case-link-button" onClick={() => void copy(digest, key)} aria-label={`Copy digest of ${name}`}>
        {status(key) === 'copied' ? 'Copied' : status(key) === 'failed' ? 'Copy failed' : 'Copy digest'}
      </button>
    );
  };
  return (
    <details className="snap-pins">
      <summary>Per-file and per-resource fingerprints</summary>
      <div className="snap-pins-grid">
        <table className="case-table">
          <caption>Files ({files.length})</caption>
          <thead><tr><th scope="col">File</th><th scope="col">Fingerprint</th></tr></thead>
          <tbody>{files.map(([path, digest]) => <tr key={path}><th scope="row"><code>{path}</code></th><td>{copyCell('file', path, digest)}</td></tr>)}</tbody>
        </table>
        <table className="case-table">
          <caption>Resources ({resources.length})</caption>
          <thead><tr><th scope="col">Resource</th><th scope="col">Fingerprint</th></tr></thead>
          <tbody>{resources.map(([id, digest]) => <tr key={id}><th scope="row"><code>{id}</code></th><td>{copyCell('resource', id, digest)}</td></tr>)}</tbody>
        </table>
      </div>
    </details>
  );
}

/** The Source tab: the files of the package as uploaded, or the compiled form (the archive is read only when that view opens). */
function SourceViewer({ org, problem, revision, ir }: { org: string; problem: string; revision: ProblemRevision; ir: CompilationIr | null }) {
  const [tab, setTab] = useState<'files' | 'ir'>('files');
  const [file, setFile] = useState<string | null>(null);
  const key = `${org}/${problem}/${revision.id}`;
  const archive = useResource<ZipArchive | null>(`archive:${key}:${tab === 'files' ? 'on' : 'off'}`, async () => (
    tab === 'files' ? readZipArchive(await problemsApi.source(org, problem, revision.revision)) : null
  ));
  const entries = (archive.data ?? archive.stale)?.entries.filter((entry) => !entry.dir) ?? [];
  const chosen = entries.find((entry) => entry.path === file) ?? entries[0];
  const text = useResource<string>(`archive-file:${key}:${chosen?.path ?? ''}`, async () => (chosen ? chosen.readText() : ''));

  return (
    <section className="snap-source" aria-label="Source">
      <div className="snap-source-body">
        <div className="snap-tabs" role="group" aria-label="Source to view">
          <button type="button" aria-pressed={tab === 'files'} onClick={() => setTab('files')}>Files in the package</button>
          <button type="button" aria-pressed={tab === 'ir'} onClick={() => setTab('ir')} disabled={!ir}>Compiled form (JSON)</button>
        </div>
        {tab === 'ir' && ir && (
          <SourceView source={ir.ir as object} label="Compiled form (JSON)" language="json" filename={`${problem}-v${revision.revision}-compiled.json`} maxHeight="30rem" />
        )}
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

function Summary({ analysis, model }: { analysis: Compiled | undefined; model: BindingModel | null }) {
  if (!analysis) return <div role="status" aria-busy="true"><span className="sr-only">Reading what the engines receive…</span><Skeleton variant="tile" /></div>;
  if (analysis.state === 'failed' && analysis.failure.code === 'revision_not_recompilable') {
    return (
      <Notice tone="error">
        The installed toolchain refuses this package (422 · revision_not_recompilable), so it can’t be compiled again. The package and its fingerprints are still exact.
      </Notice>
    );
  }
  const combos = analysis.state === 'ok' ? parseBindingSpace(analysis.compilation.analysis.bindingSpace) : null;
  const figures = analysis.state === 'ok'
    ? [
      { value: String(analysis.compilation.analysis.tasks), label: 'tasks' },
      { value: String(analysis.compilation.analysis.candidates), label: 'candidates' },
      { value: String(analysis.compilation.analysis.constraints), label: 'rules' },
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
          {`The gateway’s own analysis isn’t available right now${marker(analysis.failure)}. The figures below are read from the compiled form.`}
        </Notice>
      )}
      {figures.length === 0 && <p className="org-muted">There is no compiled form to summarize for this version.</p>}
      {figures.length > 0 && (
        <ul className="case-glance" aria-label="What the engines receive">
          {figures.map((figure) => <li key={figure.label}><b>{figure.value}</b><span>{figure.label}</span></li>)}
        </ul>
      )}
      {analysis.state === 'ok' && combos && combos.bigVal > 1n && (
        <span className="org-muted">Exactly {combos.exact} possible bindings.</span>
      )}
      {analysis.state === 'ok' && (
        <span className="org-muted">{analysis.compilation.compatible_modes.length === 1 ? '1 engine mode can run it.' : `${analysis.compilation.compatible_modes.length} engine modes can run it.`}</span>
      )}
      <RangeNotice model={model} analysis={analysis} />
    </>
  );
}

/** The ranges a package carries, and what that means for the engines: only a mode that declares interval values can run it. */
function RangeNotice({ model, analysis }: { model: BindingModel | null; analysis: Compiled }) {
  const ranged = model ? rangeCandidates(model) : [];
  if (ranged.length === 0) return null;
  const modes = analysis.state === 'ok' ? analysis.compilation.compatible_modes : null;
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

function SourceBody({ organization, item, revision }: { organization: Organization; item: Problem; revision: ProblemRevision }) {
  const { copy, status } = useCopy();
  const org = organization.slug;
  const key = `${org}/${item.slug}/${revision.id}`;
  const detail = useResource<ProblemRevisionDetail>(`revision-detail:${key}`, () => problemsApi.revision(org, item.slug, revision.revision));
  const compiled = useResource<Compiled>(`compiled:${key}`, async () => {
    try {
      const compilation = await problemsApi.compilation(org, item.slug, revision.revision);
      return { state: 'ok', compilation, ir: await problemsApi.ir(org, item.slug, revision.revision, compilation.id) };
    } catch (caught) {
      return { state: 'failed', failure: classifyAuthError(caught) };
    }
  });
  const [downloads, setDownloads] = useState<Partial<Record<DownloadKind, Download>>>({});

  const failure = detail.status === 'error' ? classifyAuthError(detail.error) : null;

  if (detail.status === 'loading') {
    return <div role="status" aria-busy="true"><span className="sr-only">Loading the source…</span><Skeleton variant="card" /><Skeleton variant="panel" /></div>;
  }
  if (failure || !detail.data) {
    const kind = failure ? sourceFailureKind(failure) : 'missing';
    return (
      <>
        {kind === 'key' && (
          <Notice tone="warning">This API key doesn’t include “read problems” (403). Use a session or a key with that permission.</Notice>
        )}
        {kind === 'missing' && (
          <CaseMissing title="Version not found" actions={<Action to={problemsPath(org)} variant="primary">All problems</Action>}>
            It may have been deleted with its problem. We answer the same way when you can’t see it (404).
          </CaseMissing>
        )}
        {(kind === 'other' || kind === 'recompile') && failure && (
          <Notice tone="error" action={<Action variant="secondary" size="sm" onClick={detail.reload}>Retry</Action>}>
            The source couldn’t be loaded{marker(failure)}.
          </Notice>
        )}
      </>
    );
  }

  const data = detail.data;
  const ir = compiled.data?.state === 'ok' ? compiled.data.ir : null;
  const model = ir ? readBindingProblem(ir.ir) : null;
  const digests: Record<'instance' | 'package' | 'compiled', string | null> = { instance: data.instance_digest ?? null, package: data.package_digest, compiled: ir?.ir_digest ?? null };
  const file = `${item.slug}-v${revision.revision}`;

  const download = async (kind: DownloadKind) => {
    setDownloads((current) => ({ ...current, [kind]: { state: 'busy' } }));
    try {
      if (kind === 'source') saveBytes(await problemsApi.source(org, item.slug, revision.revision), `${file}.bim.zip`, 'application/vnd.bim+zip');
      else if (ir) saveBytes(new TextEncoder().encode(JSON.stringify(ir.ir, null, 2)).buffer as ArrayBuffer, `${file}-compiled.json`, 'application/json');
      setDownloads((current) => ({ ...current, [kind]: { state: 'done' } }));
    } catch (caught) {
      const reason = classifyAuthError(caught);
      setDownloads((current) => ({ ...current, [kind]: { state: 'failed', message: `The download didn’t finish${marker(reason)}.` } }));
    }
  };

  const downloadCards: Array<{ kind: DownloadKind; label: string; detail: string; disabled?: boolean }> = [
    { kind: 'source', label: 'Package', detail: `${file}.bim.zip · ${formatBytes(data.package_size) ?? 'size unknown'} · as uploaded` },
    { kind: 'ir', label: 'Compiled form', detail: 'For tools that read the engine input (JSON)', disabled: !ir },
  ];

  return (
    <>
      <SourceViewer org={org} problem={item.slug} revision={revision} ir={ir} />

      <section className="org-section" aria-labelledby="sd-fingerprints">
        <div className="org-section-head">
          <h2 id="sd-fingerprints">Fingerprints</h2>
          <Action variant="secondary" onClick={() => void copy([...(data.instance_digest ? [`instance ${data.instance_digest}`] : []), `package ${data.package_digest}`, ...(ir ? [`compiled ${ir.ir_digest}`] : [])].join('\n'), 'all')}>
            {status('all') === 'copied' ? 'Copied' : status('all') === 'failed' ? 'Copy failed' : 'Copy all fingerprints'}
          </Action>
        </div>
        <div className="snap-digests">
          {FINGERPRINTS.map((entry) => {
            const digest = digests[entry.key];
            return (
              <div className="snap-digest" key={entry.key}>
                <span className="snap-digest-label">{entry.label}</span>
                <span>{digest ? 'Stored' : 'not stored'}</span>
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
        <Pins detail={data} />
      </section>

      <section className="org-section" aria-labelledby="sd-language">
        <h2 id="sd-language">Exact language used</h2>
        {model ? (
          <div className="proj-chips">
            <Chip tone="accent">Profile · {model.profile ?? 'not stated'}</Chip>
            <Chip>{model.dialects.length === 0 ? 'Dialects · none' : `Dialects · ${model.dialects.map((dialect) => dialect.label).join(', ')}`}</Chip>
            <Chip>{model.adapters.length === 0 ? 'Adapters · none stated' : `Adapters · ${model.adapters.join(', ')}`}</Chip>
          </div>
        ) : <p className="org-muted">The compiled form isn’t available, so the language it used can’t be listed.</p>}
        {compiled.data?.state === 'ok' && Object.keys(compiled.data.compilation.resources).length > 0 && (
          <table className="case-table">
            <caption>Resources</caption>
            <thead><tr><th scope="col">Resource</th><th scope="col">Role</th><th scope="col">Kind</th></tr></thead>
            <tbody>
              {Object.entries(compiled.data.compilation.resources).map(([id, contract]) => (
                <tr key={id}><th scope="row"><code>{id}</code></th><td>{contract.role ?? '—'}</td><td>{contract.kind ?? '—'}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="org-section" aria-labelledby="sd-engines">
        <h2 id="sd-engines">What the engines receive</h2>
        <Summary analysis={compiled.data} model={model} />
      </section>

      <section className="org-section" aria-labelledby="sd-downloads">
        <h2 id="sd-downloads">Downloads</h2>
        <div className="snap-downloads">
          {downloadCards.map((card) => {
            const state = downloads[card.kind];
            return (
              <button type="button" key={card.kind} className="snap-download" onClick={() => void download(card.kind)} disabled={card.disabled || state?.state === 'busy'}>
                <strong>{card.label}</strong>
                <span>{card.detail}</span>
                <em>{state?.state === 'busy' ? 'Preparing…' : state?.state === 'done' ? 'Downloaded' : state?.state === 'failed' ? state.message : 'Download'}</em>
              </button>
            );
          })}
        </div>
      </section>
    </>
  );
}

/**
 * The Source tab of the problem page: the files of the package of the version on show and its compiled form, then its fingerprints, the
 * resources the compiler read, what the engines receive and the downloads.
 */
export function VersionSource({ organization, item, revision }: { organization: Organization; item: Problem; revision: ProblemRevision }) {
  return <SourceBody key={revision.id} organization={organization} item={item} revision={revision} />;
}
