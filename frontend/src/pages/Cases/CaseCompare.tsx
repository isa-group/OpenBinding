import { Link, useSearchParams } from 'react-router-dom';
import type { Organization, Project } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { useCopy } from '../../components/ui/useCopy';
import { ProjectGate, ProjectSkeleton } from '../Project/parts';
import { isMissing, marker } from './caseErrors';
import {
  DIFF_CATEGORIES, diffRevisions, diffSummary, resourceUses, sizeChange, type DiffCategory, type DiffRow, type RevisionView,
} from './casesModel';
import { loadModel } from './modelLoader';
import { CaseFrame, CaseMissing, Power } from './parts';
import { useLoadedMap } from './useLoadedMap';
import { useRouteCase, type RouteCaseContent } from './useRouteCase';

const numberOf = (value: string | null): number | null => {
  const parsed = value === null ? NaN : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

// [impl->req~frontend-retire-composer-entry-points-repointed~1]
function CompareBody({ organization, project, content, canCreate }: { organization: Organization; project: Project; content: RouteCaseContent; canCreate: boolean }) {
  const { item, revisions } = content;
  const [params, setParams] = useSearchParams();
  const { copy, status } = useCopy();
  const root = `/app/${organization.slug}/${project.slug}`;
  const base = `${root}/cases/${item.slug}`;
  const latest = revisions[0]?.revision;
  const older = revisions[1]?.revision;
  const fromNumber = numberOf(params.get('from')) ?? older ?? latest;
  const toNumber = numberOf(params.get('to')) ?? latest;
  const category = (params.get('only') ?? '') as DiffCategory | '';
  const from = revisions.find((revision) => revision.revision === fromNumber);
  const to = revisions.find((revision) => revision.revision === toNumber);

  const models = useLoadedMap(
    [from, to].filter((revision) => revision !== undefined).map((revision) => String(revision.revision)),
    (key) => loadModel(revisions.find((revision) => String(revision.revision) === key)?.source_snapshot_id ?? null),
  );
  const modelOf = (revision: typeof from): RevisionView | null => {
    if (!revision) return null;
    const answer = models[String(revision.revision)];
    if (!answer || answer.status === 'loading') return null;
    const state = answer.status === 'ready' ? answer.value : undefined;
    return { revision: revision.revision, uses: resourceUses(revision.document), model: state?.state === 'ready' ? state.model : null };
  };
  const left = modelOf(from);
  const right = modelOf(to);

  const update = (next: Record<string, string>) => {
    const merged = new URLSearchParams(params);
    for (const [key, value] of Object.entries(next)) {
      if (value) merged.set(key, value);
      else merged.delete(key);
    }
    setParams(merged, { replace: true });
  };

  const same = fromNumber !== undefined && fromNumber === toNumber;
  const missingSide = fromNumber !== undefined && toNumber !== undefined && (!from || !to);
  const rows: DiffRow[] = left && right && !same ? diffRevisions(left, right) : [];
  const changedIn = (name: DiffCategory | '') => rows.filter((row) => (!name || row.category === name) && row.changed).length;
  const hasRowsIn = (name: DiffCategory) => rows.some((row) => row.category === name);
  const visible = rows.filter((row) => !category || row.category === category);
  const waitingModels = !missingSide && !same && from !== undefined && to !== undefined && (!left || !right);
  const modelsMissing = left && right && (!left.model || !right.model);
  const growth = left?.model && right?.model ? sizeChange(left.model.log10, right.model.log10) : null;
  const options = revisions.map((revision) => revision.revision).sort((a, b) => a - b);

  return (
    <CaseFrame organization={organization} project={project} trail={[{ label: 'Cases', to: `${root}/cases` }, { label: item.name, to: base }, { label: 'Compare' }]}>
      <header className="proj-title-row">
        <div className="proj-title">
          <h1>Compare revisions</h1>
          <p>{item.name} · what changed between two sealed revisions.</p>
        </div>
        <div className="case-pickers">
          <label className="case-pick">
            From
            <select value={fromNumber ?? ''} onChange={(event) => update({ from: event.target.value })}>
              {options.map((number) => <option key={number} value={number}>Revision {number}</option>)}
            </select>
          </label>
          <Action variant="secondary" aria-label="Swap revisions" onClick={() => update({ from: String(toNumber ?? ''), to: String(fromNumber ?? '') })}>⇄</Action>
          <label className="case-pick">
            To
            <select value={toNumber ?? ''} onChange={(event) => update({ to: event.target.value })}>
              {options.map((number) => <option key={number} value={number}>Revision {number}</option>)}
            </select>
          </label>
        </div>
      </header>

      {revisions.length < 2 && (
        <div className="case-guide">
          <h2>Comparing needs two revisions</h2>
          <p>{item.name} has {revisions.length === 0 ? 'no sealed revision' : 'one sealed revision'} so far. Seal another one to see what changed.</p>
          <div className="proj-actions">{canCreate && <Action to={`${root}/workbench?case=${encodeURIComponent(item.slug)}`} variant="primary">New revision</Action>}<Action to={base} variant="secondary">Back to the case</Action></div>
        </div>
      )}
      {revisions.length >= 2 && missingSide && (
        <Notice tone="error">One of these revisions doesn’t exist (404). Pick another pair.</Notice>
      )}
      {revisions.length >= 2 && same && (
        <div className="case-guide is-plain">Both sides are the same revision, so there’s nothing to compare. Choose two different revisions.</div>
      )}
      {waitingModels && (
        <div role="status" aria-busy="true"><span className="sr-only">Reading both revisions…</span><Skeleton variant="card" /><Skeleton variant="panel" /></div>
      )}

      {left && right && !same && !missingSide && (
        <>
          {modelsMissing && (
            <Notice tone="info">
              Providers, tasks, rules and goal are compared from the compiled snapshot of each revision, and {!left.model ? `revision ${left.revision}` : `revision ${right.revision}`} has none that can be read.
              Only the library versions are compared.
            </Notice>
          )}
          <section aria-label="Summary" className="case-categories">
            {(['', ...DIFF_CATEGORIES] as const).map((name) => {
              const count = changedIn(name);
              const unknown = name !== '' && name !== 'Resources' && !hasRowsIn(name);
              return (
                <button key={name || 'all'} type="button" aria-pressed={category === name} className="case-category" onClick={() => update({ only: name })}>
                  <span>{name === '' ? 'All changes' : name}</span>
                  <b>{unknown ? '—' : count}</b>
                  <em className={count > 0 ? 'is-changed' : undefined}>{unknown ? 'not compared' : count > 0 ? 'changed' : 'no change'}</em>
                </button>
              );
            })}
          </section>

          {left.model && right.model && (
            <section className="proj-panel case-sizes" aria-labelledby="cc-size">
              <h2 id="cc-size">Possible combinations</h2>
              <div className="case-size-bars">
                {[left, right].map((side, index) => (
                  <div key={side.revision} className="case-size-row">
                    <span>Revision {side.revision}</span>
                    <span className="case-bar" aria-hidden="true"><i className={index === 0 ? 'is-from' : undefined} style={{ width: `${Math.min(100, Math.round(((side.model?.log10 ?? 0) / 20) * 100))}%` }} /></span>
                    <span>≈ <Power log10={side.model?.log10 ?? null} /></span>
                  </div>
                ))}
              </div>
              {growth && <span className={`case-delta${growth.grew ? ' is-grew' : ''}`}>{growth.text}</span>}
            </section>
          )}

          <section className="org-section" aria-labelledby="cc-table">
            <div className="org-section-head">
              <h2 id="cc-table">Side by side</h2>
              <Action variant="secondary" onClick={() => void copy(diffSummary(item.slug, left, right, rows), 'summary')}>
                {status('summary') === 'copied' ? 'Summary copied' : status('summary') === 'failed' ? 'Copy failed' : 'Copy summary'}
              </Action>
            </div>
            <div className="case-table-scroll proj-panel">
              <table className="case-table is-compare">
                <thead>
                  <tr>
                    <th scope="col">What</th>
                    <th scope="col">Revision {left.revision}</th>
                    <th scope="col">Revision {right.revision}</th>
                    <th scope="col">Change</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((row) => (
                    <tr key={`${row.category}/${row.what}`} className={row.changed ? 'is-changed' : undefined}>
                      <th scope="row"><small>{row.category}</small>{row.what}</th>
                      <td>{row.a}</td>
                      <td>{row.b}</td>
                      <td><span className={`case-change${row.changed ? ' is-changed' : ''}`}>{row.changed ? 'Changed' : 'Same'}</span></td>
                    </tr>
                  ))}
                  {visible.length === 0 && <tr><td colSpan={4}>Nothing to compare in this category.</td></tr>}
                </tbody>
              </table>
            </div>
            <span className="case-links"><Link to={`${base}/revisions/${right.revision}`} viewTransition>Open revision {right.revision}</Link><Link to={base} viewTransition>All revisions</Link></span>
          </section>
        </>
      )}
    </CaseFrame>
  );
}

