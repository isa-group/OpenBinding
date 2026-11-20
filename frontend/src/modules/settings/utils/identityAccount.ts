import { SETTINGS_PATH } from '../pages/settings-page/sections';

/**
 * The SCORETech Identity account page (the gateway's `account_url`, which ends in `#public-profile`), with `return_to` set to
 * Settings › Account, as SPHERE's IdentityAccountSection builds it; undefined without one (local mode).
 */
export function identityAccountHref(accountUrl: string | null | undefined): string | undefined {
  if (!accountUrl) return undefined;
  const target = new URL(accountUrl);
  const returnTo = new URL(SETTINGS_PATH, window.location.origin);
  returnTo.searchParams.set('section', 'account');
  target.searchParams.set('return_to', returnTo.href);
  return target.href;
}
