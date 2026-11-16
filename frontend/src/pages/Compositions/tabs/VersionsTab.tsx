// Design follows SPHERE frontend/src/modules/pricing/components/pricing-versions-tab/index.tsx (revision 73779a8a); no code copied
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { problemsApi } from '../../../api/problems';
import { saveText } from '../../../components/rendering/download';
import { Action } from '../../../modules/core/components/action-button';
import { Badge } from '../../../modules/core/components/badge';
import { DataTable } from '../../../modules/core/components/data-table';
import { FilterPills } from '../../../modules/core/components/filter-pills';
import { useCopy } from '../../../modules/core/hooks/useCopy';
import { compositionsApi } from '../../../entities/composition/api';
import { formatValue, valueModels, valueStatus } from '../../../entities/composition/values';
import { pickVersion } from '../../../entities/composition/versionRef';
import { compositionViewModel } from '../../../entities/composition/viewModel';
import { problemFactsApi } from '../../../entities/problem/facts';
import { problemPath } from '../../../routes/paths/problems';
import { runPath } from '../../../routes/paths/runs';
import {
  compositionPath,
  showcasePath,
  type CompositionQuery,
  type VersionsView,
} from '../../../routes/paths/compositions';
import { classifyAuthError, marker, readApiError } from '../../../modules/core/api/errors';
import type {
  CompositionVersionDiff,
  CompositionVersionView,
  CompositionView,
  ProblemFacts,
} from '../../../modules/core/api/types';
import { formatDate } from '../../../utils/format';
import { useResource, type Resource } from '../../../utils/useResource';
import { ChangeSummary } from '../../../widgets/change-summary/ChangeSummary';
import { useVersionChanges } from '../../../widgets/change-summary/useVersionChanges';
import { CompositionRenderer } from '../../../widgets/composition-renderer/CompositionRenderer';
import type { Loaded } from '../../../widgets/composition-renderer/modes/comparison/comparisonModel';
import type { Texts } from '../../../widgets/composition-renderer/modes/comparison/Comparison';
import { EvolutionCharts } from '../../../widgets/evolution-charts/EvolutionCharts';
import { ValueBadge } from '../../../widgets/value-badge/ValueBadge';
import { factsSource } from '../../../entities/composition/factsSource';

type View = VersionsView;

const VIEWS: ReadonlyArray<{ id: View; label: string }> = [
  { id: 'table', label: 'Table' },
  { id: 'compare', label: 'Compare' },
  { id: 'file', label: 'File' },
  { id: 'evolution', label: 'Evolution' },
];

const viewOf = (value: string | null): View =>
  value === 'compare' || value === 'file' || value === 'evolution' ? value : 'table';

/** The views that show a pair of versions. */
const pairView = (view: View): view is 'compare' | 'file' => view === 'compare' || view === 'file';

const shortId = (id: string) => id.slice(0, 8);

const OUTCOME_NOTE: Partial<
  Record<NonNullable<CompositionVersionView['current_evaluation']>['outcome'], string>
> = {
  binding_invalid: 'binding invalid for its problem',
  semantics_changed: 'its problem changed meaning',
};

/**
 * The pair the comparison shows: `?to=` (the latest by default) and `?from=` (the version before it by default; an unknown one
 * falls back to that too). None while the composition has fewer than two versions.
 */
function pairOf(
  versions: readonly CompositionVersionView[],
  from: string | null,
  to: string | null
) {
  if (versions.length < 2) return null;
  const later = pickVersion(versions, to) ?? versions[0];
  const index = versions.indexOf(later);
  const before = versions[index + 1] ?? versions[index - 1];
  const earlier =
    pickVersion([before, ...versions.filter(version => version !== before)], from) ?? before;
  return { from: earlier, to: later };
}

/** A read of the gateway as the comparison mode takes it, with the refusal worded and a retry. */
function loaded<T>(resource: Resource<T | null>, what: string): Loaded<T> {
  if (resource.status === 'error')
    return {
      status: 'error',
      message: `${what} couldn’t be read${marker(classifyAuthError(resource.error))}.`,
      retry: resource.reload,
    };
  if (resource.status === 'loading' || resource.data === undefined || resource.data === null)
    return { status: 'loading' };
  return { status: 'ready', value: resource.data };
}

const currentBinding = (version: CompositionVersionView): Record<string, string> | null =>
  version.evaluations.find(evaluation => evaluation.current)?.binding ?? null;

/** The problem revision a linked version is judged against, when the gateway named it to this reader. */
const revisionKey = (version: CompositionVersionView) =>
  version.problem && version.problem.problem.id !== null
    ? `${version.problem.problem.slug}@${version.problem.revision.revision}`
    : null;

