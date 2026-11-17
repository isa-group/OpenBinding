// An engine revision as the catalog and the revision page read it (`GET /v1/engines/{namespace}/{name}/revisions/{version}`),
// cut out of the old `api/platform.ts`.

/** One revision of an engine, with its registered deployment if any. */
export interface EngineRevisionDetail {
  id: string;
  namespace: string;
  name: string;
  version: string;
  digest: string;
  state: string;
  createdAt: string | null;
  document: Record<string, unknown>;
  /**
   * The deployment registered for this revision, if any. The gateway's field names are the ones below
   * (`GET /v1/engines/{namespace}/{name}/revisions/{version}`); the list endpoint sends a shorter summary, so
   * everything but `id` is optional.
   */
  registration: {
    id: string;
    manifestDigest?: string;
    endpoint?: string | null;
    protocolDigest?: string | null;
    openapiDigest?: string | null;
    openapiDocument?: Record<string, unknown> | null;
    verificationReport?: Record<string, unknown> | null;
    verifiedAt?: string | null;
    publicationStatus?: string | null;
    isActive?: boolean;
    /** Names the earlier client used; the gateway does not send them. */
    state?: string;
  } | null;
}
