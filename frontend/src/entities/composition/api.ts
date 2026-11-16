import { apiClient, HttpError, type Revised } from '../../api/client';
import type {
  CheckResult,
  CompositionCreate,
  CompositionDerive,
  CompositionEvaluate,
  CompositionFork,
  CompositionList,
  CompositionNeighborhoodResponse,
  CompositionUpdate,
  CompositionVersionDiff,
  CompositionVersionList,
  CompositionVersionView,
  CompositionView,
  DeriveDraft,
  DeriveResult,
  DiffResult,
  EvaluateResult,
  EvaluationView,
  ForkNameTaken,
  ForkResult,
  ParseResult,
  PublicCompositionList,
  SealResult,
  ValidateResult,
} from '../../shared/api/types';
import type { Kind } from './document';

/**
 * The compositions API (`/v1/organizations/{org}/compositions/…`, `GET /v1/compositions`) and the stateless
 * Composition2Yaml services (`/v1/compositions/*`), over the shared client and the generated types. Refusals throw as the
 * client throws them (an HttpError in either envelope); `readApiError` reads them. Where the gateway answers 201 for
 * something new and 200 for something that already existed (a seal, a fork, a derivation, a re-evaluation), the answer
 * says which.
 */

const enc = encodeURIComponent;
const YAML = { 'Content-Type': 'application/yaml' };

const compositionsRoot = (org: string) => `/v1/organizations/${enc(org)}/compositions`;
const compositionRoot = (org: string, composition: string) =>
  `${compositionsRoot(org)}/${enc(composition)}`;
const versionRoot = (org: string, composition: string, version: string) =>
  `${compositionRoot(org, composition)}/versions/${enc(version)}`;

