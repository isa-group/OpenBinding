// Adapted from SPHERE frontend/src/modules/pricing/components/configuration-space-view/index.tsx (feat/pricing-renderer,
// revision 694f292b03), https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the frame only (the count chips, a search and a task select over a bordered explorer), around OpenBinding's
// candidate matrix of a problem version: the candidates each task can take, with their values and where the package writes
// each one. `?composition=<slug>&compositionVersion=<ref>` highlights what that composition version chose (its current
// evaluation's `binding`), read on the compilation its values were evaluated on, with a link back to it; the notices say
// when there is nothing to highlight. No focused configuration, Quick Browse or compare tray: a problem's candidates are not
// configurations.

import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { ProblemRevision } from '../../api/problemsApi';
import { Action } from '../../../core/components/action-button';
import { CandidateMatrix } from '../../../core/components/candidate-matrix/CandidateMatrix';
import { Notice } from '../../../core/components/notice';
import { Skeleton } from '../../../core/components/skeleton';
import { classifyAuthError, marker } from '../../../core/api/errors';
import type { CompositionVersionView, ProblemFacts } from '../../../core/api/types';
import {
  candidateMatrix,
  type CandidateMatrix as Matrix,
} from '../../../core/utils/binding/candidateMatrix';
import { compositionsApi } from '../../../core/utils/composition/api';
import { factsSource } from '../../../core/utils/composition/factsSource';
import { bindingSelection } from '../../../core/utils/composition/viewModel';
import { problemFactsApi } from '../../../core/utils/problem/facts';
import { compositionPath } from '../../../../routes/paths/compositions';
import { problemPath } from '../../../../routes/paths/problems';
import { useResource, type Resource } from '../../../core/hooks/useResource';
import type { ProblemContent } from '../../types';
import type { ModelState } from '../../utils/modelLoader';
import { powerText } from '../../utils/problemsModel';

/** The composition version the address asks to highlight, as read: its composition's name, the version and its problem's facts. */
interface Highlight {
  name: string;
  version: CompositionVersionView;
  /** The facts of the compilation its values were evaluated on (the candidates it chose among); null when it names none. */
  facts: ProblemFacts | null;
}

/** Which problem version a composition version links, when it links this problem. */
function linkedRevision(
  version: CompositionVersionView,
  problem: { id: string; slug: string }
): number | null {
  const link = version.problem;
  if (!link || (link.problem.id !== problem.id && link.problem.slug !== problem.slug)) return null;
  return link.revision.revision;
}

/** The matrix narrowed to one task and to the candidates whose written name or provider holds the search. */
function narrowed(matrix: Matrix, task: string, search: string): Matrix {
  const needle = search.trim().toLowerCase();
  return {
    ...matrix,
    rows: matrix.rows
      .filter(row => !task || row.task === task)
      .map(row => ({
        ...row,
        candidates: needle
          ? row.candidates.filter(candidate =>
              `${candidate.written} ${candidate.provider ?? ''}`.toLowerCase().includes(needle)
            )
          : row.candidates,
      }))
      .filter(row => !needle || row.kind === 'local' || row.candidates.length > 0),
  };
}

