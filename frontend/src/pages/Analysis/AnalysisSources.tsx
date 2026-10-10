import { useState } from 'react';
import { CircleDashed } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { analysisApi, type ArchiveSource } from '../../analysis/archive';
import { Action } from '../../components/ui/Action';
import { Chip } from '../../components/ui/Chip';
import { EmptyState } from '../../components/ui/EmptyState';
import { Notice } from '../../components/ui/Notice';
import { ProjectPicker } from '../../components/ui/ProjectPicker';
import { Skeleton } from '../../components/ui/Skeleton';
import { formatDateTime } from '../../utils/format';
import { useResource } from '../../utils/useResource';
import { analysisProblem } from './analysisErrors';
import {
  groupSources, groupTitle, isFinished, searchOfSources, sourceName, targetOf, type GroupedSources, type SourceGroup,
} from './analysisModel';
import { AnalysisFrame, ProblemNotice } from './parts';
import { useStudyEvidence } from './useStudyEvidence';

const WORKSPACE = '/app/analysis/workspace';

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
const stateWord = (state: string) => state.charAt(0).toUpperCase() + state.slice(1);

interface RowProps {
  source: ArchiveSource;
  checked: boolean;
  /** Why the box can't be ticked now; absent when it can. */
  blocked?: string;
  chip?: string;
  /** Opening alone is always possible for a finished result. */
  onToggle?: (checked: boolean) => void;
}

function SourceRow({ source, checked, blocked, chip, onToggle }: RowProps) {
  const when = formatDateTime(source.createdAt);
  const notes = [source.diagnostic ? 'diagnostic evaluations' : '', source.legacy ? 'legacy, single run only' : ''].filter(Boolean);
  return (
    <li className={`an-source${checked ? ' is-on' : ''}${blocked ? ' is-blocked' : ''}`}>
      <label className="an-source-main">
        <input
          type="checkbox"
          checked={checked}
          disabled={Boolean(blocked) || !onToggle}
          onChange={(event) => onToggle?.(event.target.checked)}
        />
        <span className="an-source-text">
          <strong>{sourceName(source)}</strong>
          <small>{[when, stateWord(source.state), ...notes].filter(Boolean).join(' · ')}</small>
          {blocked && <small className="an-source-why">{blocked}</small>}
        </span>
      </label>
      {chip && <Chip tone="success">{chip}</Chip>}
      {isFinished(source) && <Action to={`${WORKSPACE}?job=${encodeURIComponent(source.id)}`} variant="secondary" size="sm" aria-label={`Open ${sourceName(source)} alone`}>Open alone</Action>}
    </li>
  );
}

