import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Lock } from 'lucide-react';
import { casesApi } from '../../api/cases';
import type { ArtifactVersion } from '../../api/library';
import type { CaseRevision as Revision, Organization, Project } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { useCopy } from '../../components/ui/useCopy';
import { shortDigest } from '../../utils/digest';
import { formatBytes, formatDateTime } from '../../utils/format';
import { useResource } from '../../utils/useResource';
import { ProjectGate, ProjectSkeleton } from '../Project/parts';
import { featureNumber, type BindingModel, type FeatureValue, type TaskInfo } from './bindingModel';
import { classifyAuthError, isMissing, marker } from './caseErrors';
import { plural, refLabel, resourceUses, roleLabel, type ResourceUse } from './casesModel';
import { loadModel, type ModelState } from './modelLoader';
import { CaseFrame, CaseMissing, DigestLine, FlowDrawing, Power } from './parts';
import { useLoadedMap, type Loaded } from './useLoadedMap';
import { useRouteCase, type RouteCaseContent } from './useRouteCase';

function shown(value: FeatureValue, unit: string | null): string {
  const tail = unit ? ` ${unit}` : '';
  if (typeof value === 'number') return `${value.toLocaleString('en-US', { maximumFractionDigits: 4 })}${tail}`;
  return `${value.min.toLocaleString('en-US', { maximumFractionDigits: 4 })}–${value.max.toLocaleString('en-US', { maximumFractionDigits: 4 })}${tail}`;
}

