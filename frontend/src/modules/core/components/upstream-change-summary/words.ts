// The sentences of an upstream event's reasons and notes: one for each code the gateway's classifier writes
// (`modules/compositions/domain/upstream.py`, `Reason` and `Note`), with the detail it stored. A code this list does not
// know is said by its code, never dropped.

import { decimalText } from './format';

/** One reason as the gateway stores it: a code and its detail. */
export interface Reason {
  code: string;
  [detail: string]: unknown;
}

const str = (value: unknown): string | null =>
  typeof value === 'string' && value ? value : typeof value === 'number' ? String(value) : null;

/** The causes of `source_unavailable`. */
const SOURCE_UNAVAILABLE: Record<string, string> = {
  family_not_found:
    'Source unavailable: the pricing is no longer readable in SPHERE (hidden, private or deleted).',
  version_withdrawn:
    'Source unavailable: the pinned version is no longer listed by the pricing’s SPHERE family.',
};

/** A reason in words; `host` is the host of a URL offering's file. */
export function reasonText(reason: Reason, host: string | null = null): string {
  const plan = str(reason.plan);
  const addOn = str(reason.addOn);
  switch (reason.code) {
    case 'source_unavailable': {
      const detail = str(reason.detail) ?? '';
      if (host) return `Source unavailable: the file at ${host} can no longer be read.`;
      return (
        SOURCE_UNAVAILABLE[detail] ??
        `Source unavailable: the pricing can no longer be read (${detail || 'no detail'}).`
      );
    }
    case 'pricing_unreadable':
      return `The new version can’t be read by OpenBinding (${str(reason.detail) ?? 'pricing_invalid'}), so nothing it states can be compared.`;
    case 'plan_removed': {
      const renamed = str(reason.renamedTo);
      return `Plan ${plan ?? '?'} is no longer offered.${renamed ? ` ${renamed} is identical to it and may be its new name.` : ''}`;
    }
    case 'plan_private':
      return `Plan ${plan ?? '?'} is now private.`;
    case 'price_not_numeric':
      return addOn
        ? `The price of add-on ${addOn} is no longer a number (a label, or an expression that can’t be evaluated).`
        : `The price of plan ${plan ?? '?'} is no longer a number (a label, or an expression that can’t be evaluated).`;
    case 'addon_removed':
      return `Add-on ${addOn ?? '?'} is no longer offered.`;
    case 'addon_unavailable':
      return `Add-on ${addOn ?? '?'} is no longer available for the bound plan.`;
    case 'addon_not_subscription':
      return `Add-on ${addOn ?? '?'} is no longer a plain subscription (now metered, private or dependent on another).`;
    case 'currency_changed': {
      const before = str(reason.before);
      const after = str(reason.after);
      return before
        ? `The currency changed from ${before} to ${after ?? '?'}.`
        : `The currency is now ${after ?? 'another one'}.`;
    }
    case 'billing_missing':
      return `The billing period ${str(reason.billing) ?? 'bound'} is no longer offered.`;
    case 'value_unmapped': {
      const target = str(reason.target);
      return target
        ? `${target}, which the recipe reads, is no longer declared by the pricing.`
        : 'A value the recipe reads is no longer declared by the pricing.';
    }
    case 'requirement_unmet': {
      const name = str(reason.name) ?? '?';
      if (reason.kind === 'feature') return `Requirement not met: ${name} is no longer included.`;
      const demand = str(reason.demand);
      const after = str(reason.after);
      return `Requirement not met: ${name} is ${after ? decimalText(after) : 'not declared'}, below the demand of ${demand ? decimalText(demand) : '?'}.`;
    }
    case 'offering_unavailable':
      return host
        ? `The offering file at ${host} can no longer be read, so there are no margins after.`
        : `The new offering version can’t be read (${str(reason.detail) ?? 'unavailable'}), so there are no margins after.`;
    default:
      return `${reason.code}${str(reason.detail) ? ` (${str(reason.detail)})` : ''}.`;
  }
}

const NOTES: Record<string, string> = {
  values_not_reevaluated:
    'Nothing was re-evaluated: a person decides, by re-solving the problem or re-evaluating the version.',
  no_direct_mapping:
    'Some values are read through a table, a scale or a limit, so only before and after are given, with no change in the composition’s values.',
  no_value_origins:
    'This version’s values were not read from the pricing by OpenBinding, so only the plan, its add-ons and its price were checked.',
  unlimited_sentinel:
    'Unlimited (≥ 100,000,000): OpenBinding reads numbers this large as Unlimited, so two of them compare equal even when SPHERE shows different numbers.',
  domain_may_change:
    'The new value may fall outside the range the problem allows; re-solving says whether the binding still fits.',
  baseline_unavailable:
    'OpenBinding holds no copy of the pinned version, so the new version was judged on its own.',
};

/** A note in words. */
export function noteText(code: string): string {
  return NOTES[code] ?? code;
}
