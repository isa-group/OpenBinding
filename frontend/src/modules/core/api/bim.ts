import { apiClient, HttpError } from './http';
import type { components } from './openapi';

type Schemas = components['schemas'];

/**
 * `POST /v1/bim/validate` for a package it compiled: digests, the analysis, the engine modes visible to the caller and their
 * diagnostics; with `include: ['ir']` the IR and its source map, with `include: ['facts']` the facts (what the workflow graph and
 * the candidate matrix read). Nothing is stored.
 */
export type BimValidateResponse = Schemas['AnalysisResult'];

/** The analysis of a compiled package: task, candidate and constraint counts, placement, and the binding-space size as text. */
export type BimAnalysis = BimValidateResponse['analysis'];

/** One engine mode the analysis lists for a package: the engine, its deployment, the mode, whether it can run it and why not. */
export type BimEngineCompatibility = Schemas['EngineCompatibility'];

/** One finding of the gateway, located by resource, pointer, BPMN element or span. */
export type BimDiagnostic = Schemas['Diagnostic'];

/** The template packages a problem can start from (`GET /v1/bim/templates`). */
export type BimTemplateList = Schemas['TemplateList'];

/** What `include` may ask the validation for besides the analysis. */
export type BimValidateInclude = 'ir' | 'facts';

/**
 * A package the gateway read and refused (422), as a result: `invalid_instance` with the compiler's located diagnostics, or
 * another 422 code (an archive the toolchain cannot read, a binding space past the limit) with its message.
 */
export interface BimRefusal {
  valid: false;
  status: number;
  code: string;
  message: string;
  diagnostics: BimDiagnostic[];
}

export interface BimValidateOptions {
  include?: BimValidateInclude[];
  signal?: AbortSignal;
  /** Answer a 422 as a `BimRefusal` instead of throwing it. */
  acceptRefusal?: boolean;
}

const ZIP = { 'Content-Type': 'application/vnd.bim+zip' };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const validateEndpoint = (include: BimValidateInclude[] = []) => {
  const asked = [...new Set(include)];
  return `/v1/bim/validate${asked.length ? `?include=${asked.join(',')}` : ''}`;
};

function refusalOf(error: HttpError): BimRefusal {
  return {
    valid: false,
    status: error.status,
    code: error.code ?? 'invalid_request',
    message:
      error.message.replace(/^HTTP \d+:\s*/, '').trim() || 'The package could not be validated.',
    diagnostics: (error.diagnostics ?? []).filter(isRecord) as BimDiagnostic[],
  };
}

/**
 * Check a package and say which engine modes can run it. A refusal throws (HttpError for 413, 415, 422, 429…) so the screen words
 * each one, and a 422 carries the located diagnostics; with `acceptRefusal`, a 422 comes back as a `BimRefusal` instead.
 */
function validate(
  archive: Uint8Array,
  options: BimValidateOptions & { acceptRefusal: true }
): Promise<BimValidateResponse | BimRefusal>;
function validate(
  archive: Uint8Array,
  options?: BimValidateOptions & { acceptRefusal?: false }
): Promise<BimValidateResponse>;
async function validate(
  archive: Uint8Array,
  options: BimValidateOptions = {}
): Promise<BimValidateResponse | BimRefusal> {
  try {
    return await apiClient.request<BimValidateResponse>(validateEndpoint(options.include), {
      method: 'POST',
      headers: ZIP,
      body: archive as unknown as BodyInit,
      signal: options.signal,
    });
  } catch (caught) {
    if (options.acceptRefusal && caught instanceof HttpError && caught.status === 422)
      return refusalOf(caught);
    throw caught;
  }
}

/**
 * The stateless BIM language services (`/v1/bim/*`): checking a package and the package templates. None needs an account; a
 * signed-in caller is charged to the account, an anonymous one to the address.
 */
export const bimApi = {
  validate,

  /** The template packages (`demo/01_simple_seq`, …). */
  async templates(): Promise<string[]> {
    const body = await apiClient.request<BimTemplateList>('/v1/bim/templates');
    return body.templates || [];
  },

  /** One template as a `.bim.zip`. */
  template: (path: string) =>
    apiClient.requestBinary(
      `/v1/bim/templates/${path.split('/').map(encodeURIComponent).join('/')}`
    ),
};
