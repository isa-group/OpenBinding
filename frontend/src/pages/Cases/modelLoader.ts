import { problemsApi, type CompilationIr, type ProblemCompilation } from '../../api/problems';
import { readBindingProblem, type BindingModel } from './bindingModel';
import { classifyAuthError, type AuthFailure } from './caseErrors';

/** What reading the compilation of a revision gave: a model, or a failure that belongs to that part only. */
export type ModelState =
  | { state: 'ready'; compilation: ProblemCompilation; ir: CompilationIr; model: BindingModel | null }
  | { state: 'failed'; failure: AuthFailure };

/** The compilation of a revision by the installed toolchain and its IR, read as a binding model. */
export async function loadModel(org: string, problem: string, revision: number | string): Promise<ModelState> {
  try {
    const compilation = await problemsApi.compilation(org, problem, revision);
    const ir = await problemsApi.ir(org, problem, revision, compilation.id);
    return { state: 'ready', compilation, ir, model: readBindingProblem(ir.ir) };
  } catch (caught) {
    return { state: 'failed', failure: classifyAuthError(caught) };
  }
}

/** The key a screen caches the model of a revision under. */
export const modelKey = (org: string, problem: string, revision: { id: string }): string => `model:${org}/${problem}/${revision.id}`;