/** The candidates that can serve one task, one column per quality they declare. */
function CandidateTable({ model }: { model: BindingModel }) {
  const services = model.tasks.filter((task) => task.kind === 'service' && task.candidates.length > 0);
  const [picked, setPicked] = useState('');
  const task: TaskInfo | undefined = services.find((item) => item.id === picked) ?? services[0];
  if (!task) {
    return (
      <div className="proj-panel">
        <h3>Providers</h3>
        <p className="org-muted">No task of this revision has candidates to list.</p>
      </div>
    );
  }
  const columns = [...new Set(task.candidates.flatMap((candidate) => Object.keys(candidate.features)))].slice(0, 5);
  const maxima = Object.fromEntries(columns.map((column) => [column, Math.max(...task.candidates.map((candidate) => (candidate.features[column] === undefined ? 0 : Math.abs(featureNumber(candidate.features[column])))), 0)]));
  return (
    <section className="proj-panel case-candidates" aria-labelledby="rv-candidates">
      <div className="proj-panel-head">
        <h3 id="rv-candidates">Candidates</h3>
        <label className="case-sort">
          Task
          <select value={task.id} onChange={(event) => setPicked(event.target.value)}>
            {services.map((item) => <option key={item.id} value={item.id}>{item.id}</option>)}
          </select>
        </label>
      </div>
      <span className="org-muted">{task.candidates.length === 1 ? '1 provider' : `${task.candidates.length} providers`} can serve <code>{task.id}</code>{task.capability ? ` (${task.capability})` : ''}.</span>
      <div className="case-table-scroll">
        <table className="case-table">
          <thead>
            <tr>
              <th scope="col">Provider</th>
              {columns.map((column) => <th scope="col" key={column}>{column}</th>)}
            </tr>
          </thead>
          <tbody>
            {task.candidates.map((candidate) => (
              <tr key={candidate.id}>
                <th scope="row"><code>{candidate.name}</code>{candidate.provider && candidate.provider !== candidate.name && <small>{candidate.provider}</small>}</th>
                {columns.map((column) => {
                  const value = candidate.features[column];
                  const ratio = value === undefined || !maxima[column] ? 0 : Math.min(1, Math.abs(featureNumber(value)) / maxima[column]);
                  return (
                    <td key={column}>
                      {value === undefined ? '—' : (
                        <span className="case-cell">
                          <span className="case-bar is-small" aria-hidden="true"><i style={{ width: `${Math.round(ratio * 100)}%` }} /></span>
                          {shown(value, model.features[column]?.unit ?? null)}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RulesCard({ model }: { model: BindingModel }) {
  return (
    <section className="proj-panel" aria-labelledby="rv-rules">
      <h3 id="rv-rules">Rules</h3>
      {model.rules.length === 0 && <p className="org-muted">This revision declares no rules.</p>}
      <ul className="case-rules">
        {model.rules.map((rule) => (
          <li key={rule.id}>
            <span className={`case-must${rule.enforcement === 'soft' ? ' is-should' : ''}`}>{rule.enforcement === 'hard' ? 'MUST' : 'SHOULD'}</span>
            <span>
              {rule.text}
              {rule.when && <small> · when {rule.when}</small>}
              {rule.penalty && <small> · penalty {rule.penalty} if broken</small>}
              <small className="case-rule-id">{rule.id}</small>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function GoalCard({ model }: { model: BindingModel }) {
  const heaviest = Math.max(...model.penalties.map((penalty) => penalty.weight), 0);
  return (
    <section className="proj-panel" aria-labelledby="rv-goal">
      <h3 id="rv-goal">Goal</h3>
      {model.criteria.length === 0 && <p className="org-muted">This revision declares no criteria to optimize.</p>}
      <ul className="case-criteria">
        {model.criteria.map((criterion) => (
          <li key={criterion.id}>
            <span><b>{criterion.id}</b>{criterion.feature && criterion.feature !== criterion.id ? <small> ({criterion.feature})</small> : null}</span>
            <span>{criterion.direction === 'maximize' ? 'higher is better' : criterion.direction === 'minimize' ? 'lower is better' : 'direction not stated'}{criterion.range ? ` · scaled ${criterion.range.min}–${criterion.range.max}` : ''}</span>
          </li>
        ))}
      </ul>
      {model.penalties.length > 0 && (
        <>
          <b className="case-sub">Breaking a “should” rule costs</b>
          <ul className="case-criteria">
            {model.penalties.map((penalty) => (
              <li key={penalty.rule}>
                <span>{penalty.rule}</span>
                <span className="case-cell">
                  <span className="case-bar is-small" aria-hidden="true"><i style={{ width: `${heaviest ? Math.round((penalty.weight / heaviest) * 100) : 0}%` }} /></span>
                  weight {penalty.weight}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      <span className="org-muted">How the criteria trade off against each other is chosen when the revision is run, so no weights are shown here.</span>
    </section>
  );
}

function PlacementCard({ model }: { model: BindingModel }) {
  const { placement } = model;
  if (!placement) {
    return (
      <div className="case-dashed"><b>Placement</b> · not declared in this revision (no pools, network or events).</div>
    );
  }
  return (
    <section className="proj-panel" aria-labelledby="rv-placement">
      <h3 id="rv-placement">Placement</h3>
      <ul className="case-criteria">
        {placement.pools.map((pool) => (
          <li key={pool.id}>
            <span><b>{pool.id}</b><small> ({pool.kind})</small></span>
            <span>{Object.entries(pool.capacity).map(([name, amount]) => `${name} ${amount.toLocaleString('en-US')}`).join(' · ') || 'no capacity stated'}</span>
          </li>
        ))}
      </ul>
      <span className="org-muted">
        {plural(placement.demands, 'demand')} · {plural(placement.links, 'network link')} · {plural(placement.events, 'event')} · {plural(placement.transitions, 'transition')}
      </span>
    </section>
  );
}

function ResourceCards({ organization, uses, resolved }: {
  organization: Organization; uses: ResourceUse[]; resolved: Record<string, Loaded<ArtifactVersion>>;
}) {
  if (uses.length === 0) {
    return <p className="org-muted">This revision doesn’t record its inputs as library versions, so there is nothing to link to. Its compiled form is still exact.</p>;
  }
  return (
    <ul className="case-resources">
      {uses.map((use) => {
        const answer = resolved[`${use.role}/${use.alias}`];
        const version = answer?.status === 'ready' ? answer.value : undefined;
        const failure = answer?.status === 'error' ? classifyAuthError(answer.error) : null;
        const note = !answer ? 'Looking it up…' : failure ? (isMissing(failure) ? `Can’t be reached${marker(failure)}` : `Couldn’t be loaded${marker(failure)}`)
          : version?.withdrawn ? 'Withdrawn · open in library' : version?.public ? 'Published · open in library' : 'Not published · open in library';
        const body = (
          <>
            <span className="case-resource-role">{roleLabel(use.role)}</span>
            <strong>{refLabel(use.ref)}</strong>
            <small>{note}</small>
            <code>{shortDigest(use.ref.versionDigest)}</code>
          </>
        );
        return (
          <li key={`${use.role}/${use.alias}`}>
            {version
              ? <Link className="case-resource" to={`/app/${organization.slug}/library/${version.artifact_id}/versions/${version.id}`} viewTransition>{body}</Link>
              : <div className={`case-resource${failure ? ' is-unresolved' : ''}`}>{body}</div>}
          </li>
        );
      })}
    </ul>
  );
}

function RevisionBody({ organization, project, content, revision }: {
  organization: Organization; project: Project; content: RouteCaseContent; revision: Revision;
}) {
  const navigate = useNavigate();
  const { copy, status } = useCopy();
  const { item, revisions } = content;
  const root = `/app/${organization.slug}/${project.slug}`;
  const base = `${root}/cases/${item.slug}`;
  const uses = resourceUses(revision.document);
  const modelState = useResource<ModelState>(`model:${revision.source_snapshot_id ?? 'none'}`, () => loadModel(revision.source_snapshot_id));
  const resolved = useLoadedMap(uses.map((use) => `${use.role}/${use.alias}`), (key) => {
    const use = uses.find((candidate) => `${candidate.role}/${candidate.alias}` === key);
    return use ? casesApi.resolveVersion(use.ref) : Promise.reject(new Error('Unknown resource'));
  });

  const model = modelState.data?.state === 'ready' ? modelState.data.model : null;
  const snapshot = modelState.data?.state === 'ready' ? modelState.data.snapshot : null;
  const unresolved = modelState.data?.state === 'failed' || Object.values(resolved).some((answer) => answer.status === 'error');
  const profile = model?.profile ?? (typeof (revision.document.spec as { profile?: unknown } | undefined)?.profile === 'string' ? String((revision.document.spec as { profile: string }).profile) : null);
  const previous = revisions.find((candidate) => candidate.revision === revision.revision - 1);
  const compare = `${base}/compare?from=${previous ? previous.revision : revision.revision}&to=${revision.revision}`;

  return (
    <CaseFrame organization={organization} project={project} trail={[{ label: 'Cases', to: `${root}/cases` }, { label: item.name, to: base }, { label: `Revision ${revision.revision}` }]}>
      <header className="proj-title-row">
        <div className="proj-title">
          <div className="proj-title-line">
            <h1>{item.name} · revision {revision.revision}</h1>
            <span className="case-sealed"><Lock aria-hidden="true" />Sealed</span>
          </div>
          <label className="case-sort">
            Show revision
            <select value={String(revision.revision)} onChange={(event) => navigate(`${base}/revisions/${event.target.value}`)}>
              {revisions.map((candidate, index) => <option key={candidate.id} value={candidate.revision}>Revision {candidate.revision}{index === 0 ? ' · latest' : ''}</option>)}
            </select>
          </label>
        </div>
        <div className="proj-actions">
          <Action to={`${root}/jobs/new?case=${encodeURIComponent(item.slug)}&revision=${revision.revision}`} variant="primary">Run this revision</Action>
          <Action to={compare} variant="secondary">Compare</Action>
          <Action to={`${root}/studies/new?case=${encodeURIComponent(item.slug)}&revision=${revision.revision}`} variant="secondary">Add to study</Action>
        </div>
      </header>

      {unresolved && (
        <Notice tone="warning">
          Some resources of this revision couldn’t be loaded right now, so the model below may be incomplete. The fingerprint and identity are still exact.
        </Notice>
      )}

      <section aria-labelledby="rv-identity">
        <h2 id="rv-identity" className="sr-only">Identity</h2>
        <dl className="case-identity">
          <div><dt>Fingerprint</dt><dd><DigestLine digest={revision.digest} label={`revision ${revision.revision}`} copyKey="digest" /></dd></div>
          <div><dt>Sealed</dt><dd>{formatDateTime(revision.created_at) ?? '—'}</dd></div>
          <div>
            <dt>Language profile</dt>
            <dd>{profile ?? 'not stated'}{model && model.dialects.length === 0 ? ' · no dialects' : ''} <Link to="/language" viewTransition>Profiles</Link></dd>
          </div>
          <div>
            <dt>Compiled snapshot</dt>
            <dd>
              {revision.source_snapshot_id
                ? <>{snapshot ? `${formatDateTime(snapshot.createdAt) ?? ''} · ${formatBytes(snapshot.archiveSize)?.split(' (')[0] ?? ''}` : 'Sealed with this revision'} <Link to={`${root}/snapshots/${revision.source_snapshot_id}`} viewTransition>Open snapshot</Link></>
                : 'None: this revision was sealed without one'}
            </dd>
          </div>
        </dl>
      </section>
      <div className="case-copyline">
        <Action variant="secondary" onClick={() => void copy(`${item.slug}@${revision.revision} ${revision.digest}`, 'reference')}>
          {status('reference') === 'copied' ? 'Reference copied' : status('reference') === 'failed' ? 'Copy failed' : 'Copy exact reference'}
        </Action>
        <span className="org-muted">The reference points at exactly this content, forever.</span>
      </div>

      <section className="org-section" aria-labelledby="rv-workflow">
        <h2 id="rv-workflow">How the service works</h2>
        {modelState.status === 'loading' && <div role="status" aria-busy="true"><span className="sr-only">Reading the compiled form…</span><Skeleton variant="panel" /></div>}
        {modelState.data?.state === 'none' && <p className="org-muted">This revision has no compiled snapshot, so there is no workflow to draw.</p>}
        {modelState.data?.state === 'failed' && (
          <Notice tone="warning" action={<Action variant="secondary" size="sm" onClick={modelState.reload}>Retry</Action>}>
            The compiled form couldn’t be read{marker(modelState.data.failure)}.
          </Notice>
        )}
        {modelState.data?.state === 'ready' && !model && <p className="org-muted">The compiled form isn’t a binding problem this page can draw.</p>}
        {model && (
          <div className="proj-panel">
            <div className="case-flow-head"><b>Workflow</b><span>· profile {model.profile ?? 'not stated'}</span></div>
            <FlowDrawing flow={model.flow} caption={<span>Possible combinations ≈ <Power log10={model.log10} /></span>} />
          </div>
        )}
      </section>

      {model && (
        <section className="org-section" aria-labelledby="rv-model">
          <h2 id="rv-model">Providers, rules and goal</h2>
          <div className="case-model">
            <CandidateTable model={model} />
            <div className="case-model-side">
              <RulesCard model={model} />
              <GoalCard model={model} />
              <PlacementCard model={model} />
            </div>
          </div>
        </section>
      )}

      <section className="org-section" aria-labelledby="rv-resources">
        <h2 id="rv-resources">Resources it’s built from</h2>
        <ResourceCards organization={organization} uses={uses} resolved={resolved} />
      </section>
    </CaseFrame>
  );
}

/** A revision (`case-revision`, `/app/:org/:project/cases/:case/revisions/:revision`): the model of one sealed revision in plain language. */
export function CaseRevision() {
  const route = useRouteCase();
  const { revision: revisionParam = '' } = useParams();
  const { orgSlug, projectSlug, caseSlug, organization, project, waiting, failure, reload, content, loaded, caseFailure } = route;
  const found = loaded?.revisions.find((candidate) => String(candidate.revision) === revisionParam);
  const remote = useResource<Revision | null>(
    `revision:${orgSlug}/${projectSlug}/${caseSlug}/${revisionParam}:${content.status === 'ready' && !found ? 'ask' : 'skip'}`,
    async () => (organization && project && content.status === 'ready' && !found ? casesApi.revision(organization.slug, project.slug, caseSlug, revisionParam) : null),
  );

  if (waiting) return <ProjectSkeleton />;
  if (!organization || !project) {
    return <ProjectGate failure={organization ? failure : null} orgSlug={orgSlug} projectSlug={projectSlug} organizationName={organization?.name} onRetry={reload} />;
  }
  const root = `/app/${organization.slug}/${project.slug}`;
  const trail = [{ label: 'Cases', to: `${root}/cases` }, { label: caseSlug, to: `${root}/cases/${caseSlug}` }, { label: `Revision ${revisionParam}` }];

  if ((content.status === 'loading' && !loaded) || (!found && content.status === 'ready' && remote.status === 'loading')) {
    return (
      <CaseFrame organization={organization} project={project} trail={trail}>
        <div role="status" aria-busy="true"><span className="sr-only">Loading the revision…</span><Skeleton variant="panel" /><Skeleton variant="panel" /></div>
      </CaseFrame>
    );
  }
  const revision = found ?? remote.data ?? undefined;
  if (caseFailure || !loaded || !revision) {
    const remoteFailure = remote.status === 'error' ? classifyAuthError(remote.error) : null;
    const missing = isMissing(caseFailure) || isMissing(remoteFailure) || (!caseFailure && !remoteFailure);
    return (
      <CaseFrame organization={organization} project={project} trail={trail}>
        <CaseMissing
          title={missing ? 'This revision doesn’t exist (404)' : `The revision couldn’t be loaded${marker(caseFailure ?? remoteFailure ?? { kind: 'unknown' })}`}
          actions={<Action to={`${root}/cases/${caseSlug}`} variant="primary">See all revisions</Action>}
        >
          {missing ? 'It may belong to another case, or the case may have been renamed. We answer the same way when you can’t see it.' : 'The gateway didn’t answer. Try again in a moment.'}
        </CaseMissing>
      </CaseFrame>
    );
  }
  return <RevisionBody key={revision.id} organization={organization} project={project} content={loaded} revision={revision} />;
}
