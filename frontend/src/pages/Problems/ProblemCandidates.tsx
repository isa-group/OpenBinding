import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { Organization } from '../../api/platform';
import type { ProblemRevision as Revision } from '../../api/problems';
import { Action } from '../../modules/core/components/action-button';
import { Notice } from '../../modules/core/components/notice';
import { Skeleton } from '../../modules/core/components/skeleton';
import { candidateMatrix } from '../../modules/core/utils/binding/candidateMatrix';
import { compositionsApi } from '../../modules/core/utils/composition/api';
import { factsSource } from '../../modules/core/utils/composition/factsSource';
import { bindingSelection } from '../../modules/core/utils/composition/viewModel';
import { problemFactsApi } from '../../modules/core/utils/problem/facts';
import { compositionPath } from '../../routes/paths/compositions';
import { problemPath } from '../../routes/paths/problems';
import { classifyAuthError, marker } from '../../modules/core/api/errors';
import type { CompositionVersionView, ProblemFacts } from '../../modules/core/api/types';
import { useResource } from '../../utils/useResource';
import { CandidateMatrix } from '../../modules/core/components/candidate-matrix/CandidateMatrix';
import { loadModel, modelKey, type ModelState } from './modelLoader';
import type { RouteProblemContent } from './useRouteProblem';

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

/**
 * Candidates: the candidates each task of the problem version can take, with their values and where the package writes each one
 * (the candidate matrix on the facts of the version's compilation). `?composition=<slug>&compositionVersion=<ref>` highlights the
 * candidates that composition version chose (its current evaluation's `binding`), read on the compilation its values were
 * evaluated on, with a link back to it.
 */
export function VersionCandidates({
  organization,
  content,
  revision,
}: {
  organization: Organization;
  content: RouteProblemContent;
  revision: Revision;
}) {
  const [query] = useSearchParams();
  const { item } = content;
  const org = organization.slug;
  const slug = query.get('composition') ?? '';
  const ref = query.get('compositionVersion') ?? '';
  const asked = slug !== '' && ref !== '';
  const modelState = useResource<ModelState>(modelKey(org, item.slug, revision), () =>
    loadModel(org, item.slug, revision.revision)
  );
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

  const own = modelState.data?.state === 'ready' ? modelState.data.facts : null;
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
  const plain = problemPath(org, item.slug, 'candidates', { version: revision.revision });
  const highlightFailure = highlight.status === 'error' ? classifyAuthError(highlight.error) : null;

  return (
    <section className="org-section" aria-labelledby="pc-title">
      <h2 id="pc-title">Candidates</h2>
      <p className="org-muted">
        The candidates each task of version {revision.revision} can take, with the values the
        package writes for them and where it writes each one.
      </p>

      {asked && highlight.status === 'loading' && (
        <p className="org-muted" role="status">
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
        <div className="proj-note is-info case-highlight" role="note">
          <span>
            The candidates{' '}
            <strong>
              {shown.name} {shown.version.label}
            </strong>{' '}
            chose are selected, read on the compilation its values were evaluated on.
          </span>
          <Link
            to={compositionPath(org, slug, undefined, { version: shown.version.label })}
            viewTransition
          >
            Back to {shown.name} {shown.version.label}
          </Link>
        </div>
      )}

      {modelState.status === 'loading' && (
        <div role="status" aria-busy="true">
          <span className="sr-only">Reading the compiled form…</span>
          <Skeleton variant="panel" />
        </div>
      )}
      {modelState.data?.state === 'failed' && (
        <Notice
          tone="warning"
          action={
            <Action variant="secondary" size="sm" onClick={modelState.reload}>
              Retry
            </Action>
          }
        >
          The compiled form couldn’t be read{marker(modelState.data.failure)}.
        </Notice>
      )}
      {matrix && (!asked || highlight.status !== 'loading') && (
        <div className="proj-panel">
          <CandidateMatrix matrix={matrix} mode="view" label="Candidates of each task" />
        </div>
      )}
    </section>
  );
}
