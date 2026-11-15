import { Link } from 'react-router-dom';
import { Chip } from '../../components/ui/Chip';
import { useCopy } from '../../components/ui/useCopy';
import { problemPath } from '../../routes/paths/problems';
import { formatBytes, formatDate } from '../../utils/format';
import { useResource } from '../../utils/useResource';
import { exactReference } from './casesModel';
import { loadModel, modelKey, type ModelState } from './modelLoader';
import { Power } from './parts';
import type { RouteProblemContent } from './useRouteProblem';
// The timeline styles keep the name of the page that used to hold them.
import './VersionHistory.css';

type Version = RouteProblemContent['revisions'][number];

function VersionCard({ org, caseSlug, revision, previous, latest, model, runHref }: {
  org: string; caseSlug: string; revision: Version; previous: Version | undefined; latest: boolean; model: ModelState | undefined;
  /** Where a run of the version is launched; `null` hides the link (a viewer). */
  runHref: string | null;
}) {
  const { copy, status } = useCopy();
  const summary = !previous
    ? 'First version.'
    : previous.package_digest === revision.package_digest ? `Same package as v${previous.revision}.` : `A different package from v${previous.revision}.`;
  const href = problemPath(org, caseSlug, undefined, { version: revision.revision });
  const key = `r${revision.revision}`;
  const log10 = model?.state === 'ready' ? model.model?.log10 ?? null : null;

  return (
    <li className="case-rev">
      <span className={`case-rev-dot${latest ? ' is-latest' : ''}`} aria-hidden="true">v{revision.revision}</span>
      <div className="case-rev-card">
        <div className="case-rev-head">
          <Link to={href} viewTransition><strong>Version {revision.revision}</strong></Link>
          {latest && <Chip tone="accent">Latest</Chip>}
          <span className="case-rev-date">{formatDate(revision.created_at) ?? '—'}</span>
          <button type="button" className="case-link-button" onClick={() => void copy(exactReference(caseSlug, revision), key)} aria-label={`Copy exact reference of version ${revision.revision}`}>
            {status(key) === 'copied' ? 'Copied' : status(key) === 'failed' ? 'Copy failed' : 'Copy reference'}
          </button>
        </div>
        <p className="case-rev-change">{summary} {formatBytes(revision.package_size)?.split(' (')[0] ?? ''}</p>
        {log10 !== null && (
          <div className="case-rev-size">
            Combinations
            <span className="case-bar" aria-hidden="true"><i style={{ width: `${Math.min(100, Math.round((log10 / 20) * 100))}%` }} /></span>
            <span>≈ <Power log10={log10} /></span>
          </div>
        )}
        <div className="case-rev-links">
          <Link to={href} viewTransition>Open</Link>
          {previous && <Link to={problemPath(org, caseSlug, 'versions', { from: previous.revision, to: revision.revision })} viewTransition>Compare with v{previous.revision}</Link>}
          {runHref && <Link to={runHref} viewTransition>Run</Link>}
          <Link to={problemPath(org, caseSlug, 'source', { version: revision.revision })} viewTransition>Source</Link>
        </div>
      </div>
    </li>
  );
}

/** The history of a problem: its versions as a timeline, newest first. */
export function VersionHistory({ org, content, runOf, canCreate }: {
  org: string; content: RouteProblemContent; runOf: (revision: number) => string | null; canCreate: boolean;
}) {
  const { item, revisions } = content;
  const latest = revisions[0];
  const glanceState = useResource<ModelState | null>(
    latest ? modelKey(org, item.slug, latest) : 'model:none',
    async () => (latest ? loadModel(org, item.slug, latest.revision) : null),
  );
  return (
    <section className="org-section" aria-labelledby="cd-revisions">
      <h2 id="cd-revisions">Versions</h2>
      <ol className="case-timeline">
        {revisions.map((revision, index) => (
          <VersionCard
            key={revision.id}
            org={org}
            caseSlug={item.slug}
            revision={revision}
            previous={revisions[index + 1]}
            latest={index === 0}
            model={index === 0 ? glanceState.data ?? undefined : undefined}
            runHref={canCreate ? runOf(revision.revision) : null}
          />
        ))}
      </ol>
    </section>
  );
}
