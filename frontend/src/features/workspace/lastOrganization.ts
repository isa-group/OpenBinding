// The organization the account last worked in, so Home can show that one's recent runs. Kept per browser (a convenience: a missing or
// unreadable value just falls back to the first organization).

const KEY = 'openbinding.lastOrganization';

/** Remember `slug` as the organization last visited. */
export function rememberOrganization(slug: string): void {
  try {
    window.localStorage.setItem(KEY, slug);
  } catch {
    // Storage blocked or full: Home falls back to the first organization.
  }
}

/** The organization last visited, when one was remembered. */
export function lastOrganization(): string | null {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}
