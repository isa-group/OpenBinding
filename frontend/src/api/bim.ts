import { apiClient, type BimAnalysisResponse, type PackageValidationOutcome } from './client';

const ZIP = { 'Content-Type': 'application/vnd.bim+zip' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `POST /v1/bim/validate`: the analysis of a package, and with `include: 'ir'` its IR and source map. Nothing is stored. */
export interface BimValidation extends BimAnalysisResponse {
  instanceDigest?: string;
  packageDigest?: string;
  irDigest?: string;
  fileDigests?: Record<string, string>;
  resourceDigests?: Record<string, string>;
  ir?: Record<string, unknown>;
  sourceMap?: Record<string, unknown>;
}

const validateEndpoint = (include?: 'ir') => `/v1/bim/validate${include ? `?include=${include}` : ''}`;

/**
 * The stateless BIM language services (`/v1/bim/*`): checking a package and the package templates. None needs an account; a
 * signed-in caller is charged to the account, an anonymous one to the address.
 */
export const bimApi = {
  /**
   * Check a package and say which engine modes can run it. Throws on a refusal (HttpError for 413, 415, 422, 429…) so the screen
   * words each one; a 422 carries the located diagnostics.
   */
  validate: (archive: Uint8Array, options: { include?: 'ir'; signal?: AbortSignal } = {}) =>
    apiClient.request<BimValidation>(validateEndpoint(options.include), {
      method: 'POST', headers: ZIP, body: archive as unknown as BodyInit, signal: options.signal,
    }, undefined, true, true),

  /**
   * The same check, where a package the gateway reads and refuses (422) is a result, not a failure: it comes back as
   * `{ valid: false }` with its diagnostics. Too large (413), wrong media type (415) and rate limits (429) throw HttpError.
   */
  async check(archive: Uint8Array, signal?: AbortSignal): Promise<PackageValidationOutcome> {
    const body = await apiClient.request<Record<string, unknown>>(validateEndpoint(), {
      method: 'POST', headers: ZIP, body: archive as unknown as BodyInit, signal,
    }, undefined, true, false);
    if (isRecord(body) && body.valid === true) {
      return {
        valid: true,
        result: {
          valid: true,
          instanceDigest: String(body.instanceDigest ?? ''),
          packageDigest: String(body.packageDigest ?? ''),
          fileDigests: isRecord(body.fileDigests) ? body.fileDigests as Record<string, string> : {},
          resourceDigests: isRecord(body.resourceDigests) ? body.resourceDigests as Record<string, string> : {},
          irDigest: String(body.irDigest ?? ''),
          diagnostics: Array.isArray(body.diagnostics) ? body.diagnostics.filter(isRecord) : [],
        },
      };
    }
    const detail = isRecord(body) ? body.detail : undefined;
    const detailRecord = isRecord(detail) ? detail : undefined;
    const diagnostics = isRecord(body) && Array.isArray(body.diagnostics)
      ? body.diagnostics
      : Array.isArray(detailRecord?.diagnostics) ? detailRecord.diagnostics : [];
    return {
      valid: false,
      refusal: {
        status: typeof body?.status === 'number' ? body.status : 422,
        code: (typeof body?.code === 'string' ? body.code : undefined)
          ?? (typeof body?.title === 'string' ? body.title : undefined)
          ?? (typeof detailRecord?.code === 'string' ? detailRecord.code : undefined) ?? 'invalid_request',
        message: (typeof detail === 'string' ? detail : undefined)
          ?? (typeof detailRecord?.message === 'string' ? detailRecord.message : undefined)
          ?? (typeof detailRecord?.error === 'string' ? detailRecord.error : undefined)
          ?? 'The package could not be validated.',
        diagnostics: diagnostics.filter(isRecord),
      },
    };
  },

  /** The template packages (`demo/01_simple_seq`, …). */
  async templates(): Promise<string[]> {
    const body = await apiClient.request<{ templates: string[] }>('/v1/bim/templates');
    return body.templates || [];
  },

  /** One template as a `.bim.zip`. */
  template: (path: string) =>
    apiClient.requestBinary(`/v1/bim/templates/${path.split('/').map(encodeURIComponent).join('/')}`),
};
