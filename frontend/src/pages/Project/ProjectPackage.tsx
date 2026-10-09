import { useRef, useState, type DragEvent } from 'react';
import { Link } from 'react-router-dom';
import { Upload } from 'lucide-react';
import { apiClient } from '../../api/client';
import { platformApi } from '../../api/platform';
import type { Organization, PackageFormat, Project } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { Chip } from '../../components/ui/Chip';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { useAuth } from '../../contexts/auth';
import { shortDigest } from '../../utils/digest';
import { formatBytes } from '../../utils/format';
import { formatByteSize } from '../../utils/limits';
import { useResource } from '../../utils/useResource';
import { saveBytes } from './download';
import { loadCases, loadReports, loadStudies } from './projectData';
import { exportFailure, importRefusal, type ImportRefusal } from './projectErrors';
import { importCeiling, integrityOf } from './projectModel';
import {
  compareWithProject, countRows, FORMATS, humanizeCount, inspectPackage, packageFileName, packageImportCounts,
  type PackageInspection, type RowOutcome,
} from './packageModel';
import { ProjectFrame, ProjectGate, ProjectSkeleton } from './parts';
import { useRouteProject } from './useRouteProject';
import './Project.css';

const MEDIA_TYPES: Record<PackageFormat, string> = { zip: 'application/zip', json: 'application/json', yaml: 'application/yaml' };
/** A long report stays a list people can read; the counts above it cover every row. */
const ROWS_SHOWN = 100;

type Phase =
  | { name: 'idle' }
  | { name: 'checking'; fileName: string }
  | { name: 'review'; file: File; inspection: PackageInspection }
  | { name: 'importing'; file: File; inspection: PackageInspection }
  | { name: 'problem'; title: string; text: string }
  | { name: 'done'; inspection: PackageInspection; total: number; parts: Array<{ id: string; count: number }> };

const OUTCOME_CHIPS: Record<RowOutcome, { label: string; tone: 'plain' | 'accent' | 'success' | 'warning' }> = {
  verified: { label: 'Verified', tone: 'success' },
  reuse: { label: 'Already here', tone: 'accent' },
  new: { label: 'Will be added', tone: 'accent' },
  later: { label: 'Checked on import', tone: 'plain' },
  mismatch: { label: 'Doesn’t match', tone: 'warning' },
  collision: { label: 'Different content', tone: 'warning' },
  missing: { label: 'Missing', tone: 'warning' },
};

