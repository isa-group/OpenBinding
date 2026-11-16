// Extracted from the inline `offerReloadIfChanged` of SPHERE frontend/src/modules/pricing/pages/card/index.tsx and
// `isPricingChangedError` of frontend/src/modules/pricing/api/pricingsApi.ts (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: a shared utility instead of a closure in one page; it recognises OpenBinding's `precondition_failed` refusal as
// well as a bare 412, and the message names the resource.

import customConfirm from './custom-confirm';

/** Whether a write was refused because the resource changed after it was read (412, `precondition_failed`). */
export function isChangedError(error: unknown): boolean {
  const refusal = error as { status?: number; code?: string } | null;
  return refusal?.status === 412 || refusal?.code === 'precondition_failed';
}

export function changedMessage(resource = 'this item'): string {
  return `Someone else changed ${resource} since you opened it. Reload the page to see the latest version, then try again.`;
}

/**
 * A change refused because the resource changed after it was loaded (412): offers to reload instead of showing a generic
 * error. Returns whether it was one, so the caller can fall back to its own message otherwise.
 */
export function offerReloadIfChanged(
  error: unknown,
  {
    resource,
    reload = () => window.location.reload(),
  }: { resource?: string; reload?: () => void } = {}
): boolean {
  if (!isChangedError(error)) return false;
  customConfirm(changedMessage(resource), { confirmLabel: 'Reload', cancelLabel: 'Not now' })
    .then(reload)
    .catch(() => {});
  return true;
}
