import { config } from '../../../config';

/** An absolute address for a gateway path (the API base may be relative to this page). */
export function gatewayUrl(path: string): string {
  const base = config.apiBaseUrl.replace(/\/$/, '');
  const absolute = /^https?:\/\//.test(base) ? base : `${window.location.origin}${base}`;
  return `${absolute}${path}`;
}