function Lineage({ org, version }: { org: string; version: CompositionVersionView }) {
  const forked = version.forked_from;
  const derivation = version.derivation;
  if (!forked && !derivation) return <span className="cmp-muted">—</span>;
  return (
    <ul className="cmv-lines">
      {forked && (
        <li>
          {forked.name || forked.slug
            ? `Forked from ${forked.name ?? forked.slug}${forked.label ? ` (${forked.label})` : ''}${forked.organization ? ` in ${forked.organization.displayName}` : ''}`
            : 'Forked from a composition that is not shared with you'}
        </li>
      )}
      {derivation?.source === 'run' && derivation.run && (
        <li>
          Derived from{' '}
          <Link to={runPath(org, derivation.run.id)}>run {shortId(derivation.run.id)}</Link>
          {derivation.point !== null ? `, point ${derivation.point}` : ''}
        </li>
      )}
      {derivation?.source === 'binding' && (
        <li>{`Derived from a binding of problem version ${derivation.revision.revision}`}</li>
      )}
    </ul>
  );
}

interface RowProps {
  org: string;
  composition: CompositionView;
  version: CompositionVersionView;
  previous: CompositionVersionView | undefined;
  latest: boolean;
  shown: boolean;
  /** The versions as last read: a new reading starts a new cache of change summaries. */
  snapshot: object;
  canReevaluate: boolean;
  onCompare: (from: CompositionVersionView, to: CompositionVersionView) => void;
  onReevaluated: (message: string) => void;
}

function VersionRow({
  org,
  composition,
  version,
  previous,
  latest,
  shown,
  snapshot,
  canReevaluate,
  onCompare,
  onReevaluated,
}: RowProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'download' | 'reevaluate' | null>(null);
  const [failure, setFailure] = useState('');
  const { copy, status } = useCopy();
  const changes = useVersionChanges(
    open && previous
      ? {
          org,
          composition: composition.slug,
          key: version.id,
          before: previous.id,
          after: version.id,
        }
      : null,
    snapshot
  );
  const values = valueModels(version);
  const outcome = version.current_evaluation?.outcome;
  const link = version.problem;
  const sealed = formatDate(version.created_at) ?? '—';

  const download = async () => {
    setBusy('download');
    setFailure('');
    try {
      saveText(
        await compositionsApi.content(org, composition.slug, version.id),
        `${composition.slug}-${version.label}.yaml`,
        'application/yaml'
      );
    } catch (caught) {
      setFailure(
        `The text of ${version.label} couldn’t be downloaded: ${readApiError(caught).message}`
      );
    } finally {
      setBusy(null);
    }
  };

  const reevaluate = async () => {
    setBusy('reevaluate');
    setFailure('');
    try {
      const { created, evaluation } = await compositionsApi.reevaluate(
        org,
        composition.slug,
        version.id
      );
      onReevaluated(
        created
          ? `Version ${version.label} re-evaluated with the installed toolchain: ${evaluation.outcome.replace('_', ' ')}.`
          : `Version ${version.label} was already evaluated with the installed toolchain.`
      );
    } catch (caught) {
      setFailure(
        `Version ${version.label} couldn’t be re-evaluated: ${readApiError(caught).message}`
      );
    } finally {
      setBusy(null);
    }
  };

  const href =
    composition.visibility === 'public'
      ? showcasePath(composition.organization.slug, composition.slug, { version: version.label })
      : compositionPath(org, composition.slug, undefined, { version: version.label });

  return (
    <tr
      className={shown ? 'cmv-row is-shown' : 'cmv-row'}
      aria-current={shown ? 'true' : undefined}
    >
      <th scope="row" data-label="Version">
        <span className="cmv-label">
          <code>{version.label}</code>
          {latest && <Badge variant="info">Latest</Badge>}
          {shown && <span className="sr-only">(shown above)</span>}
        </span>
        <span className="cmv-ordinal">Version #{version.ordinal}</span>
      </th>
      <td data-label="Sealed">
        <time dateTime={version.created_at}>{sealed}</time>
      </td>
      <td data-label="Values">
        {values.length === 0 ? (
          <span className="cmp-muted">No values</span>
        ) : (
          <ul className="cmv-values">
            {values.map(value => (
              <li key={value.name}>
                <span>{value.name}</span> {formatValue(value.value, value.unit)}
              </li>
            ))}
          </ul>
        )}
      </td>
      <td data-label="Status">
        <ValueBadge status={valueStatus(version)} />
        {outcome && OUTCOME_NOTE[outcome] && (
          <span className="cmv-note">{OUTCOME_NOTE[outcome]}</span>
        )}
      </td>
      <td data-label="Problem">
        {!link ? (
          <span className="cmp-muted">None (declared)</span>
        ) : link.problem.id !== null ? (
          <Link
            to={problemPath(org, link.problem.slug, undefined, { version: link.revision.revision })}
          >{`${link.problem.slug}@${link.revision.revision}`}</Link>
        ) : (
          <code>{`${link.problem.slug}@${link.revision.revision}`}</code>
        )}
      </td>
      <td data-label="Lineage">
        <Lineage org={org} version={version} />
      </td>
      <td data-label="Changes" className="cmv-changes">
        {previous ? (
          <>
            <button
              type="button"
              className="cmv-toggle"
              aria-expanded={open}
              onClick={() => setOpen(current => !current)}
            >
              {open ? 'Hide changes' : `Changes since ${previous.label}`}
            </button>
            {open && <ChangeSummary state={changes} />}
          </>
        ) : (
          <span className="cmp-muted">First version</span>
        )}
      </td>
      <td data-label="Actions">
        <div className="cmv-actions">
          {previous && (
            <Action size="sm" variant="ghost" onClick={() => onCompare(previous, version)}>
              Compare with previous
            </Action>
          )}
          <Action
            size="sm"
            variant="ghost"
            to={compositionPath(org, composition.slug, 'editor', { version: version.label })}
          >
            Open in editor
          </Action>
          <Action
            size="sm"
            variant="ghost"
            busy={busy === 'download'}
            onClick={() => void download()}
          >
            Download YAML
          </Action>
          <Action
            size="sm"
            variant="ghost"
            onClick={() => void copy(`${window.location.origin}${href}`, version.id)}
          >
            {status(version.id) === 'copied'
              ? 'Link copied'
              : status(version.id) === 'failed'
                ? 'Copy failed'
                : 'Copy link'}
          </Action>
          {canReevaluate && (
            <Action
              size="sm"
              variant="secondary"
              busy={busy === 'reevaluate'}
              onClick={() => void reevaluate()}
            >
              Re-evaluate
            </Action>
          )}
        </div>
        {failure && (
          <p className="cmv-failure" role="alert">
            {failure}
          </p>
        )}
      </td>
    </tr>
  );
}

