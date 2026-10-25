import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { platformApi, type Organization, type Project, type Publication, type Report } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { CopyField } from '../../components/ui/CopyField';
import { Modal } from '../../components/ui/Modal';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { useCopy } from '../../components/ui/useCopy';
import { useAuth } from '../../contexts/auth';
import { shortDigest } from '../../utils/digest';
import { formatDate, formatDateTime } from '../../utils/format';
import { useResource } from '../../utils/useResource';
import { classifyAuthError, marker } from '../Account/accountErrors';
import { RefusalNotice } from '../Jobs/parts';
import { ProjectGate, ProjectSkeleton } from '../Project/parts';
import { loadReports, loadStudies } from '../Project/projectData';
import type { StudyContent } from '../Project/projectModel';
import { useRouteProject } from '../Project/useRouteProject';
import { saveBytes } from '../Project/download';
import { PublishDialog } from './PublishDialog';
import { ReportBlocks } from './ReportBlocks';
import { ReportChips, ReportFrame, ReportGate } from './parts';
import { reportRefusal, type Refusal } from './reportErrors';
import { SavedDecision } from './SavedDecision';
import {
  citationBibtex, citationFields, citationText, evidenceOf, livePublication, publicationsOf, readDocument, sameDocument, withBlocks,
  type Block, type Doc,
} from './reportsModel';

type Outcome = { tone: 'success'; text: string } | { tone: 'error'; refusal: Refusal };
type Dialog = 'freeze' | 'publish' | 'withdraw' | 'delete' | null;

interface Loaded {
  report: Report;
  reports: Report[];
  publications: Publication[];
}

interface ViewProps {
  organization: Organization;
  project: Project;
  loaded: Loaded;
  studies: readonly StudyContent[] | undefined;
  canEdit: boolean;
  canPublish: boolean;
  outcome: Outcome | null;
  setOutcome: (outcome: Outcome | null) => void;
  reload: () => void;
}

const asDoc = (value: unknown): Doc => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Doc) : {});

