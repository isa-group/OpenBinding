import { useRef, useState, type DragEvent } from 'react';
import { Link } from 'react-router-dom';
import { Upload } from 'lucide-react';
import { apiClient } from '../../api/client';
import { platformApi } from '../../api/platform';
import type { Organization, PackageFormat, Project } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { Chip } from '../../components/ui/Chip';
import { Notice } from '../../components/ui/Notice';
import { useAuth } from '../../contexts/auth';
import { formatByteSize, formatBytes } from '../../utils/format';
import { useResource } from '../../utils/useResource';
import { SelectField } from '../Organization/parts';
import { saveBytes } from './download';
import { loadCases } from './projectData';
import { exportFailure, importRefusal, type ImportRefusal } from './projectErrors';
import { importCeiling } from './projectModel';
import {
  compareWithProject, countRows, FORMATS, humanizeCount, inspectPackage, packageFileName, packageImportCounts,
  type PackageInspection, type RowOutcome,
} from './packageModel';
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

/** The section `Export package` of the project settings: the file goes to the downloads, its content is never shown. */
export function ExportPackage({ organization, project }: { organization: Organization; project: Project }) {
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
      <h2 id="pk-export">Export package</h2>
      <span className="org-muted">
        Take this project elsewhere as one verifiable file. The file goes to your downloads; its content is never shown here.
      </span>
      <SelectField
        label="Format"
        value={format}
        onChange={(value) => { setFormat(value as PackageFormat); setSaved(null); }}
        hint={FORMATS.find((item) => item.id === format)?.detail}
      >
        {FORMATS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
      </SelectField>
      <Action variant="primary" onClick={() => void run()} busy={busy}>{saved ? 'Export again' : 'Export package'}</Action>
      {saved && <Notice tone="success">Downloaded {saved}.</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
    </section>
  );
}

/** The section `Import package` of the project settings: the fingerprints are checked on this device before anything is sent. */
export function ImportPackage({ organization, project, canImport }: { organization: Organization; project: Project; canImport: boolean }) {
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
      <h2 id="pk-import">Import package</h2>
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
              This page can’t open this package (a YAML file, or a ZIP it can’t read), so its fingerprints are checked by the gateway when you import. If one doesn’t match, nothing is written.
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
                      <span className="proj-report-name"><strong>{item.name}</strong><small>{item.kind}</small></span>
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
