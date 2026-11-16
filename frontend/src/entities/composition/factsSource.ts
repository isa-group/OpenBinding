import type { CompositionVersionView } from '../../shared/api/types';

export interface FactsSource {
  problem: string;
  revision: number;
  /** The compilation the current evaluation used (its id, else its digest): the values shown were evaluated on it. */
  compilation: string;
}

/**
 * Where the candidates of the shown version's problem are read: the facts of the compilation its values were evaluated on, not
 * of the one it links, so values and candidates never mix two compilations. None for a declared version, or when the gateway
 * did not name the problem (the reader may not read it).
 */
export function factsSource(version: CompositionVersionView | null): FactsSource | null {
  const link = version?.problem;
  if (!version || !link || link.problem.id === null) return null;
  const evaluation = version.evaluations.find(item => item.current) ?? null;
  const compilation =
    evaluation?.compilation?.id ??
    version.current_evaluation?.compilation?.compilation_digest ??
    null;
  return compilation
    ? { problem: link.problem.slug, revision: link.revision.revision, compilation }
    : null;
}
