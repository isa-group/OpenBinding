import type { ValueStatus } from '../../utils/composition/values';

/**
 * The words of each value status: the only place a screen's "Verified", "Declared" and "Unverified" are written. The badge prints
 * them, and a chart that names a status in its legend or its tooltip reads them here (`vocabulary.terms.test.ts`).
 */
export const VALUE_STATUS_TEXT: Readonly<Record<ValueStatus, string>> = {
  verified: 'Verified',
  declared: 'Declared',
  unverified: 'Unverified',
};
