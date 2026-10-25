import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Globe2 } from 'lucide-react';
import { platformApi, type Organization, type Project, type Publication, type Report } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { Chip } from '../../components/ui/Chip';
import { CopyField } from '../../components/ui/CopyField';
import { EmptyState } from '../../components/ui/EmptyState';
import { Modal } from '../../components/ui/Modal';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { useCopy } from '../../components/ui/useCopy';
import { shortDigest } from '../../utils/digest';
import { formatDate } from '../../utils/format';
import { useResource } from '../../utils/useResource';
import { classifyAuthError, marker } from '../Account/accountErrors';
import { RefusalNotice } from '../Jobs/parts';
import { ProjectGate, ProjectSkeleton } from '../Project/parts';
import { useRouteProject } from '../Project/useRouteProject';
import { ReportFrame } from './parts';
import { reportRefusal, type Refusal } from './reportErrors';
import { citationBibtex, citationFields, citationText } from './reportsModel';

function PublicationCard({ publication, report, canWithdraw, onWithdraw }: {
  publication: Publication;
  report: Report | undefined;
  canWithdraw: boolean;
  onWithdraw: (publication: Publication) => void;
}) {
  const { copy, status } = useCopy();
  const fields = citationFields(publication.citation, report?.title ?? publication.slug);
  // The publication does not carry the fingerprint of its edition; the report's is the same one only while that edition is the sealed one.
  const digest = report && report.version_id === publication.version_id && report.digest ? report.digest : null;
  const verifyUrl = digest ? `${window.location.origin}/resolve/report/${digest}` : undefined;
  const text = citationText(fields);
  const meta = [publication.slug, `published ${formatDate(publication.published_at) ?? '—'}`, digest ? shortDigest(digest) : null].filter(Boolean).join(' · ');
  return (
    <article className="rp-pub">
      <header>
        <h2>{fields.title}</h2>
        {publication.withdrawn ? <Chip tone="warning">Withdrawn · still reachable by link</Chip> : <Chip tone="success">Published</Chip>}
      </header>
      <p className="rp-pub-meta">{meta}</p>
      <div className="rp-cite-box">
        <span className="rp-cite-label">Cite as</span>
        <span className="rp-cite">{text}</span>
        <span className="rp-links">
          <button type="button" onClick={() => void copy(text, 'cite')}>{status('cite') === 'copied' ? 'Citation copied' : 'Copy citation'}</button>
          <button type="button" onClick={() => void copy(citationBibtex(fields, publication.slug, verifyUrl), 'bib')}>{status('bib') === 'copied' ? 'Copied for reference manager' : 'Copy for reference manager'}</button>
        </span>
      </div>
      {verifyUrl && <CopyField value={verifyUrl} label="public link" truncate />}
      <div className="rp-pub-actions">
        {digest && <Action to={`/resolve/report/${digest}`} variant="secondary">Open public verification</Action>}
        {canWithdraw && !publication.withdrawn && <Action variant="danger-outline" onClick={() => onWithdraw(publication)}>Withdraw</Action>}
      </div>
      {!canWithdraw && !publication.withdrawn && <small className="rp-muted">Withdrawing needs ADMIN.</small>}
    </article>
  );
}

function PublicationsBody({ organization, project, canAdminister }: { organization: Organization; project: Project; canAdminister: boolean }) {
  const org = organization.slug;
  const slug = project.slug;
  const content = useResource(`publications:${org}/${slug}`, async () => {
    const [publications, reports] = await Promise.all([platformApi.publications(org, slug), platformApi.reports(org, slug).catch(() => [] as Report[])]);
    return { publications, reports };
  });
  const [withdrawing, setWithdrawing] = useState<Publication | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [done, setDone] = useState('');

  const data = content.data ?? content.stale;
  const failure = content.status === 'error' ? classifyAuthError(content.error) : null;

  const withdraw = async (publication: Publication) => {
    setBusy(true);
    setRefusal(null);
    try {
      await platformApi.deletePublication(org, slug, publication.slug);
      setWithdrawing(null);
      setDone('Withdrawn. It’s no longer listed in Explore, but its link, citation and fingerprint still work.');
      content.reload();
    } catch (caught) {
      setRefusal(reportRefusal(caught, 'withdraw'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ReportFrame organization={organization} project={project} trail={[{ label: 'Publications' }]}>
      <header className="proj-title-row">
        <div className="proj-title">
          <h1>Publications</h1>
          <p>Report editions made public from {project.name}. Withdrawing hides one from listings but keeps every link and fingerprint working.</p>
        </div>
      </header>

      {done && <Notice tone="success">{done}</Notice>}
      {content.status === 'loading' && !data && <div role="status" aria-busy="true"><span className="sr-only">Loading the publications…</span><Skeleton variant="panel" /></div>}
      {failure && !data && (
        <Notice tone={failure.status === 403 ? 'warning' : 'error'} action={<Action variant="secondary" size="sm" onClick={content.reload}>Retry</Action>}>
          {failure.status === 404
            ? `Publications couldn’t be found${marker(failure)}.`
            : failure.status === 403
              ? `This API key can’t read publications${marker(failure)}. Use a session, or a key with reports:read.`
              : `Publications couldn’t be loaded${marker(failure)}.`}
        </Notice>
      )}
      {data && data.publications.length === 0 && (
        <EmptyState dashed icon={<Globe2 />} title="Nothing published yet">
          Nothing published from this project yet. Published editions are listed here with their citation.
        </EmptyState>
      )}
      {data && data.publications.length > 0 && (
        <div className="rp-pubs">
          {data.publications.map((publication) => (
            <PublicationCard
              key={publication.id}
              publication={publication}
              report={data.reports.find((report) => report.id === publication.report_id)}
              canWithdraw={canAdminister}
              onWithdraw={(item) => { setRefusal(null); setDone(''); setWithdrawing(item); }}
            />
          ))}
        </div>
      )}
      {data && data.publications.length > 0 && <p className="rp-muted">Public editions are also listed in <Link to="/explore">Explore</Link> while they are not withdrawn.</p>}

      {withdrawing && (
        <Modal title={`Withdraw ${withdrawing.slug}?`} tone="danger" size="md" onClose={() => !busy && setWithdrawing(null)}>
          <p>It leaves the listings in Explore. Its link, citation and fingerprint keep working, so nobody who cited it is left with a broken reference.</p>
          {refusal && <RefusalNotice refusal={refusal} />}
          <div className="ui-modal-actions">
            <Action variant="secondary" onClick={() => setWithdrawing(null)} disabled={busy}>Cancel</Action>
            <Action variant="danger" busy={busy} onClick={() => void withdraw(withdrawing)}>Withdraw</Action>
          </div>
        </Modal>
      )}
    </ReportFrame>
  );
}

/** The publications of a project (`proj-publications`, `/app/:org/:project/publications`): the editions made public, how to cite them, and withdrawing one. */
// [impl->req~frontend-retire-reports-publications-stay~1]
export function ProjPublications() {
  const { orgSlug, projectSlug, organization, project, access, waiting, failure, reload } = useRouteProject();
  if (waiting) return <ProjectSkeleton />;
  if (!organization || !project) {
    return <ProjectGate failure={organization ? failure : null} orgSlug={orgSlug} projectSlug={projectSlug} organizationName={organization?.name} onRetry={reload} />;
  }
  return <PublicationsBody key={`${organization.slug}/${project.slug}`} organization={organization} project={project} canAdminister={access.canAdminister} />;
}