function Contents({ organization, project }: { organization: Organization; project: Project }) {
  const contents = useResource(`package-contents:${organization.slug}/${project.slug}`, async () => {
    const [cases, studies, reports, files] = await Promise.all([
      loadCases(organization.slug, project.slug), loadStudies(organization.slug, project.slug),
      loadReports(organization.slug, project.slug), platformApi.artifacts(organization.slug, project.slug).catch(() => null),
    ]);
    return { cases, studies, reports: reports.reports, files };
  });

  const data = contents.data;
  const items = data ? integrityOf({ cases: data.cases, studies: data.studies, reports: data.reports }) : [];
  const count = (id: string) => items.find((item) => item.id === id)?.count ?? 0;
  const drafts = data?.reports.filter((item) => item.state === 'draft') ?? [];

  const includes: Array<{ n: string; label: string; badge: string }> = [
    { n: data ? String(data.cases.length) : '·', label: data ? `case${data.cases.length === 1 ? '' : 's'} with ${count('revisions')} sealed revision${count('revisions') === 1 ? '' : 's'}` : 'cases with their sealed revisions', badge: 'sealed' },
    { n: '+', label: 'library versions those cases use', badge: 'sealed' },
    { n: '+', label: 'snapshots the revisions came from', badge: 'sealed' },
    { n: data ? String(count('runs')) : '·', label: data ? `study run${count('runs') === 1 ? '' : 's'} with ${count('runs') === 1 ? 'its' : 'their'} cells` : 'study runs with their cells', badge: 'sealed' },
    { n: data ? String(count('frozen')) : '·', label: data ? `frozen report${count('frozen') === 1 ? '' : 's'}` : 'frozen reports', badge: 'sealed' },
    { n: data ? String(drafts.length) : '·', label: data ? `report draft${drafts.length === 1 ? '' : 's'}` : 'report drafts', badge: 'draft' },
    ...(data?.files ? [{ n: String(data.files.length), label: `stored file${data.files.length === 1 ? '' : 's'}`, badge: 'by digest' }] : []),
  ];
  const excludes = [
    { title: 'People and roles', detail: 'Members, invitations and sponsor don’t travel; the receiving organization decides.' },
    { title: 'Publication records', detail: 'The package names which reports were published, but a publication comes back only if the exact report version is already published where it lands.' },
    { title: 'Job history', detail: 'Only the jobs behind study cells and report evidence travel; other jobs belong to whoever launched them.' },
    { title: 'API keys and credentials', detail: 'Nothing that grants access is ever written into a package.' },
  ];

  return (
    <section className="proj-lists" aria-labelledby="pk-contents">
      <h2 id="pk-contents" className="sr-only">What a package contains</h2>
      <div className="proj-card is-compact">
        <h3>What goes in</h3>
        {contents.status === 'loading' && <Skeleton variant="tile" />}
        {contents.status === 'error' && (
          <Notice tone="error" action={<Action variant="secondary" size="sm" onClick={contents.reload}>Retry</Action>}>
            Counts couldn’t be loaded. The package carries the same things.
          </Notice>
        )}
        {contents.status !== 'loading' && (
          <ul className="proj-includes">
            {includes.map((item) => (
              <li key={item.label}>
                <span className="proj-count" aria-hidden="true">{item.n}</span>
                <span>{item.label}</span>
                <small className={item.badge === 'draft' ? 'is-draft' : 'is-sealed'}>{item.badge === 'sealed' ? '✓ sealed' : item.badge === 'draft' ? 'editable' : item.badge}</small>
              </li>
            ))}
          </ul>
        )}
        {drafts.length > 0 && <small className="org-muted">Drafts travel as drafts: {drafts.slice(0, 3).map((item) => `“${item.title}”`).join(', ')}{drafts.length > 3 ? ` and ${drafts.length - 3} more` : ''} stay editable after the import.</small>}
      </div>
      <div className="proj-card is-compact">
        <h3>What stays behind</h3>
        <ul className="proj-excludes">
          {excludes.map((item) => (
            <li key={item.title}>
              <span className="proj-dash" aria-hidden="true">–</span>
              <span><b>{item.title}</b>{item.detail}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function ExportCard({ organization, project }: { organization: Organization; project: Project }) {
  const [format, setFormat] = useState<PackageFormat>('zip');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const bytes = await platformApi.exportPackage(organization.slug, project.slug, format);
      const name = packageFileName(project.slug, format);
      saveBytes(bytes, name, MEDIA_TYPES[format]);
      setSaved(name);
    } catch (caught) {
      setError(exportFailure(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="proj-card" aria-labelledby="pk-export">
      <h2 id="pk-export">Export</h2>
      <span className="org-muted">Anyone who can see the project can export it. The file goes to your downloads; its content is never shown here.</span>
      <fieldset className="proj-formats">
        <legend className="sr-only">File type</legend>
        {FORMATS.map((item) => (
          <label key={item.id} className={`proj-format${format === item.id ? ' is-checked' : ''}`}>
            <input type="radio" name="package-format" value={item.id} checked={format === item.id} onChange={() => { setFormat(item.id); setSaved(null); }} />
            <span><strong>{item.label}</strong><small>{item.detail}</small></span>
          </label>
        ))}
      </fieldset>
      <span className="org-muted">The size isn’t known until the package is built.</span>
      <Action variant="primary" onClick={() => void run()} busy={busy}>{saved ? 'Export again' : 'Export package'}</Action>
      {saved && <Notice tone="success">Downloaded {saved}.</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
    </section>
  );
}

function ImportCard({ organization, project, canImport }: { organization: Organization; project: Project; canImport: boolean }) {
  const { user } = useAuth();
  const picker = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>({ name: 'idle' });
  const [dragging, setDragging] = useState(false);
  const [refused, setRefused] = useState(false);
  const org = organization.slug;

  const usage = useResource('package-usage', () => apiClient.getOwnUsage().catch(() => null));
  const catalog = useResource('package-catalog', () => apiClient.getPricingCatalog().catch(() => null));
  const ceiling = importCeiling(usage.data, catalog.data, user?.plan);
  const planKnown = ceiling.plan !== null;
  const allowed = canImport && !refused;

  const choose = async (file: File | undefined) => {
    if (!file || !allowed) return;
    if (file.size > ceiling.effective) {
      setPhase({
        name: 'problem',
        title: 'Package too large',
        text: `This package is ${formatBytes(file.size)}, bigger than the ${formatByteSize(ceiling.effective)} ${ceiling.clamped ? 'the gateway accepts' : 'your plan allows'} per request (the gateway answers 413). Nothing was sent.`,
      });
      return;
    }
    setPhase({ name: 'checking', fileName: file.name });
    try {
      let inspection = await inspectPackage(file);
      if (inspection.readable && !inspection.problem) {
        const existing = await loadCases(org, project.slug).catch(() => null);
        if (existing) {
          inspection = compareWithProject(inspection, existing.map(({ item, revisions }) => ({
            slug: item.slug, revisions: revisions.map((revision) => ({ revision: revision.revision, digest: revision.digest })),
          })));
        }
      }
      if (inspection.problem) setPhase({ name: 'problem', title: inspection.problem.title, text: inspection.problem.text });
      else setPhase({ name: 'review', file, inspection });
    } catch {
      setPhase({ name: 'problem', title: 'The file can’t be read', text: 'The browser could not read this file. Nothing was imported.' });
    }
  };

  const confirm = async () => {
    if (phase.name !== 'review') return;
    const { file, inspection } = phase;
    setPhase({ name: 'importing', file, inspection });
    try {
      const result = await platformApi.importPackage(org, project.slug, file, inspection.format);
      const { total, parts } = packageImportCounts(result);
      setPhase({ name: 'done', inspection, total, parts });
    } catch (caught) {
      const refusal: ImportRefusal = importRefusal(caught);
      if (refusal.kind === 'forbidden') setRefused(true);
      setPhase({ name: 'problem', title: refusal.title, text: refusal.text });
    }
  };

  const reset = () => setPhase({ name: 'idle' });
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    void choose(event.dataTransfer.files[0]);
  };

  const counts = phase.name === 'review' || phase.name === 'importing' ? countRows(phase.inspection.rows) : null;
  const rows = phase.name === 'review' || phase.name === 'importing' ? phase.inspection.rows : [];
  const busy = phase.name === 'importing';

  return (
    <section className="proj-card" aria-labelledby="pk-import" aria-live="polite">
      <h2 id="pk-import">Import</h2>
      {!allowed && (
        <div className="proj-note is-warning" role="note">
          {refused
            ? 'This account or API key can’t write projects and artifacts (403), so importing is off. Export still works.'
            : `Importing needs MEMBER; you’re ${organization.effective_role ? `a ${organization.effective_role}` : 'not a member'} here. You can still export.`}
        </div>
      )}

      {phase.name === 'idle' && (
        <div
          className={`proj-drop${dragging ? ' is-over' : ''}${allowed ? '' : ' is-off'}`}
          onDragOver={(event) => { if (allowed) { event.preventDefault(); setDragging(true); } }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <Upload aria-hidden="true" />
          <strong>Drop a package here</strong>
          <span>ZIP, JSON or YAML package · up to {formatByteSize(ceiling.effective)}{planKnown ? ' on your plan' : ' for the gateway'}</span>
          {ceiling.clamped && <small>Your plan allows {formatByteSize(ceiling.plan!)}, but the gateway never takes more than {formatByteSize(ceiling.effective)} compressed.</small>}
          <input ref={picker} type="file" className="sr-only" tabIndex={-1} accept=".zip,.json,.yaml,.yml,application/zip,application/json" aria-label="Package file" onChange={(event) => { void choose(event.target.files?.[0]); event.target.value = ''; }} />
          <Action variant="secondary" onClick={() => picker.current?.click()} disabled={!allowed}>Choose package</Action>
        </div>
      )}

      {phase.name === 'checking' && (
        <div className="proj-checking" role="status">
          <span><span className="org-spinner" aria-hidden="true" />Checking every fingerprint in {phase.fileName}…</span>
          <div className="proj-indeterminate" aria-hidden="true"><i /></div>
          <small className="org-muted">Nothing is written until you confirm.</small>
        </div>
      )}

      {phase.name === 'problem' && (
        <div className="proj-problem" role="alert">
          <strong>{phase.title}</strong>
          <span>{phase.text}</span>
          <button type="button" className="org-link-button" onClick={reset}>Choose another package</button>
        </div>
      )}

      {(phase.name === 'review' || phase.name === 'importing') && (
        <>
          <p className="org-muted proj-file">{phase.inspection.fileName} · {formatBytes(phase.inspection.size)} · {phase.inspection.format.toUpperCase()}</p>
          {!phase.inspection.readable ? (
            <Notice tone="info">
              A YAML package can’t be opened on this page, so its fingerprints are checked by the gateway when you import. If one doesn’t match, nothing is written.
            </Notice>
          ) : (
            <>
              <div className="proj-chips" aria-label="Verification summary">
                <Chip tone="success">{counts!.verified} verified</Chip>
                <Chip tone="accent">{counts!.reused} already here · reused</Chip>
                <Chip tone="accent">{counts!.added} new</Chip>
                {counts!.later > 0 && <Chip>{counts!.later} checked on import</Chip>}
              </div>
              <ul className="proj-vreport" aria-label="Import verification report">
                {rows.slice(0, ROWS_SHOWN).map((item) => {
                  const chip = OUTCOME_CHIPS[item.outcome];
                  return (
                    <li key={item.id}>
                      <span className={`proj-mark is-${item.outcome}`} aria-hidden="true">{item.outcome === 'verified' || item.outcome === 'reuse' || item.outcome === 'new' ? '✓' : item.outcome === 'later' ? '·' : '!'}</span>
                      <span className="proj-report-name"><strong>{item.name}</strong><small>{item.kind}{item.fingerprint ? ` · ${shortDigest(item.fingerprint)}` : ''}</small></span>
                      <Chip tone={chip.tone}>{chip.label}</Chip>
                    </li>
                  );
                })}
              </ul>
              {rows.length > ROWS_SHOWN && <small className="org-muted">Showing {ROWS_SHOWN} of {rows.length} items; the counts above cover all of them.</small>}
            </>
          )}
          {busy && <div role="status" className="org-creating"><span className="org-spinner" aria-hidden="true" />Importing…</div>}
          <div className="proj-buttons">
            <Action variant="primary" onClick={() => void confirm()} busy={busy}>Import into {project.name}</Action>
            <Action variant="secondary" onClick={reset} disabled={busy}>Cancel</Action>
          </div>
        </>
      )}

      {phase.name === 'done' && (
        <div className="proj-done" role="status">
          <strong>Import complete</strong>
          <span>
            {phase.total > 0
              ? `${phase.total} ${phase.total === 1 ? 'item' : 'items'} added (${phase.parts.map((part) => `${part.count} ${humanizeCount(part.id)}`).join(', ')}).`
              : 'Nothing new was added: everything in the package was already here.'}
            {phase.inspection.readable && countRows(phase.inspection.rows).reused > 0 ? ` ${countRows(phase.inspection.rows).reused} matched what was already here.` : ''}
          </span>
          <span className="proj-buttons">
            <Link to={`/app/${org}/${project.slug}`} viewTransition>Back to the project</Link>
            <button type="button" className="org-link-button" onClick={reset}>Import another package</button>
          </span>
        </div>
      )}
    </section>
  );
}

function PackageBody({ organization, project, canImport }: { organization: Organization; project: Project; canImport: boolean }) {
  return (
    <ProjectFrame organization={organization} project={project} section="package" crumb="Package" width="lg">
      <header className="org-head">
        <div>
          <h1>Portable package</h1>
          <p className="proj-lede">
            Take this project elsewhere as one verifiable file, or bring one in. Every sealed item carries its fingerprint,
            so an import can prove nothing changed on the way.
          </p>
        </div>
      </header>

      <Contents organization={organization} project={project} />

      <div className="proj-transfer">
        <ExportCard organization={organization} project={project} />
        <ImportCard organization={organization} project={project} canImport={canImport} />
      </div>

      <section className="proj-limits" aria-labelledby="pk-limits">
        <h2 id="pk-limits">Known limits</h2>
        <ul>
          <li>Each snapshot needs the exact compilation it was made with; if this deployment doesn’t have it, the import is refused (409 · toolchain_mismatch).</li>
          <li>A publication comes back only when the exact report version is already published where it lands (409 · unpublished_import); a withdrawn publication can’t be restored.</li>
          <li>Report drafts travel as drafts and stay editable; frozen reports stay frozen.</li>
          <li>Packages are limited to 128 MiB compressed, or to your plan’s ceiling when that is lower (413).</li>
        </ul>
      </section>
    </ProjectFrame>
  );
}

/** Project package (`proj-package`, `/app/:org/:project/package`): export a ZIP, JSON or YAML file; import one after its fingerprints are checked. */
export function ProjectPackage() {
  const { orgSlug, projectSlug, organization, project, access, waiting, failure, reload } = useRouteProject();
  if (waiting) return <ProjectSkeleton />;
  if (!organization || !project) {
    return <ProjectGate failure={organization ? failure : null} orgSlug={orgSlug} projectSlug={projectSlug} organizationName={organization?.name} onRetry={reload} />;
  }
  return <PackageBody organization={organization} project={project} canImport={access.canCreate} />;
}