interface VersionsTabProps {
  org: string;
  composition: CompositionView;
  /** Light rows, newest first. */
  versions: CompositionVersionView[];
  /** The version the page header shows. */
  shown: string | null;
  /** Seal and re-evaluate: MEMBER. */
  canCreate: boolean;
  /** The composition and its versions must be read again (a re-evaluation changed a current evaluation). */
  onChanged: () => void;
}

/**
 * Versions: every sealed version, newest first, with its values and their status, the problem it links, where it comes from and
 * what it changed (`view=table`); the gateway's comparison of two of them (`view=compare`, `?from=&to=`); or their texts line by
 * line (`view=file`); or how its structure and values evolved, version by version (`view=evolution`). Versions are immutable and
 * referenced, so there is no per-version visibility and no delete.
 */
export function VersionsTab({
  org,
  composition,
  versions,
  shown,
  canCreate,
  onChanged,
}: VersionsTabProps) {
  const navigate = useNavigate();
  const [query] = useSearchParams();
  const [message, setMessage] = useState('');
  const view = viewOf(query.get('view'));
  const slug = composition.slug;
  const pair = pairView(view) ? pairOf(versions, query.get('from'), query.get('to')) : null;
  const pairKey = pair ? `${org}/${slug}/${pair.from.id}..${pair.to.id}` : 'none';

  const go = (next: CompositionQuery) =>
    void navigate(
      compositionPath(org, slug, 'versions', {
        version: query.get('version') ?? undefined,
        ...next,
      }),
      { viewTransition: true }
    );
  const labelOf = (id: string) => versions.find(version => version.id === id)?.label;

  // Which compilation the installed toolchain made of each linked problem revision: a version evaluated on another one can be
  // evaluated again. Only a MEMBER may, so only a MEMBER asks.
  const revisions =
    canCreate && view === 'table'
      ? [
          ...new Map(
            versions.flatMap(version => {
              const key = revisionKey(version);
              return key && version.problem
                ? [
                    [
                      key,
                      {
                        problem: version.problem.problem.slug,
                        revision: version.problem.revision.revision,
                      },
                    ] as const,
                  ]
                : [];
            })
          ).entries(),
        ]
      : [];
  const installed = useResource<Map<string, string | null>>(
    `composition-installed:${org}/${revisions.map(([key]) => key).join(',') || 'none'}`,
    async () =>
      new Map(
        await Promise.all(
          revisions.map(async ([key, { problem, revision }]): Promise<[string, string | null]> => {
            const detail = await problemsApi.revision(org, problem, revision).catch(() => null);
            return [
              key,
              detail
                ? (detail.compilations.find(compilation => compilation.current)
                    ?.compilation_digest ?? '')
                : null,
            ];
          })
        )
      )
  );
  const needsEvaluation = (version: CompositionVersionView) => {
    const key = revisionKey(version);
    const digest = key ? installed.data?.get(key) : null;
    // null: the revision could not be read, so nobody can tell; '': the installed toolchain has not compiled it yet.
    return (
      canCreate &&
      digest !== null &&
      digest !== undefined &&
      version.current_evaluation?.compilation?.compilation_digest !== digest
    );
  };

  const diff = useResource<CompositionVersionDiff | null>(
    `composition-diff:${view === 'compare' ? pairKey : 'none'}`,
    async () =>
      pair && view === 'compare' ? compositionsApi.diff(org, slug, pair.from.id, pair.to.id) : null
  );
  const files = useResource<Texts | null>(
    `composition-texts:${view === 'file' ? pairKey : 'none'}`,
    async () => {
      if (!pair || view !== 'file') return null;
      const [before, after] = await Promise.all([
        compositionsApi.content(org, slug, pair.from.id),
        compositionsApi.content(org, slug, pair.to.id),
      ]);
      return { before, after };
    }
  );
  const documents = useResource<[CompositionVersionView, CompositionVersionView] | null>(
    `composition-pair:${view === 'compare' ? pairKey : 'none'}`,
    async () =>
      pair && view === 'compare'
        ? Promise.all([
            compositionsApi.version(org, slug, pair.from.id, { document: true }),
            compositionsApi.version(org, slug, pair.to.id, { document: true }),
          ])
        : null
  );
  const later = documents.data?.[1] ?? null;
  const source = factsSource(later);
  const facts = useResource<ProblemFacts | null>(
    `composition-facts:${org}/${source ? `${source.problem}@${source.revision}/${source.compilation}` : 'none'}`,
    async () =>
      source
        ? problemFactsApi
            .get(org, source.problem, source.revision, source.compilation)
            .catch(() => null)
        : null
  );
  const model = compositionViewModel({
    composition,
    version: later,
    facts: facts.data ?? null,
    reader: 'member',
  });
  const pairDocuments = loaded(documents, 'The two versions');
  const beforeSelection: Loaded<Readonly<Record<string, string>> | null> =
    pairDocuments.status === 'error'
      ? pairDocuments
      : documents.data && (!source || facts.status !== 'loading')
        ? { status: 'ready', value: currentBinding(documents.data[0]) }
        : { status: 'loading' };

  return (
    <div className="cmv">
      <div className="cmv-bar">
        <FilterPills
          options={VIEWS}
          value={view}
          onChange={id => {
            const next = id as View;
            const keep = pair && pairView(next);
            go({
              view: next === 'table' ? undefined : next,
              from: keep ? labelOf(pair.from.id) : undefined,
              to: keep ? labelOf(pair.to.id) : undefined,
            });
          }}
          ariaLabel="Versions view"
        />
        {message && (
          <p className="cmv-message" role="status">
            {message}
          </p>
        )}
      </div>

      {view === 'table' &&
        (versions.length === 0 ? (
          <p className="cmp-muted">No version yet. Seal the first one in the Editor.</p>
        ) : (
          <DataTable
            label={`Versions of ${composition.name}`}
            minWidth={0}
            caption={<>Newest first. A sealed version never changes.</>}
          >
            <thead>
              <tr>
                <th scope="col">Version</th>
                <th scope="col">Sealed</th>
                <th scope="col">Values</th>
                <th scope="col">Status</th>
                <th scope="col">Problem</th>
                <th scope="col">Lineage</th>
                <th scope="col">Changes</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="cmv-table">
              {versions.map((version, index) => (
                <VersionRow
                  key={version.id}
                  org={org}
                  composition={composition}
                  version={version}
                  previous={versions[index + 1]}
                  latest={index === 0}
                  shown={version.id === shown}
                  snapshot={versions}
                  canReevaluate={needsEvaluation(version)}
                  onCompare={(from, to) => go({ view: 'compare', from: from.label, to: to.label })}
                  onReevaluated={text => {
                    setMessage(text);
                    onChanged();
                  }}
                />
              ))}
            </tbody>
          </DataTable>
        ))}

      {view === 'evolution' && (
        <EvolutionCharts
          org={org}
          composition={slug}
          refresh={versions.map(version => version.id).join(',')}
        />
      )}

      {pairView(view) && !pair && (
        <p className="cmp-muted">
          This composition has fewer than two versions: there is nothing to compare yet.
        </p>
      )}
      {pairView(view) && pair && (
        <CompositionRenderer
          model={model}
          mode="comparison"
          comparison={{
            versions: versions.map(version => ({ id: version.id, label: version.label })),
            from: pair.from.id,
            to: pair.to.id,
            onPair: (from, to) => go({ view, from: labelOf(from), to: labelOf(to) }),
            view,
            diff: loaded(diff, 'What changed between the two versions'),
            files: view === 'file' ? loaded(files, 'The texts of the two versions') : null,
            beforeSelection: view === 'compare' ? beforeSelection : null,
          }}
        />
      )}
    </div>
  );
}
