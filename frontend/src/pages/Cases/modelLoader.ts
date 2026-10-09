import { platformApi } from '../../api/platform';
import type { Snapshot } from '../../api/platform';
import { readBindingProblem, type BindingModel } from './bindingModel';
import { classifyAuthError, type AuthFailure } from './caseErrors';

/** What reading the compiled snapshot of a revision gave: nothing to read, a model, or a failure that belongs to that part only. */
export type ModelState =
  | { state: 'none' }
  | { state: 'ready'; snapshot: Snapshot; model: BindingModel | null }
  | { state: 'failed'; failure: AuthFailure };

export async function loadModel(snapshotId: string | null): Promise<ModelState> {
  if (!snapshotId) return { state: 'none' };
  try {
    const snapshot = await platformApi.snapshot(snapshotId);
    return { state: 'ready', snapshot, model: snapshot.ir ? readBindingProblem(snapshot.ir.document) : null };
  } catch (caught) {
    return { state: 'failed', failure: classifyAuthError(caught) };
  }
}
