import { useState } from 'react';
import { Link } from 'react-router-dom';
import { FileText } from 'lucide-react';
import { platformApi, type Organization, type Project, type Report } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { EmptyState } from '../../components/ui/EmptyState';
import { FilterPills } from '../../components/ui/FilterPills';
import { Modal } from '../../components/ui/Modal';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { shortDigest } from '../../utils/digest';
import { formatDate } from '../../utils/format';
import { useResource } from '../../utils/useResource';
import { classifyAuthError, marker } from '../Account/accountErrors';
import { RefusalNotice } from '../Jobs/parts';
import { ProjectGate, ProjectSkeleton } from '../Project/parts';
import { loadReports, loadStudies } from '../Project/projectData';
import { useRouteProject } from '../Project/useRouteProject';
import { NewReport } from './NewReport';
import { ReportChips, ReportFrame, ReportTile } from './parts';
import { reportRefusal, type Refusal } from './reportErrors';
import { describeRun, livePublication } from './reportsModel';

type Outcome = { tone: 'success'; text: string; to?: string } | { tone: 'error'; refusal: Refusal };

const FILTERS = [{ id: 'all', label: 'All' }, { id: 'draft', label: 'Drafts' }, { id: 'frozen', label: 'Frozen' }];

function ReportListBody({ organization, project, canCreate, canAdminister }: { organization: Organization; project: Project; canCreate: boolean; canAdminister: boolean }) {
  const org = organization.slug;
  const slug = project.slug;
  const root = `/app/${org}/${slug}`;
  // A visitor of a public project is served the published reports only; drafts and unpublished editions are not theirs to see.
  const publicRead = project.access === 'public_read';
  const content = useResource(`reports-list:${org}/${slug}`, () => loadReports(org, slug));
  const studies = useResource(`reports-runs:${org}/${slug}`, () => loadStudies(org, slug).catch(() => []));
  const [filter, setFilter] = useState('all');
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const data = content.data ?? content.stale;
  const failure = content.status === 'error' ? classifyAuthError(content.error) : null;
  const rows = (data?.reports ?? [])
    .filter((report) => !publicRead || (report.state === 'frozen' && livePublication(report, data?.publications ?? [])))
    .filter((report) => filter === 'all' || report.state === filter);
  const reload = content.reload;

  const remove = async (report: Report) => {
    setBusy(true);
    setOutcome(null);
    try {
      await platformApi.deleteReport(org, slug, report.slug);
      setOutcome({ tone: 'success', text: `Deleted “${report.title}”.` });
      reload();
    } catch (caught) {
      setOutcome({ tone: 'error', refusal: reportRefusal(caught, 'delete') });
    } finally {
      setBusy(false);
      setDeleting(null);
    }
  };

  return (
    <ReportFrame organization={organization} project={project} trail={[{ label: 'Reports' }]}>
      <header className="proj-title-row">
        <div className="proj-title">
          <h1>Reports</h1>
          <p>Write up results with their evidence attached. Freezing makes an edition that never changes; publishing makes it public and citable.</p>
        </div>
        <div className="proj-actions">
          <Action to={`${root}/publications`} variant="secondary">Publications</Action>
          {canCreate && <Action variant="primary" onClick={() => setCreating(true)}>New report</Action>}
        </div>
      </header>

      {outcome?.tone === 'success' && (
        <Notice tone="success">{outcome.text}{outcome.to && <> <Link to={outcome.to}>Open the draft</Link></>}</Notice>
      )}
      {outcome?.tone === 'error' && <RefusalNotice refusal={outcome.refusal} />}

      {publicRead && <Notice tone="info">Only published reports are shown here. Drafts and editions that aren’t published are for members.</Notice>}
      {data && data.reports.length > 0 && !publicRead && <FilterPills ariaLabel="State" value={filter} options={FILTERS} onChange={setFilter} />}

      {content.status === 'loading' && !data && <div role="status" aria-busy="true"><span className="sr-only">Loading the reports…</span><Skeleton variant="panel" /></div>}
      {failure && !data && (
        <Notice tone={failure.status === 403 ? 'warning' : 'error'} action={<Action variant="secondary" size="sm" onClick={reload}>Retry</Action>}>
          {failure.status === 403
            ? `This API key can’t read reports${marker(failure)}. Use a session, or a key with reports:read.`
            : `Reports couldn’t be loaded${marker(failure)}.`}
        </Notice>
      )}

      {data && rows.length === 0 && publicRead && (
        <EmptyState dashed icon={<FileText />} title="No published reports yet">This project hasn’t published a report.</EmptyState>
      )}
      {data && data.reports.length === 0 && !publicRead && (
        <EmptyState dashed icon={<FileText />} title="No reports yet">
          Create one from a study run or from a saved analysis.{!canCreate && ` Creating a report needs MEMBER in ${organization.name}.`}
        </EmptyState>
      )}
      {data && data.reports.length > 0 && rows.length === 0 && !publicRead && <EmptyState icon={<FileText />} title="No reports in this state">Try another filter.</EmptyState>}

      {rows.length > 0 && (
        <ul className="rp-list" aria-label="Reports of the project">
          {rows.map((report) => {
            const published = Boolean(data && livePublication(report, data.publications));
            const run = report.study_run_id ? describeRun(report.study_run_id, studies.data, root).label : null;
            const created = formatDate(report.created_at);
            const meta = report.state === 'frozen'
              ? ['Frozen edition', run ? `from ${run}` : null, report.digest ? shortDigest(report.digest) : null]
              : [report.draft_revision ? `Draft revision ${report.draft_revision}` : 'New draft', report.version_id ? 'earlier editions exist' : 'no edition yet', run ? `from ${run}` : null];
            return (
              <li key={report.id} className="rp-row">
                <ReportTile state={report.state} />
                <Link to={`${root}/reports/${encodeURIComponent(report.slug)}`} viewTransition className="rp-row-main">
                  <strong>{report.title}</strong>
                  <small>{[...meta, created].filter(Boolean).join(' · ')}</small>
                </Link>
                <ReportChips state={report.state} published={published} />
                {canAdminister && <Action variant="danger-outline" size="sm" aria-label={`Delete ${report.title}`} onClick={() => setDeleting(report)}>Delete</Action>}
              </li>
            );
          })}
        </ul>
      )}

      {creating && (
        <NewReport
          organization={organization}
          project={project}
          studies={studies.data ?? []}
          close={() => setCreating(false)}
          created={(report) => {
            setCreating(false);
            setOutcome({ tone: 'success', text: 'New draft report created.', to: `${root}/reports/${encodeURIComponent(report.slug)}` });
            reload();
          }}
        />
      )}
      {deleting && (
        <Modal title={`Delete ${deleting.title}?`} tone="danger" size="md" onClose={() => !busy && setDeleting(null)}>
          <p>A draft that never had an edition goes away for good. A report with frozen editions can’t be deleted: editions stay citable.</p>
          <div className="ui-modal-actions">
            <Action variant="secondary" onClick={() => setDeleting(null)} disabled={busy}>Cancel</Action>
            <Action variant="danger" busy={busy} onClick={() => void remove(deleting)}>Delete report</Action>
          </div>
        </Modal>
      )}
    </ReportFrame>
  );
}

/** The reports of a project (`rep-list`, `/app/:org/:project/reports`): drafts and frozen editions, which of them are public, and how to start one. */
export function RepList() {
  const { orgSlug, projectSlug, organization, project, access, waiting, failure, reload } = useRouteProject();
  if (waiting) return <ProjectSkeleton />;
  if (!organization || !project) {
    return <ProjectGate failure={organization ? failure : null} orgSlug={orgSlug} projectSlug={projectSlug} organizationName={organization?.name} onRetry={reload} />;
  }
  return <ReportListBody key={`${organization.slug}/${project.slug}`} organization={organization} project={project} canCreate={access.canCreate} canAdminister={access.canAdminister} />;
}
