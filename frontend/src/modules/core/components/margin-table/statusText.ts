// The words for each status of the gateway's margins answer, and the currencies a mismatch names.

import type { CompositionMargins } from '../../api/types';

const STATUS_TEXT: Partial<Record<CompositionMargins['status'], string>> = {
  users_required: 'Set the number of users to see margins.',
  no_offering: 'This version names no offering, so it has no margins.',
  offering_unreadable: 'The offering could not be read when this version was evaluated.',
  offering_invalid: 'The offering is not a pricing OpenBinding can read.',
  offering_registry_unknown:
    'The offering names a SPHERE registry this installation does not know.',
  no_cost_value:
    'This version has no value in a currency per period, so there is no upstream cost to share.',
  ambiguous_cost: 'This version has more than one cost value, and margins take one.',
  binding_invalid:
    'The binding of this version is not valid for its problem, so its cost is not one it stands behind.',
  semantics_changed:
    'The installed toolchain reads this version’s problem differently: derive it again.',
  amount_out_of_range: 'The cost is too large to compute margins with.',
};

/** The words for a status, with the currencies a mismatch names. */
export function marginsStatusText(margins: CompositionMargins): string | null {
  if (margins.status === 'ok') return null;
  if (margins.status === 'currency_mismatch') {
    const cost = margins.cost?.unit.split('/')[0] ?? 'one currency';
    const offering = margins.offering?.currency ?? 'another';
    return `Costs are in ${cost} and the offering in ${offering}: no exchange rates are applied.`;
  }
  return STATUS_TEXT[margins.status] ?? null;
}
