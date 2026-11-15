import { problemsApi, type ProblemCompilation } from '../../api/problems';
import { problemFactsApi } from '../../entities/problem/facts';
import type { ProblemFacts } from '../../shared/api/types';
import { classifyAuthError, type AuthFailure } from '../../shared/api/errors';

/** What reading the compilation of a revision gave: the compilation and its facts, or a failure that belongs to that part only. */
export type ModelState =
  | { state: 'ready'; compilation: ProblemCompilation; facts: ProblemFacts }
  | { state: 'failed'; failure: AuthFailure };

/** The compilation of a revision by the installed toolchain and its facts (what the workflow graph and the candidate matrix read). */
export async function loadModel(org: string, problem: string, revision: number | string): Promise<ModelState> {
  try {
    const compilation = await problemsApi.compilation(org, problem, revision);
    const facts = await problemFactsApi.get(org, problem, revision, compilation.id);
    return { state: 'ready', compilation, facts };
  } catch (caught) {
    return { state: 'failed', failure: classifyAuthError(caught) };
  }
}

/** The key a screen caches the model of a revision under. */
export const modelKey = (org: string, problem: string, revision: { id: string }): string => `model:${org}/${problem}/${revision.id}`;
