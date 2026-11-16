import type { ValueOrigin } from '../../utils/binding/candidateMatrix';

/** Where a value is written, in words: `written in candidates.json at /spec/candidates/c1/features/cost`. */
export function originText(origin: ValueOrigin): string {
  return `written in ${origin.path} at ${origin.pointer}`;
}