function ReportView({ organization, project, loaded, studies, canEdit, canPublish, outcome, setOutcome, reload }: ViewProps) {
  const { report, reports, publications } = loaded;
  const org = organization.slug;
  const slug = project.slug;
  const root = `/app/${org}/${slug}`;
  const navigate = useNavigate();
  const { user } = useAuth();
  const { copy, status } = useCopy();
  const [title, setTitle] = useState(report.title);
  const [doc, setDoc] = useState<Doc>(() => asDoc(report.document));
  const [sourceDraft, setSourceDraft] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState('');
  const [sourceOpen, setSourceOpen] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dialogRefusal, setDialogRefusal] = useState<Refusal | null>(null);

  const isDraft = report.state === 'draft';
  const live = livePublication(report, publications);
  const history = publicationsOf(report, publications);
  const read = readDocument(doc);
  const editable = isDraft && canEdit && read.editable;
  const dirty = isDraft && (title !== report.title || !sameDocument(doc, report.document));
  const sourceText = sourceDraft ?? JSON.stringify(doc, null, 2);
  const evidence = evidenceOf(report, doc, studies, root, read.blocks);
  const libraryHref = `/app/${org}/library/${report.artifact_id}${report.version_id ? `/versions/${report.version_id}` : ''}`;

  const setBlocks = (blocks: Block[]) => setDoc(withBlocks(doc, blocks));
  const fail = (caught: unknown, action: Parameters<typeof reportRefusal>[1]) => setOutcome({ tone: 'error', refusal: reportRefusal(caught, action) });
  const persist = () => platformApi.updateReport(org, slug, report.slug, { title, document: doc, draft_revision: report.draft_revision ?? undefined });

  const save = async () => {
    setBusy('save');
    setOutcome(null);
    try {
      await persist();
      setOutcome({ tone: 'success', text: 'Draft saved.' });
      reload();
    } catch (caught) {
      fail(caught, 'save');
    } finally {
      setBusy(null);
    }
  };

  const freeze = async () => {
    setBusy('freeze');
    setOutcome(null);
    let saved = false;
    try {
      if (dirty) { await persist(); saved = true; }
      await platformApi.freezeReport(org, slug, report.slug);
      setOutcome({ tone: 'success', text: 'Frozen as a new edition. It can’t change any more; its fingerprint was assigned by the server.' });
      setDialog(null);
      reload();
    } catch (caught) {
      setDialog(null);
      fail(caught, 'freeze');
      const refusal = reportRefusal(caught, 'freeze');
      if (refusal.code?.includes('provenance')) setSourceOpen(true);
      if (saved) reload();
    } finally {
      setBusy(null);
    }
  };

  const newDraft = async () => {
    setBusy('draft');
    setOutcome(null);
    try {
      await platformApi.createReportDraft(org, slug, report.slug);
      setOutcome({ tone: 'success', text: 'New draft started from this edition. The edition itself is unchanged.' });
      reload();
    } catch (caught) {
      fail(caught, 'draft');
    } finally {
      setBusy(null);
    }
  };

  const withdraw = async () => {
    if (!live) return;
    setBusy('withdraw');
    setDialogRefusal(null);
    try {
      await platformApi.deletePublication(org, slug, live.slug);
      setDialog(null);
      setOutcome({ tone: 'success', text: 'Withdrawn. It’s no longer listed in Explore, but its link, citation and fingerprint still work.' });
      reload();
    } catch (caught) {
      setDialogRefusal(reportRefusal(caught, 'withdraw'));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy('delete');
    setDialogRefusal(null);
    try {
      await platformApi.deleteReport(org, slug, report.slug);
      navigate(`${root}/reports`);
    } catch (caught) {
      setDialogRefusal(reportRefusal(caught, 'delete'));
      setBusy(null);
    }
  };

  const applySource = () => {
    try {
      const parsed: unknown = JSON.parse(sourceText);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('A report document is a JSON object.');
      setDoc(parsed as Doc);
      setSourceDraft(null);
      setSourceError('');
    } catch (caught) {
      setSourceError(caught instanceof Error ? caught.message : 'That is not valid JSON.');
    }
  };

  const download = () => saveBytes(new TextEncoder().encode(JSON.stringify(report.document, null, 2)).buffer as ArrayBuffer, `${report.slug}.json`, 'application/json');

  const fields = live ? citationFields(live.citation, report.title) : null;
  const verifyUrl = report.digest ? `${window.location.origin}/resolve/report/${report.digest}` : undefined;
  const statusLine = isDraft
    ? `Draft revision ${report.draft_revision ?? 1} · ${dirty ? 'unsaved changes' : 'saved'}`
    : `Frozen edition · fingerprint ${report.digest ? shortDigest(report.digest) : 'not recorded'}`;
  const editionsLine = live ? `Published as ${live.slug}` : history.length > 0 ? 'Published editions were withdrawn' : isDraft && report.version_id ? 'An earlier edition exists' : isDraft ? 'No editions yet' : 'Not published';

  return (
    <ReportFrame organization={organization} project={project} trail={[{ label: 'Reports', to: `${root}/reports` }, { label: report.title }]}>
      <header className="rp-head">
        <div className="rp-head-main">
          <span className="rp-title-line"><h1>{report.title}</h1><ReportChips state={report.state} published={Boolean(live)} /></span>
          <label className="rp-switch">
            <span>Report</span>
            <select value={report.slug} onChange={(event) => navigate(`${root}/reports/${encodeURIComponent(event.target.value)}`)}>
              {reports.map((item) => <option key={item.id} value={item.slug}>{item.title}</option>)}
            </select>
          </label>
        </div>
        <div className="proj-actions">
          {isDraft && canEdit && (
            <>
              <Action variant="secondary" busy={busy === 'save'} disabled={!dirty} onClick={() => void save()}>Save draft</Action>
              <Action variant="primary" disabled={busy !== null} onClick={() => setDialog('freeze')}>Freeze edition</Action>
            </>
          )}
          {!isDraft && canEdit && <Action variant="secondary" busy={busy === 'draft'} onClick={() => void newDraft()}>New draft from this edition</Action>}
          {!isDraft && canPublish && !live && <Action variant="primary" onClick={() => { setDialogRefusal(null); setDialog('publish'); }}>Publish…</Action>}
          {live && canPublish && <Action variant="danger-outline" onClick={() => { setDialogRefusal(null); setDialog('withdraw'); }}>Withdraw</Action>}
          {canPublish && <Action variant="danger-outline" onClick={() => { setDialogRefusal(null); setDialog('delete'); }}>Delete</Action>}
        </div>
      </header>

      <div className="rp-status" role="status"><span>{statusLine}</span><span>{editionsLine}</span></div>
      {outcome?.tone === 'success' && <Notice tone="success">{outcome.text}</Notice>}
      {outcome?.tone === 'error' && (
        <RefusalNotice
          refusal={outcome.refusal}
          action={outcome.refusal.code === 'draft_conflict' ? <Action variant="secondary" size="sm" onClick={() => { setOutcome(null); reload(); }}>Load the newer draft</Action> : undefined}
        />
      )}
      {!canEdit && <p className="rp-note">Read-only for you: editing needs MEMBER, publishing needs ADMIN.</p>}
      {canEdit && !canPublish && !isDraft && <p className="rp-note">Publishing needs ADMIN.</p>}
      {isDraft && canEdit && !read.editable && read.shape !== 'decision' && (
        <Notice tone="info">This document uses a structure the block editor can’t rewrite without losing something. Edit it under “View source”.</Notice>
      )}

      <div className="rp-cols">
        <article className="rp-article" aria-label="Report content">
          {editable && (
            <label className="rp-title-edit">
              <span>Title</span>
              <input value={title} onChange={(event) => setTitle(event.target.value)} />
            </label>
          )}
          {read.shape === 'decision' ? (
            <div className="rp-decision">
              <h2>Recorded binding decision</h2>
              <p>This snapshot records the rule, priorities and evidence behind a choice.</p>
              <SavedDecision document={doc} />
            </div>
          ) : (
            <>
              {read.facts.length > 0 && (
                <dl className="rp-facts" aria-label="Key figures">
                  {read.facts.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}
                </dl>
              )}
              <ReportBlocks blocks={read.blocks} editable={editable} studies={studies} org={org} project={slug} onChange={setBlocks} />
            </>
          )}
        </article>

        <aside className="rp-aside" aria-label="Evidence and fingerprint">
          <section className="rp-card" aria-labelledby="rp-evidence-title">
            <h2 id="rp-evidence-title" className="rp-eyebrow">Evidence attached</h2>
            {evidence.length === 0 && <p className="rp-muted">None yet.</p>}
            <ul className="rp-evidence-list">
              {evidence.map((item, index) => (
                <li key={`${item.label}:${index}`}>
                  <strong>{item.label}</strong>
                  {item.fingerprint && <small>{item.fingerprint}</small>}
                  {(item.href || item.analytics) && (
                    <span className="rp-links">
                      {item.href && <Link to={item.href}>Open the run</Link>}
                      {item.analytics && <Link to={item.analytics}>Compare results</Link>}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>

          {!isDraft && report.digest && (
            <section className="rp-card is-seal" aria-labelledby="rp-seal-title">
              <h2 id="rp-seal-title" className="rp-eyebrow">Edition fingerprint</h2>
              <CopyField value={report.digest} label="edition fingerprint" truncate />
              <span className="rp-links">
                <Link to={`/resolve/report/${report.digest}`}>Verify it</Link>
                <Link to={`/app/verifier?digest=${encodeURIComponent(report.digest)}`}>Check it in the verifier</Link>
              </span>
            </section>
          )}

          {live && fields && (
            <section className="rp-card" aria-labelledby="rp-pub-title">
              <h2 id="rp-pub-title" className="rp-eyebrow">Published</h2>
              <p><strong>{live.slug}</strong> · {formatDate(live.published_at)}</p>
              <span className="rp-cite">{citationText(fields)}</span>
              <span className="rp-links">
                <button type="button" onClick={() => void copy(citationText(fields), 'cite')}>{status('cite') === 'copied' ? 'Citation copied' : 'Copy citation'}</button>
                <button type="button" onClick={() => void copy(citationBibtex(fields, live.slug, verifyUrl), 'bib')}>{status('bib') === 'copied' ? 'Copied for reference manager' : 'Copy for reference manager'}</button>
              </span>
              <Link to={`${root}/publications`}>Open the publications</Link>
            </section>
          )}

          <section className="rp-card" aria-labelledby="rp-history-title">
            <h2 id="rp-history-title" className="rp-eyebrow">History</h2>
            <ul className="rp-history">
              <li><span>Created</span><small>{formatDateTime(report.created_at) ?? '—'}</small></li>
              {history.map((publication) => (
                <li key={publication.id}>
                  <span>{publication.withdrawn ? 'Withdrawn' : 'Published'} as {publication.slug}</span>
                  <small>{formatDate(publication.published_at) ?? '—'}</small>
                </li>
              ))}
            </ul>
            <Link to={libraryHref}>{report.version_id ? 'Version history in the library' : 'Open in the library'}</Link>
          </section>
        </aside>
      </div>

      <details className="rp-source" open={sourceOpen} onToggle={(event) => setSourceOpen(event.currentTarget.open)}>
        <summary>View source</summary>
        {isDraft && canEdit ? (
          <div className="rp-source-edit">
            <label>
              <span className="sr-only">Report document (JSON)</span>
              <textarea value={sourceText} rows={14} spellCheck={false} aria-label="Report document (JSON)" onChange={(event) => { setSourceDraft(event.target.value); setSourceError(''); }} />
            </label>
            {sourceError && <Notice tone="error">{sourceError}</Notice>}
            <span className="rp-links">
              <Action variant="secondary" size="sm" onClick={applySource} disabled={sourceDraft === null}>Apply to the draft</Action>
              <Action variant="ghost" size="sm" onClick={() => { setSourceDraft(null); setSourceError(''); }} disabled={sourceDraft === null}>Discard source edits</Action>
            </span>
          </div>
        ) : (
          <pre aria-label="Report document (JSON)">{JSON.stringify(report.document, null, 2)}</pre>
        )}
        <span className="rp-links">
          <Action variant="secondary" size="sm" onClick={() => void copy(JSON.stringify(report.document, null, 2), 'json')}>{status('json') === 'copied' ? 'JSON copied' : 'Copy JSON'}</Action>
          <Action variant="secondary" size="sm" onClick={download}>Download JSON</Action>
        </span>
      </details>

      {dialog === 'freeze' && (
        <Modal title="Freeze this edition?" size="md" onClose={() => busy === null && setDialog(null)}>
          <p>Freezing seals the draft as an edition that never changes. The server assigns its fingerprint and checks that its provenance and evidence are complete and finished.{dirty ? ' Your unsaved changes are saved first.' : ''}</p>
          <div className="ui-modal-actions">
            <Action variant="secondary" onClick={() => setDialog(null)} disabled={busy !== null}>Cancel</Action>
            <Action variant="primary" busy={busy === 'freeze'} onClick={() => void freeze()}>Freeze edition</Action>
          </div>
        </Modal>
      )}
      {dialog === 'publish' && (
        <PublishDialog
          organization={organization}
          project={project}
          report={report}
          author={user?.username ?? ''}
          close={() => setDialog(null)}
          published={() => {
            setDialog(null);
            setOutcome({ tone: 'success', text: 'Published. Anyone can now find, read and verify this edition.' });
            reload();
          }}
        />
      )}
      {dialog === 'withdraw' && live && (
        <Modal title={`Withdraw ${live.slug}?`} tone="danger" size="md" onClose={() => busy === null && setDialog(null)}>
          <p>It leaves the listings in Explore. Its link, citation and fingerprint keep working, so nobody who cited it is left with a broken reference.</p>
          {dialogRefusal && <RefusalNotice refusal={dialogRefusal} />}
          <div className="ui-modal-actions">
            <Action variant="secondary" onClick={() => setDialog(null)} disabled={busy !== null}>Cancel</Action>
            <Action variant="danger" busy={busy === 'withdraw'} onClick={() => void withdraw()}>Withdraw</Action>
          </div>
        </Modal>
      )}
      {dialog === 'delete' && (
        <Modal title={`Delete ${report.title}?`} tone="danger" size="md" onClose={() => busy === null && setDialog(null)}>
          <p>A draft that never had an edition goes away for good. A report with frozen editions can’t be deleted: editions stay citable.</p>
          {dialogRefusal && <RefusalNotice refusal={dialogRefusal} />}
          <div className="ui-modal-actions">
            <Action variant="secondary" onClick={() => setDialog(null)} disabled={busy !== null}>Cancel</Action>
            <Action variant="danger" busy={busy === 'delete'} onClick={() => void remove()}>Delete report</Action>
          </div>
        </Modal>
      )}
    </ReportFrame>
  );
}

function ReportBody({ organization, project, canEdit, canPublish }: { organization: Organization; project: Project; canEdit: boolean; canPublish: boolean }) {
  const { report: reportSlug = '' } = useParams();
  const org = organization.slug;
  const slug = project.slug;
  const root = `/app/${org}/${slug}`;
  const resource = useResource<Loaded>(`report:${org}/${slug}/${reportSlug}`, async () => {
    const [report, list] = await Promise.all([platformApi.report(org, slug, reportSlug), loadReports(org, slug)]);
    return { report, reports: list.reports, publications: list.publications };
  });
  const studies = useResource<StudyContent[]>(`report-studies:${org}/${slug}`, () => loadStudies(org, slug).catch(() => []));
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const loaded = resource.data ?? (resource.status === 'error' ? undefined : resource.stale);
  const trail = [{ label: 'Reports', to: `${root}/reports` }, { label: reportSlug }];

  if (resource.status === 'error' && !loaded) {
    const failure = classifyAuthError(resource.error);
    return (
      <ReportFrame organization={organization} project={project} trail={trail}>
        {failure.status === 404 ? (
          <ReportGate title="Report not found" action={<Action to={`${root}/reports`} variant="primary">All reports</Action>}>
            No report with this address in {project.name} (404).
          </ReportGate>
        ) : (
          <Notice tone={failure.status === 403 ? 'warning' : 'error'} action={<Action variant="secondary" size="sm" onClick={resource.reload}>Retry</Action>}>
            {failure.status === 403
              ? `This API key can’t read this report${marker(failure)}. Use a session, or a key with reports:read.`
              : `The report couldn’t be loaded${marker(failure)}.`}
          </Notice>
        )}
      </ReportFrame>
    );
  }
  if (!loaded) {
    return (
      <ReportFrame organization={organization} project={project} trail={trail}>
        <div role="status" aria-busy="true"><span className="sr-only">Loading the report…</span><Skeleton variant="panel" /></div>
      </ReportFrame>
    );
  }
  const { report } = loaded;
  return (
    <ReportView
      key={`${report.id}:${report.state}:${report.draft_revision ?? ''}:${report.version_id ?? ''}`}
      organization={organization}
      project={project}
      loaded={loaded}
      studies={studies.data ?? studies.stale}
      canEdit={canEdit}
      canPublish={canPublish}
      outcome={outcome}
      setOutcome={setOutcome}
      reload={resource.reload}
    />
  );
}

/** One report (`rep-detail`, `/app/:org/:project/reports/:report`): its blocks, the evidence it stands on, and what can be done with it at its stage. */
export function RepDetail() {
  const { orgSlug, projectSlug, organization, project, access, waiting, failure, reload } = useRouteProject();
  const { report = '' } = useParams();
  if (waiting) return <ProjectSkeleton />;
  if (!organization || !project) {
    return <ProjectGate failure={organization ? failure : null} orgSlug={orgSlug} projectSlug={projectSlug} organizationName={organization?.name} onRetry={reload} />;
  }
  // Another address is another report: nothing of the previous one may stay on screen while this one is read.
  return <ReportBody key={`${organization.slug}/${project.slug}/${report}`} organization={organization} project={project} canEdit={access.canCreate} canPublish={access.canAdminister} />;
}