/** A query string of the parameters that have a value (`?a=1&b=2`), or nothing. */
function query(params: Record<string, string | number | boolean | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(name, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

/** The body and whether it is new (201) or one that already existed (200). */
interface Answered<T> {
  created: boolean;
  body: T;
}

const answered = <T>(endpoint: string, init: RequestInit) =>
  apiClient.request<Answered<T>>(endpoint, init, undefined, true, true, async response => ({
    created: response.status === 201,
    body: (await response.json()) as T,
  }));

const revised = <T>(endpoint: string, init: RequestInit = {}) =>
  apiClient.request<Revised<T>>(endpoint, init, undefined, true, true, async response => ({
    value: (await response.json()) as T,
    etag: response.headers.get('ETag'),
  }));

export interface ListOptions {
  kind?: Kind;
  q?: string;
  archived?: boolean;
  /** Only compositions with a version linking a revision of this problem (its slug or id); none for an unknown one. */
  problem?: string;
  sort?: 'name' | 'updated';
  limit?: number;
  offset?: number;
}

export interface PublicListOptions {
  kind?: Kind;
  q?: string;
  /** Only this organization's public compositions (its slug). */
  organization?: string;
  limit?: number;
  offset?: number;
}

export type VersionInclude = 'analytics' | 'evaluations';

export interface VersionsOptions {
  include?: readonly VersionInclude[];
  order?: 'newest' | 'oldest';
  limit?: number;
  offset?: number;
  /** Only versions sealed at or after this instant (ISO 8601). */
  createdAfter?: string;
  /** Only versions sealed before this instant (ISO 8601). */
  createdBefore?: string;
}

/** The largest page the versions route serves. */
const VERSION_PAGE = 200;

export interface Sealed {
  /** A new version (201), or the one that already held these bytes (200). */
  created: boolean;
  result: SealResult;
}

export type Forked =
  | { status: 'forked'; result: ForkResult }
  | { status: 'nameTaken'; existing: ForkNameTaken['existingComposition'] };

export interface Derived {
  /** A new version (201); false for the version that already held these bytes, or for a draft (`seal: false`). */
  created: boolean;
  result: DeriveResult | DeriveDraft;
}

export interface Reevaluated {
  /** A new evaluation (201), or the one the installed toolchain had already made (200). */
  created: boolean;
  evaluation: EvaluationView;
}

interface CachedContent {
  etag: string | null;
  text: string;
}

/** Version texts by URL. A version never changes, so a cached text is revalidated (`If-None-Match`) and kept on 304. */
const contents = new Map<string, CachedContent>();

/** Forget every cached version text (tests start from an empty cache). */
export function clearCompositionContentCache(): void {
  contents.clear();
}

export const compositionsApi = {
  /** The compositions of an organization. */
  list: (org: string, options: ListOptions = {}) =>
    apiClient.request<CompositionList>(`${compositionsRoot(org)}${query({ ...options })}`),

  /** The public compositions of every organization; anybody may list them. */
  publicList: (options: PublicListOptions = {}) =>
    apiClient.request<PublicCompositionList>(`/v1/compositions${query({ ...options })}`),

  /** One composition, with its `ETag` for a later change. */
  get: (org: string, composition: string) =>
    revised<CompositionView>(compositionRoot(org, composition)),

  create: (org: string, body: CompositionCreate) =>
    apiClient.request<CompositionView>(compositionsRoot(org), {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** A change decided on the revision `ifMatch` names; a 412 names the current one. */
  update: (org: string, composition: string, body: CompositionUpdate, ifMatch: string | null) =>
    revised<CompositionView>(compositionRoot(org, composition), {
      method: 'PATCH',
      body: JSON.stringify(body),
      ...(ifMatch ? { headers: { 'If-Match': ifMatch } } : {}),
    }),

  remove: (org: string, composition: string) =>
    apiClient.request<void>(compositionRoot(org, composition), { method: 'DELETE' }),

  /** One page of versions: light rows, with `include` adding analytics or evaluations. */
  versions: (org: string, composition: string, options: VersionsOptions = {}) =>
    apiClient.request<CompositionVersionList>(
      `${compositionRoot(org, composition)}/versions${query({
        include: options.include?.length ? options.include.join(',') : undefined,
        order: options.order,
        limit: options.limit,
        offset: options.offset,
        created_after: options.createdAfter,
        created_before: options.createdBefore,
      })}`
    ),

  /** Every version the options select, page after page until the gateway's total is reached. */
  async allVersions(
    org: string,
    composition: string,
    options: Omit<VersionsOptions, 'limit' | 'offset'> = {}
  ) {
    const versions: CompositionVersionView[] = [];
    for (;;) {
      const page = await compositionsApi.versions(org, composition, {
        ...options,
        limit: VERSION_PAGE,
        offset: versions.length,
      });
      versions.push(...page.versions);
      if (page.versions.length === 0 || versions.length >= page.total) return versions;
    }
  },

  /** One version by id, label or ordinal; with `document`, its content as the canonical JSON model, read as it was sealed. */
  version: (
    org: string,
    composition: string,
    version: string,
    options: { document?: boolean } = {}
  ) =>
    apiClient.request<CompositionVersionView>(
      `${versionRoot(org, composition, version)}${query({ include: options.document ? 'document' : undefined })}`
    ),

  /** The stored text of a version. Pass its id: the text is cached by address and revalidated with `If-None-Match`. */
  async content(org: string, composition: string, version: string): Promise<string> {
    const url = `${versionRoot(org, composition, version)}/content`;
    const cached = contents.get(url);
    try {
      const answer = await apiClient.request<CachedContent>(
        url,
        cached?.etag ? { headers: { 'If-None-Match': cached.etag } } : {},
        undefined,
        true,
        true,
        async response => ({ text: await response.text(), etag: response.headers.get('ETag') })
      );
      contents.set(url, answer);
      return answer.text;
    } catch (caught) {
      if (cached && caught instanceof HttpError && caught.status === 304) return cached.text;
      throw caught;
    }
  },

  /** Assess a text as a seal would, storing nothing. */
  check: (org: string, composition: string, yaml: string, signal?: AbortSignal) =>
    apiClient.request<CheckResult>(`${compositionRoot(org, composition)}/versions/check`, {
      method: 'POST',
      headers: YAML,
      body: yaml,
      signal,
    }),

  /** Seal a text as a new version (201), or answer the version that already holds its bytes (200). */
  async seal(org: string, composition: string, yaml: string): Promise<Sealed> {
    const { created, body } = await answered<SealResult>(
      `${compositionRoot(org, composition)}/versions`,
      {
        method: 'POST',
        headers: YAML,
        body: yaml,
      }
    );
    return { created, result: body };
  },

  /** What changed from one version to another (by id, label or ordinal); the gateway picks the defaults. */
  diff: (org: string, composition: string, from?: string, to?: string) =>
    apiClient.request<CompositionVersionDiff>(
      `${compositionRoot(org, composition)}/diff${query({ from, to })}`
    ),

  /** Fork a version into another organization (201), or learn that the source's slug is taken there (200). */
  async fork(org: string, composition: string, body: CompositionFork): Promise<Forked> {
    const answer = await answered<ForkResult | ForkNameTaken>(
      `${compositionRoot(org, composition)}/fork`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      }
    );
    if (answer.created) return { status: 'forked', result: answer.body as ForkResult };
    return { status: 'nameTaken', existing: (answer.body as ForkNameTaken).existingComposition };
  },

  /** Evaluate another binding of a version, storing nothing. */
  evaluate: (org: string, composition: string, body: CompositionEvaluate, signal?: AbortSignal) =>
    apiClient.request<EvaluateResult>(`${compositionRoot(org, composition)}/evaluate`, {
      method: 'POST',
      body: JSON.stringify(body),
      signal,
    }),

  /** The toolchain's one-task alternatives of a version's binding. */
  neighborhood: (
    org: string,
    composition: string,
    options: { version?: string; task?: string; limit?: number } = {}
  ) =>
    apiClient.request<CompositionNeighborhoodResponse>(
      `${compositionRoot(org, composition)}/neighborhood${query({ ...options })}`
    ),

  /** Derive a version from a run's solution or a binding of a problem revision. */
  async derive(org: string, composition: string, body: CompositionDerive): Promise<Derived> {
    const { created, body: result } = await answered<DeriveResult | DeriveDraft>(
      `${compositionRoot(org, composition)}/derive`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      }
    );
    return { created, result };
  },

  /** Evaluate a version with the installed toolchain (201), or answer the evaluation it already has (200). */
  async reevaluate(org: string, composition: string, version: string): Promise<Reevaluated> {
    const { created, body } = await answered<EvaluationView>(
      `${versionRoot(org, composition, version)}/evaluations`,
      { method: 'POST' }
    );
    return { created, evaluation: body };
  },
};

/** The stateless Composition2Yaml services: anybody may call them, under the `read` budget. */
export const languageApi = {
  /** Lint a text: `{valid, diagnostics}`. */
  validate: (yaml: string, signal?: AbortSignal) =>
    apiClient.request<ValidateResult>('/v1/compositions/validate', {
      method: 'POST',
      headers: YAML,
      body: yaml,
      signal,
    }),

  /** A text as its JSON model; an invalid text is a 422 with its diagnostics. */
  parse: (yaml: string, signal?: AbortSignal) =>
    apiClient.request<ParseResult>('/v1/compositions/parse', {
      method: 'POST',
      headers: YAML,
      body: yaml,
      signal,
    }),

  /** A JSON document written as its canonical text. */
  serialise: (document: Record<string, unknown>, signal?: AbortSignal) =>
    apiClient.request<string>(
      '/v1/compositions/serialise',
      { method: 'POST', body: JSON.stringify(document), signal },
      undefined,
      true,
      true,
      response => response.text()
    ),

  /** The JSON Schema of a syntax version. */
  schema: (syntaxVersion = '1.0') =>
    apiClient.request<Record<string, unknown>>(
      `/v1/compositions/schema${query({ syntaxVersion })}`
    ),

  /** What changed between two texts. */
  diffDocuments: (before: string, after: string) =>
    apiClient.request<DiffResult>('/v1/compositions/diff', {
      method: 'POST',
      body: JSON.stringify({ before, after }),
    }),
};
