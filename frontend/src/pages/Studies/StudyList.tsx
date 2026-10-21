import { useState } from 'react';
import { Link } from 'react-router-dom';
import { FlaskConical } from 'lucide-react';
import { HttpError } from '../../api/client';
import { platformApi, type Organization, type Project, type Study } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { Chip } from '../../components/ui/Chip';
import { EmptyState } from '../../components/ui/EmptyState';
import { Modal } from '../../components/ui/Modal';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { formatDate } from '../../utils/format';
import { useResource } from '../../utils/useResource';
import { classifyAuthError, marker } from '../Account/accountErrors';
import { RefusalNotice } from '../Jobs/parts';
import { ProjectGate, ProjectSkeleton } from '../Project/parts';
import { loadStudies } from '../Project/projectData';
import type { StudyContent } from '../Project/projectModel';
import { useRouteProject } from '../Project/useRouteProject';
import { CellBar, StateChip, StudyFrame } from './parts';
import { definitionSize, formulaOf, latestOf, plural } from './studiesModel';
import { studyRefusal, type Refusal } from './studyErrors';

/** The studies on show carry the cells of their latest run; this many of the newest do, the rest show only the run's state. */
const WITH_CELLS = 12;

type Outcome = { tone: 'success'; text: string } | { tone: 'error'; refusal: Refusal };

function DemoGrid() {
  return (
    <div className="st-demo" aria-hidden="true">
      {['completed', 'completed', 'completed', 'failed', 'completed', 'completed', 'completed', 'cancelled'].map((state, position) => <i key={position} className={`is-${state}`} />)}
    </div>
  );
}