function Groups({ grouped, chosen, toggle }: { grouped: GroupedSources; chosen: string[]; toggle: (id: string, checked: boolean) => void }) {
  const [why, setWhy] = useState(false);
  const owner = (id: string): string | undefined => grouped.groups.find((group) => group.sources.some((source) => source.id === id))?.key
    ?? (grouped.legacy.some((source) => source.id === id) ? `legacy:${id}` : undefined);
  const anchor = chosen.length ? owner(chosen[0]) : undefined;
  const blockedFor = (group: SourceGroup, source: ArchiveSource): string | undefined => {
    if (chosen.includes(source.id) || !anchor || anchor === group.key) return undefined;
    return 'Checked against a different model, so it can’t be ranked with the sources chosen.';
  };
  return (
    <>
      {grouped.groups.map((group) => (
        <section key={group.key} className="an-group" aria-label={groupTitle(group)}>
          <h2 className="an-eyebrow">{groupTitle(group)}</h2>
          <ul className="an-sources">
            {group.sources.map((source) => (
              <SourceRow
                key={source.id}
                source={source}
                checked={chosen.includes(source.id)}
                blocked={blockedFor(group, source)}
                chip={group.sources.length > 1 ? 'Can be combined' : undefined}
                onToggle={(checked) => toggle(source.id, checked)}
              />
            ))}
          </ul>
        </section>
      ))}

      {grouped.legacy.length > 0 && (
        <section className="an-group" aria-label="Can’t be combined">
          <h2 className="an-eyebrow">Can’t be combined</h2>
          <ul className="an-sources">
            {grouped.legacy.map((source) => (
              <SourceRow
                key={source.id}
                source={source}
                checked={chosen.includes(source.id)}
                blocked={chosen.length > 0 && !chosen.includes(source.id) ? 'Open it on its own.' : undefined}
                onToggle={(checked) => toggle(source.id, checked)}
              />
            ))}
          </ul>
          <div className="an-why">
            <Action variant="secondary" size="sm" aria-expanded={why} onClick={() => setWhy((open) => !open)}>Why?</Action>
            {why && (
              <Notice tone="info">
                These results are from before runs recorded which model and checker they used. They can still be opened on their own,
                but mixing them with checked results could compare different problems.
              </Notice>
            )}
          </div>
        </section>
      )}

      {grouped.unfinished.length > 0 && (
        <section className="an-group" aria-label="Not finished yet">
          <h2 className="an-eyebrow">Not finished yet</h2>
          <ul className="an-sources">
            {grouped.unfinished.map((source) => (
              <SourceRow key={source.id} source={source} checked={false} blocked="Analysis reads stored results. It opens once the run finishes." />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

/**
 * The sources of an analysis (`analysis-sources`, `/app/analysis`): the finished runs of the account, grouped by the model and checker they
 * share, since only results of one model can be ranked together. `?job=` (repeatable) and `?study=&run=&cell=` preselect.
 */
export function AnalysisSources() {
  const [params] = useSearchParams();
  const target = targetOf(params);
  const study = useStudyEvidence(target.study);
  const first = useResource('analysis-sources', () => analysisApi.sources());
  const [extra, setExtra] = useState<{ items: ArchiveSource[]; cursor: string | null } | null>(null);
  const [more, setMore] = useState<{ busy: boolean; error: unknown }>({ busy: false, error: null });
  const [picked, setPicked] = useState<string[] | null>(null);

  const items = [...(first.data?.items ?? []), ...(extra?.items ?? [])];
  const cursor = extra ? extra.cursor : first.data?.nextCursor ?? null;
  const grouped = groupSources(items);
  const chosen = picked ?? [...new Set([...target.jobs, ...study.jobs])];
  const problem = first.status === 'error' ? analysisProblem(first.error, 'list your results') : null;

  const toggle = (id: string, checked: boolean) => setPicked(checked ? [...chosen, id] : chosen.filter((value) => value !== id));
  const loadMore = async () => {
    if (!cursor) return;
    setMore({ busy: true, error: null });
    try {
      const page = await analysisApi.sources(cursor);
      setExtra((current) => ({ items: [...(current?.items ?? []), ...page.items], cursor: page.nextCursor }));
      setMore({ busy: false, error: null });
    } catch (caught) {
      setMore({ busy: false, error: caught });
    }
  };
  const retry = () => { setExtra(null); first.reload(); };

  const count = chosen.length;
  const none = first.status === 'ready' && items.length === 0;

  return (
    <AnalysisFrame trail={[{ label: 'Analysis' }]}>
      <header className="proj-title-row">
        <div className="proj-title">
          <h1>Analysis</h1>
          <p>Compare results you already have under the priorities you choose. Nothing here runs a solver again.</p>
        </div>
        <div className="proj-actions">
          {count > 0
            ? <Action to={`${WORKSPACE}?${searchOfSources(chosen)}`} variant="primary">Open decision space with {plural(count, 'source')}</Action>
            : <Action variant="primary" disabled>Open decision space with 0 sources</Action>}
        </div>
      </header>

      {study.status === 'ready' && <Notice tone="info">Preselected from the study: {study.label}.</Notice>}
      {study.status === 'error' && <ProblemNotice problem={analysisProblem(study.error, 'read the study evidence')} />}
      {problem && <ProblemNotice problem={problem} action={<Action variant="secondary" size="sm" onClick={retry}>Retry</Action>} />}
      {first.status === 'loading' && <div role="status" aria-busy="true"><span className="sr-only">Loading your results…</span><Skeleton variant="panel" /></div>}

      {none && (
        <EmptyState
          dashed
          icon={<CircleDashed />}
          title="Nothing to compare yet"
          action={<ProjectPicker label="Start a run" variant="primary" destination={(org, project) => `/app/${org}/${project}/jobs/new`} />}
        >
          Analysis works on finished runs you own. Run a case first.
        </EmptyState>
      )}

      {items.length > 0 && <Groups grouped={grouped} chosen={chosen} toggle={toggle} />}

      {more.error != null && <ProblemNotice problem={analysisProblem(more.error, 'list more results')} />}
      {cursor && (
        <div className="an-more"><Action variant="secondary" busy={more.busy} onClick={() => void loadMore()}>Load more runs</Action></div>
      )}

      {items.length > 0 && (
        <p className="an-hint">
          You can also arrive here preselected from a job, a project’s <Link to="/app/jobs">jobs</Link> or a study run.
        </p>
      )}
    </AnalysisFrame>
  );
}
