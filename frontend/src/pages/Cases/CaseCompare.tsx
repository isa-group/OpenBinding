import { Link, useSearchParams } from 'react-router-dom';
import { SourceView } from '../../components/rendering/SourceView';
import { Action } from '../../components/ui/Action';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { useCopy } from '../../components/ui/useCopy';
import { problemPath } from '../../routes/paths/problems';
import {
  DIFF_CATEGORIES, diffRevisions, diffSummary, resourceUses, sizeChange, type DiffCategory, type DiffRow, type RevisionView,
} from './casesModel';
import { loadModel } from './modelLoader';
import { Power } from './parts';
import { useLoadedMap } from './useLoadedMap';
import type { RouteCaseContent } from './useRouteCase';

const numberOf = (value: string | null): number | null => {
  const parsed = value === null ? NaN : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

/** The comparison of two problem versions, in the Versions tab: the pair is chosen by the query `from` and `to` (the previous version and the latest by default). */
export function VersionCompare({ root, content, canCreate }: { root: string; content: RouteCaseContent; canCreate: boolean }) {
  const { item, revisions } = content;
  const [params, setParams] = useSearchParams();
  const { copy, status } = useCopy();
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
    <section className="org-section" aria-labelledby="cc-title">
      <header className="proj-title-row">
        <div className="proj-title">
          <h2 id="cc-title">Compare versions</h2>
          <p>{item.name} · what changed between two sealed versions.</p>
        </div>
        <div className="case-pickers">
          <label className="case-pick">
            From
            <select value={fromNumber ?? ''} onChange={(event) => update({ from: event.target.value })}>
              {options.map((number) => <option key={number} value={number}>Version {number}</option>)}
            </select>
          </label>
          <Action variant="secondary" aria-label="Swap versions" onClick={() => update({ from: String(toNumber ?? ''), to: String(fromNumber ?? '') })}>⇄</Action>
          <label className="case-pick">
            To
            <select value={toNumber ?? ''} onChange={(event) => update({ to: event.target.value })}>
              {options.map((number) => <option key={number} value={number}>Version {number}</option>)}
            </select>
          </label>
        </div>
      </header>

      {revisions.length < 2 && (
        <div className="case-guide">
          <h2>Comparing needs two versions</h2>
          <p>{item.name} has {revisions.length === 0 ? 'no sealed version' : 'one sealed version'} so far. Seal another one to see what changed.</p>
          {canCreate && <div className="proj-actions"><Action to={`${root}/workbench?case=${encodeURIComponent(item.slug)}`} variant="primary">New version</Action></div>}
        </div>
      )}
      {revisions.length >= 2 && missingSide && (
        <Notice tone="error">One of these versions doesn’t exist (404). Pick another pair.</Notice>
      )}
      {revisions.length >= 2 && same && (
        <div className="case-guide is-plain">Both sides are the same version, so there’s nothing to compare. Choose two different versions.</div>
      )}
      {waitingModels && (
        <div role="status" aria-busy="true"><span className="sr-only">Reading both versions…</span><Skeleton variant="card" /><Skeleton variant="panel" /></div>
      )}

      {left && right && !same && !missingSide && (
        <>
          {modelsMissing && (
            <Notice tone="info">
              Providers, tasks, rules and goal are compared from the compiled snapshot of each version, and {!left.model ? `version ${left.revision}` : `version ${right.revision}`} has none that can be read.
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
                    <span>Version {side.revision}</span>
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
                    <th scope="col">Version {left.revision}</th>
                    <th scope="col">Version {right.revision}</th>
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
            <span className="case-links"><Link to={problemPath(root, item.slug, undefined, { version: right.revision })} viewTransition>Open version {right.revision}</Link></span>
          </section>

          <section className="org-section" aria-labelledby="cc-documents">
            <h2 id="cc-documents">Sealed documents</h2>
            <div className="case-docs">
              {[left, right].map((side) => {
                const document = revisions.find((revision) => revision.revision === side.revision)?.document ?? {};
                return <SourceView key={side.revision} source={document} label={`Version ${side.revision} document`} language="json" maxHeight="20rem" />;
              })}
            </div>
          </section>
        </>
      )}
    </section>
  );
}