function StudyListBody({ organization, project, canCreate, canAdminister }: { organization: Organization; project: Project; canCreate: boolean; canAdminister: boolean }) {
  const org = organization.slug;
  const slug = project.slug;
  const root = `/app/${org}/${slug}`;
  // A visitor of a public project reads the studies.
  const publicRead = project.access === 'public_read';
  const studies = useResource<StudyContent[]>(`studies-list:${org}/${slug}`, () => loadStudies(org, slug, WITH_CELLS));
  const [showArchived, setShowArchived] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Study | null>(null);

  const data = studies.data ?? studies.stale;
  const rows = (data ?? []).filter((entry) => showArchived || !entry.study.archived);
  const archivedCount = (data ?? []).filter((entry) => entry.study.archived).length;
  const failure = studies.status === 'error' ? classifyAuthError(studies.error) : null;
  const reload = studies.reload;

  const archive = async (study: Study) => {
    setBusy(study.id);
    setOutcome(null);
    try {
      await platformApi.updateStudy(org, slug, study.slug, { archived: !study.archived });
      setOutcome({ tone: 'success', text: study.archived ? 'Restored.' : 'Archived: it can’t start new runs, and existing results stay.' });
      reload();
    } catch (caught) {
      setOutcome({ tone: 'error', refusal: studyRefusal(caught, 'archive') });
    } finally {
      setBusy(null);
    }
  };

  const remove = async (study: Study) => {
    setBusy(study.id);
    setOutcome(null);
    try {
      await platformApi.deleteStudy(org, slug, study.slug);
      setOutcome({ tone: 'success', text: `Deleted ${study.name}.` });
    } catch (caught) {
      if (caught instanceof HttpError && caught.status === 409 && caught.code === 'study_history_retained') {
        // Runs are history: the gateway refuses the delete, so the study is archived instead and its results stay.
        try {
          await platformApi.updateStudy(org, slug, study.slug, { archived: true });
          setOutcome({ tone: 'success', text: 'This study has runs, so it was archived instead of deleted. Results cited by reports stay intact.' });
        } catch (second) {
          setOutcome({ tone: 'error', refusal: studyRefusal(second, 'archive') });
        }
      } else {
        setOutcome({ tone: 'error', refusal: studyRefusal(caught, 'delete') });
      }
    } finally {
      setBusy(null);
      setDeleting(null);
      reload();
    }
  };

  const none = data && data.length === 0;
  return (
    <StudyFrame organization={organization} project={project} trail={[{ label: 'Studies' }]}>
      <header className="proj-title-row">
        <div className="proj-title">
          <h1>Studies</h1>
          <p>A study runs every combination of cases × engines × settings × seeds, so results can be compared fairly and repeated.</p>
        </div>
        {canCreate && <div className="proj-actions"><Action to={`${root}/studies/new`} variant="primary">New study</Action></div>}
      </header>

      {data && archivedCount > 0 && (
        <label className="st-check">
          <input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />
          Show archived studies <span className="org-muted">({archivedCount})</span>
        </label>
      )}

      {outcome?.tone === 'success' && <Notice tone="success">{outcome.text}</Notice>}
      {outcome?.tone === 'error' && <RefusalNotice refusal={outcome.refusal} />}

      {studies.status === 'loading' && !data && <div role="status" aria-busy="true"><span className="sr-only">Loading the studies…</span><Skeleton variant="panel" /></div>}
      {failure && !data && (
        <Notice tone="error" action={<Action variant="secondary" size="sm" onClick={reload}>Retry</Action>}>
          {failure.status === 403
            ? `This credential can’t read studies${marker(failure)}. Use a session, or a key with studies:read.`
            : `Studies couldn’t be loaded${marker(failure)}.`}
        </Notice>
      )}

      {none && (
        <section className="st-intro" aria-label="No studies yet">
          <DemoGrid />
          <div>
            <strong>No studies yet</strong>
            <span>2 case revisions × 2 engines × 2 seeds = 8 runs, all with the same rules. That’s a study.</span>
            {canCreate
              ? <Action to={`${root}/studies/new`} variant="primary">Build a study</Action>
              : <small className="org-muted">{publicRead ? 'This project hasn’t shared a study yet.' : `Creating a study needs MEMBER in ${organization.name}.`}</small>}
          </div>
        </section>
      )}

      {data && data.length > 0 && rows.length === 0 && (
        <EmptyState icon={<FlaskConical />} title="Every study is archived" dashed>Show archived studies to see them and their results.</EmptyState>
      )}

      {rows.length > 0 && (
        <ul className="st-list" aria-label="Studies of the project">
          {rows.map(({ study, runs, latestCells }) => {
            const run = latestOf(runs);
            const size = definitionSize(study.definition);
            const when = run ? formatDate(run.created_at) : null;
            return (
              <li key={study.id} className="st-row">
                <Link to={`${root}/studies/${encodeURIComponent(study.slug)}`} viewTransition className="st-row-main">
                  <span className="st-row-name">
                    <strong>{study.name}</strong>
                    {study.archived && <Chip>Archived</Chip>}
                  </span>
                  <small>{formulaOf(size)} = {plural(size.cells, 'cell')}</small>
                  {study.description && <small className="org-muted">{study.description}</small>}
                </Link>
                <div className="st-row-run">
                  {run ? (
                    <>
                      <small>
                        <Link to={`${root}/studies/${encodeURIComponent(study.slug)}/runs/${run.id}`} viewTransition>Last run #{run.run_number}</Link>
                        {when ? ` · ${when}` : ''} · {run.state}
                        {runs.length > 1 ? ` · ${plural(runs.length, 'run')} in all` : ''}
                      </small>
                      {latestCells && latestCells.length > 0 ? <CellBar cells={latestCells} size="sm" /> : <StateChip state={run.state} />}
                    </>
                  ) : <small>Never run</small>}
                </div>
                {(canCreate || canAdminister) && (
                  <div className="st-row-actions">
                    {canCreate && (
                      <Action variant="secondary" size="sm" busy={busy === study.id} onClick={() => void archive(study)}>
                        {study.archived ? 'Restore' : 'Archive'}
                      </Action>
                    )}
                    {canAdminister && <Action variant="danger-outline" size="sm" disabled={busy === study.id} onClick={() => setDeleting(study)}>Delete</Action>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {deleting && (
        <Modal title={`Delete ${deleting.name}?`} tone="danger" size="md" onClose={() => busy === null && setDeleting(null)}>
          <p>The definition goes away for good. A study that already has runs can’t be deleted, because runs are history: it is archived instead, and its results stay.</p>
          <div className="ui-modal-actions">
            <Action variant="secondary" onClick={() => setDeleting(null)} disabled={busy !== null}>Cancel</Action>
            <Action variant="danger" busy={busy === deleting.id} onClick={() => void remove(deleting)}>Delete study</Action>
          </div>
        </Modal>
      )}
    </StudyFrame>
  );
}

/** The studies of a project (`study-list`, `/app/:org/:project/studies`): the matrix of each and its latest run. */
export function StudyList() {
  const { orgSlug, projectSlug, organization, project, access, waiting, failure, reload } = useRouteProject();
  if (waiting) return <ProjectSkeleton />;
  if (!organization || !project) {
    return <ProjectGate failure={organization ? failure : null} orgSlug={orgSlug} projectSlug={projectSlug} organizationName={organization?.name} onRetry={reload} />;
  }
  return <StudyListBody key={`${organization.slug}/${project.slug}`} organization={organization} project={project} canCreate={access.canCreate} canAdminister={access.canAdminister} />;
}
