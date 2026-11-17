// Address builders of the engines area. The public catalog (`/engines`) and an exact revision
// (`/engines/:namespace/:name/:version`, its tab in `?tab=`) are open to everyone; the account's own deployments live under
// `/me/engines`: the list, the four-step registration (`/me/engines/new`) and one registration (`/me/engines/:name`, its exact
// identity in the query).

import type { ImmutableResourceRef } from '../../modules/core/api/types';

/** The public engine catalog. */
export const ENGINES_PATH = '/engines';

/** The account's engine registrations. */
export const MY_ENGINES_PATH = '/me/engines';

/** The tabs of an engine revision after the first (Modes & options). */
export const ENGINE_TABS = ['capabilities', 'registrations'] as const;
export type EngineTab = (typeof ENGINE_TABS)[number];

export const isEngineTab = (value: string): value is EngineTab =>
  (ENGINE_TABS as readonly string[]).includes(value);

const enc = encodeURIComponent;

/** One exact engine revision of the catalog, on a tab (`modes` when none). */
export function engineHref(
  ref: { namespace: string; name: string; version: string },
  tab?: EngineTab
): string {
  return `${ENGINES_PATH}/${enc(ref.namespace)}/${enc(ref.name)}/${enc(ref.version)}${tab ? `?tab=${tab}` : ''}`;
}

/** The account's registrations; `review` lists what waits for an administrator's review. */
export function myEnginesPath(options: { review?: boolean } = {}): string {
  return options.review ? `${MY_ENGINES_PATH}?review=true` : MY_ENGINES_PATH;
}

/** The registration form; `from` starts it from an existing registration, as its next version. */
export function registerEnginePath(from?: ImmutableResourceRef): string {
  if (!from) return `${MY_ENGINES_PATH}/new`;
  const query = new URLSearchParams({
    from: from.name,
    namespace: from.namespace,
    version: from.version,
    digest: from.digest,
  });
  return `${MY_ENGINES_PATH}/new?${query.toString()}`;
}

/** One exact registration of the account (or one published for everyone), with an optional `#section`. */
export function registrationPath(ref: ImmutableResourceRef, hash = ''): string {
  const query = new URLSearchParams({
    namespace: ref.namespace,
    version: ref.version,
    digest: ref.digest,
  });
  return `${MY_ENGINES_PATH}/${enc(ref.name)}?${query.toString()}${hash}`;
}
