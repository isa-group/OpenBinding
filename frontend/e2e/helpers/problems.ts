/**
 * The body the gateway answers a failure with (docs/ERRORS.md).
 *
 * Every 422 is one problem document, `{ type, title, status, code, detail (a sentence), diagnostics }`; the specs that mock a 422 send
 * that, with the one diagnostic a refusal that names nothing finer carries. Any other status keeps `{ detail: { code, error, … } }`
 * and gains `type`, `title`, `status` and `code` beside it.
 */
export function failureBody(status: number, code: string, error: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const head = { type: `https://openbinding.dev/problems/${code}`, title: code, status, code };
  if (status === 422) return { ...head, detail: error, diagnostics: [{ code, message: error }], ...extra };
  return { ...head, detail: { code, error, ...extra } };
}

/** A 422 for a request FastAPI refused: the diagnostics name the field by pointer, as the gateway sends them. */
export function validationBody(summary: string, diagnostics: Array<{ code: string; message: string; pointer?: string; loc?: Array<string | number> }>): Record<string, unknown> {
  return {
    type: 'https://openbinding.dev/problems/validation_error', title: 'validation_error', status: 422, code: 'validation_error',
    detail: `Request validation failed: ${summary}`, diagnostics: diagnostics.map((item) => ({ in: 'body', ...item })),
  };
}
