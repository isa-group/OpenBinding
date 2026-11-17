/**
 * Leave the application for another address with a full page load: the CAS round trip, and the farewell after an
 * account is deleted. Kept behind a function so that tests can stand in for the browser's navigation.
 */
export function leaveTo(url: string): void {
  window.location.assign(url);
}
