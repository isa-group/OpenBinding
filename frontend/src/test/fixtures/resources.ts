import type { UsageView } from '../../api/auth';

/** Shared by the tests of the account and launch screens, and by the browser specs that mock the same API. */

/** `sha256-` followed by 64 copies of one hexadecimal character. */
export const digestOf = (char: string): string => `sha256-${char.repeat(64)}`;

export function usageOf(over: Partial<UsageView> = {}): UsageView {
  return {
    plan: 'RESEARCH',
    contract_pending: false,
    features: {},
    capabilities: { maxPayloadBytes: 134_217_728, storageBytes: 5_368_709_120 },
    ...over,
  };
}