/** Compare (`case-compare`, `/app/:org/:project/cases/:case/compare?from=&to=`): two sealed revisions side by side. */
export function CaseCompare() {
  const route = useRouteCase();
  const { orgSlug, projectSlug, caseSlug, organization, project, waiting, failure, reload, content, loaded, caseFailure } = route;
  if (waiting) return <ProjectSkeleton />;
  if (!organization || !project) {
    return <ProjectGate failure={organization ? failure : null} orgSlug={orgSlug} projectSlug={projectSlug} organizationName={organization?.name} onRetry={reload} />;
  }
  const root = `/app/${organization.slug}/${project.slug}`;
  const trail = [{ label: 'Cases', to: `${root}/cases` }, { label: caseSlug, to: `${root}/cases/${caseSlug}` }, { label: 'Compare' }];
  if (content.status === 'loading' && !loaded) {
    return (
      <CaseFrame organization={organization} project={project} trail={trail}>
        <div role="status" aria-busy="true"><span className="sr-only">Loading the case…</span><Skeleton variant="card" /><Skeleton variant="panel" /></div>
      </CaseFrame>
    );
  }
  if (caseFailure || !loaded) {
    const missing = isMissing(caseFailure);
    return (
      <CaseFrame organization={organization} project={project} trail={trail}>
        <CaseMissing
          title={missing ? `No case with this address in ${project.name} (404)` : `The case couldn’t be loaded${caseFailure ? marker(caseFailure) : ''}`}
          actions={<><Action to={`${root}/cases`} variant="primary">All cases</Action><Action variant="secondary" onClick={content.reload}>Retry</Action></>}
        >
          {missing ? 'It may have been deleted or renamed.' : 'The gateway didn’t answer for this case. Try again in a moment.'}
        </CaseMissing>
      </CaseFrame>
    );
  }
  return <CompareBody organization={organization} project={project} content={loaded} canCreate={route.access.canCreate} />;
}
