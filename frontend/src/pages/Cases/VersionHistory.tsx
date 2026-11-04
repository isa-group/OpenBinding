import { Link } from 'react-router-dom';
import { Chip } from '../../components/ui/Chip';
import { useCopy } from '../../components/ui/useCopy';
import { problemPath } from '../../routes/paths/problems';
import { formatDate } from '../../utils/format';
import { useResource } from '../../utils/useResource';
import { changesBetween, describeChange, exactReference, refLabel, resourceUses, roleLabel } from './casesModel';
import { loadModel, type ModelState } from './modelLoader';
import { Power } from './parts';
import type { RouteCaseContent } from './useRouteCase';
// The timeline styles keep the name of the page that used to hold them.
import '../Platform/CaseDetailPage.css';

type Version = RouteCaseContent['revisions'][number];

function VersionCard({ root, caseSlug, revision, previous, latest, model, publicRead }: {
  root: string; caseSlug: string; revision: Version; previous: Version | undefined; latest: boolean; model: ModelState | undefined;
  /** A visitor of a public project reads the version; running it, studying it and collecting it are for members. */
  publicRead: boolean;
}) {
  const { copy, status } = useCopy();
  const uses = resourceUses(revision.document);
  const before = previous ? resourceUses(previous.document) : [];
  const changes = previous ? changesBetween(before, uses) : [];
  const changed = new Set(changes.filter((change) => change.to !== null).map((change) => change.label));
  const summary = !previous
    ? 'First version.'
    : uses.length === 0 && before.length === 0
      ? 'Its inputs aren’t recorded as library versions.'
      : changes.length === 0 ? `Same library versions as v${previous.revision}.` : changes.map(describeChange).join(' · ');
  const href = problemPath(root, caseSlug, undefined, { version: revision.revision });
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
        <p className="case-rev-change">{summary}</p>
        {uses.length > 0 && (
          <ul className="case-uses" aria-label={`Library versions in version ${revision.revision}`}>
            {uses.map((use) => (
              <li key={`${use.role}/${use.alias}`} className={changed.has(`${roleLabel(use.role)} · ${use.alias}`) ? 'is-changed' : undefined}>
                <span>{roleLabel(use.role)}</span> <b>{refLabel(use.ref)}</b>
              </li>
            ))}
          </ul>
        )}
        {log10 !== null && (
          <div className="case-rev-size">
            Combinations
            <span className="case-bar" aria-hidden="true"><i style={{ width: `${Math.min(100, Math.round((log10 / 20) * 100))}%` }} /></span>
            <span>≈ <Power log10={log10} /></span>
          </div>
        )}
        <div className="case-rev-links">
          <Link to={href} viewTransition>Open</Link>
          {previous && <Link to={problemPath(root, caseSlug, 'versions', { from: previous.revision, to: revision.revision })} viewTransition>Compare with v{previous.revision}</Link>}
          {!publicRead && <Link to={`${root}/runs/new?case=${encodeURIComponent(caseSlug)}&revision=${revision.revision}`} viewTransition>Run</Link>}
          {!publicRead && <Link to={`${root}/studies/new?case=${encodeURIComponent(caseSlug)}&revision=${revision.revision}`} viewTransition>Add to study</Link>}
          {!publicRead && <Link to={`${root}/collections`} viewTransition>Add to collection</Link>}
          {revision.source_snapshot_id && <Link to={problemPath(root, caseSlug, 'source', { version: revision.revision })} viewTransition>Compiled snapshot</Link>}
        </div>
      </div>
    </li>
  );
}

/** The history of a problem: its versions as a timeline, newest first, with what changed between them. */
// [impl->req~frontend-nav-problem-page~1]
export function VersionHistory({ root, content, publicRead }: { root: string; content: RouteCaseContent; publicRead: boolean }) {
  const { item, revisions } = content;
  const latest = revisions[0];
  const glanceState = useResource<ModelState>(`glance:${latest?.source_snapshot_id ?? 'none'}`, () => loadModel(latest?.source_snapshot_id ?? null));
  return (
    <section className="org-section" aria-labelledby="cd-revisions">
      <h2 id="cd-revisions">Versions</h2>
      <ol className="case-timeline">
        {revisions.map((revision, index) => (
          <VersionCard
            key={revision.id}
            root={root}
            caseSlug={item.slug}
            revision={revision}
            previous={revisions[index + 1]}
            latest={index === 0}
            model={index === 0 ? glanceState.data : undefined}
            publicRead={publicRead}
          />
        ))}
      </ol>
      <span className="org-muted">Changed library versions are highlighted.</span>
    </section>
  );
}
