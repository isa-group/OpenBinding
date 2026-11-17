import { HttpError } from '../../core/api/http';
import { diagnosticsByField, diagnosticsOf } from '../../core/api/problem';

export type FieldErrors = Partial<Record<string, string>>;

/** Per-field messages out of a 422's diagnostics (`pointer: '/email'` or `parameter`), keyed by the field's own name. */
export function fieldErrorsFrom(error: unknown): FieldErrors {
  if (!(error instanceof HttpError)) return {};
  return diagnosticsByField(diagnosticsOf(error));
}