export default function CandidatesExplorer({
  org,
  content,
  revision,
  model,
}: {
  org: string;
  content: ProblemContent;
  revision: ProblemRevision;
  model: Resource<ModelState | null>;
}) {
  const [query] = useSearchParams();
  const { item } = content;
  const [search, setSearch] = useState('');
  const [task, setTask] = useState('');
  const slug = query.get('composition') ?? '';
  const ref = query.get('compositionVersion') ?? '';
  const asked = slug !== '' && ref !== '';
  const highlight = useResource<Highlight | null>(
    `problem-highlight:${org}/${item.slug}@${revision.revision}/${asked ? `${slug}@${ref}` : 'none'}`,
    async () => {
      if (!asked) return null;
      const [composition, version] = await Promise.all([
        compositionsApi.get(org, slug),
        compositionsApi.version(org, slug, ref),
      ]);
      // The candidates it chose among: read only when it chose them on the version shown.
      const source =
        linkedRevision(version, item) === revision.revision ? factsSource(version) : null;
      const facts = source
        ? await problemFactsApi.get(org, source.problem, source.revision, source.compilation)
        : null;
      return { name: composition.value.name, version, facts };
    }
  );

  const own = model.data?.state === 'ready' ? model.data.facts : null;
  const shown = highlight.data ?? null;
  const linked = shown ? linkedRevision(shown.version, item) : null;
  const selection = useMemo(
    () => (shown && linked === revision.revision ? bindingSelection(shown.version) : {}),
    [shown, linked, revision.revision]
  );
  const highlighting = Object.keys(selection).length > 0;
  const facts = highlighting ? (shown?.facts ?? own) : own;
  const matrix = useMemo(
    () => (facts ? candidateMatrix(facts, { selection }) : null),
    [facts, selection]
  );
  const visible = useMemo(
    () => (matrix ? narrowed(matrix, task, search) : null),
    [matrix, task, search]
  );
  const plain = problemPath(org, item.slug, 'candidates', { version: revision.revision });
  const highlightFailure = highlight.status === 'error' ? classifyAuthError(highlight.error) : null;
  const services = matrix?.rows.filter(row => row.kind === 'service') ?? [];
  const candidateCount = new Set(services.flatMap(row => row.candidates.map(entry => entry.key)))
    .size;

  return (
    <section className="flex flex-col gap-4" aria-labelledby="pc-title">
      <div className="min-w-0 rounded-xl border border-tp-hairline bg-tp-canvas p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 id="pc-title" className="text-lg font-semibold text-tp-ink">
              Candidates
            </h2>
            <p className="text-xs text-tp-steel">
              The candidates each task of version {revision.revision} can take, with the values the
              package writes for them and where it writes each one.
            </p>
          </div>
          {matrix && (
            <div className="flex items-center gap-2 text-[11px] text-tp-steel">
              <span className="rounded-full bg-tp-surface px-2 py-0.5">
                {services.length} {services.length === 1 ? 'task' : 'tasks'}
              </span>
              <span className="rounded-full bg-tp-surface px-2 py-0.5">
                {candidateCount} {candidateCount === 1 ? 'candidate' : 'candidates'}
              </span>
              {facts?.binding_space && (
                <span className="rounded-full bg-tp-primary/10 px-2 py-0.5 text-tp-accent">
                  ≈ {powerText(facts.binding_space)} combinations
                </span>
              )}
            </div>
          )}
        </div>

        {matrix && (
          <div className="mt-4 grid gap-3 md:grid-cols-[1fr_200px]">
            <label className="rounded-lg border border-tp-hairline-strong bg-tp-canvas p-3">
              <span className="mb-1 block text-[10px] font-medium tracking-wider text-tp-steel uppercase">
                Search
              </span>
              <input
                type="search"
                value={search}
                onChange={event => setSearch(event.target.value)}
                placeholder="A candidate or a provider…"
                className="w-full bg-transparent text-sm text-tp-ink placeholder-tp-muted outline-none"
              />
            </label>
            <label className="rounded-lg border border-tp-hairline-strong bg-tp-canvas p-3">
              <span className="mb-1 block text-[10px] font-medium tracking-wider text-tp-steel uppercase">
                Task
              </span>
              <select
                value={task}
                onChange={event => setTask(event.target.value)}
                className="w-full cursor-pointer bg-transparent text-sm text-tp-ink outline-none"
              >
                <option value="">Every task</option>
                {matrix.rows.map(row => (
                  <option key={row.task} value={row.task}>
                    {row.task}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        <div className="mt-4 flex flex-col gap-3">
          {asked && highlight.status === 'loading' && (
            <p className="text-xs text-tp-steel" role="status">
              Loading the composition version to highlight…
            </p>
          )}
          {highlightFailure && (
            <Notice
              tone="error"
              action={
                <Action to={plain} variant="secondary" size="sm">
                  Show without it
                </Action>
              }
            >
              {`The composition version ${ref} of ${slug} couldn’t be loaded${marker(highlightFailure)}.`}
            </Notice>
          )}
          {shown && linked === null && (
            <Notice
              tone="info"
              action={
                <Action to={plain} variant="secondary" size="sm">
                  Show without it
                </Action>
              }
            >
              {`${shown.name} ${shown.version.label} links no version of this problem, so it has nothing to highlight here.`}
            </Notice>
          )}
          {shown && linked !== null && linked !== revision.revision && (
            <Notice
              tone="info"
              action={
                <Action
                  to={problemPath(org, item.slug, 'candidates', {
                    version: linked,
                    composition: slug,
                    compositionVersion: ref,
                  })}
                  variant="secondary"
                  size="sm"
                >
                  Open version {linked}
                </Action>
              }
            >
              {`${shown.name} ${shown.version.label} chose its candidates on version ${linked} of this problem.`}
            </Notice>
          )}
          {shown && linked === revision.revision && !highlighting && (
            <Notice tone="info">{`${shown.name} ${shown.version.label} has no evaluated binding to highlight.`}</Notice>
          )}
          {shown && highlighting && (
            <Notice
              tone="info"
              action={
                <Link
                  to={compositionPath(org, slug, undefined, { version: shown.version.label })}
                  className="cursor-pointer text-xs font-medium underline"
                >
                  Back to {shown.name} {shown.version.label}
                </Link>
              }
            >
              The candidates{' '}
              <strong>
                {shown.name} {shown.version.label}
              </strong>{' '}
              chose are selected, read on the compilation its values were evaluated on.
            </Notice>
          )}

          {model.status === 'loading' && (
            <div role="status" aria-busy="true">
              <span className="sr-only">Reading the compiled form…</span>
              <Skeleton variant="panel" />
            </div>
          )}
          {model.data?.state === 'failed' && (
            <Notice
              tone="warning"
              action={
                <Action variant="secondary" size="sm" onClick={model.reload}>
                  Retry
                </Action>
              }
            >
              The compiled form couldn’t be read{marker(model.data.failure)}.
            </Notice>
          )}
          {visible && (!asked || highlight.status !== 'loading') && (
            <>
              {visible.rows.length === 0 ? (
                <p className="rounded-lg border border-dashed border-tp-hairline-strong p-6 text-center text-xs text-tp-steel">
                  No candidate matches “{search.trim()}”.
                </p>
              ) : (
                <CandidateMatrix matrix={visible} mode="view" label="Candidates of each task" />
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
