// Adapted from SPHERE frontend/src/modules/pricing/components/configuration-space-view/compare-slots.ts (feat/pricing-renderer,
// revision 694f292b03), https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: a slot holds a configuration of the explorer by its key (the version's binding, or one task moved to another
// candidate) instead of a pricing-renderer selection; the keys are what the address carries (`?cfgA=&cfgB=`).

/** Which of the two held configurations a capture fills. */
export type CompareSide = 'a' | 'b';

/** The two configurations held for comparison, by key; either may be empty. */
export type CompareSlots = { a?: string; b?: string };

/**
 * The slot the next capture fills: the first empty one, else A, so a third capture replaces the
 * older side rather than doing nothing.
 */
export function nextSlot(slots: CompareSlots): CompareSide {
  if (!slots.a) return 'a';
  if (!slots.b) return 'b';
  return 'a';
}

/**
 * The label for a capture action, which names the act rather than the letter.
 *
 * "Set as A" means nothing until you already know a comparison exists further down the page. The
 * first capture is an offer to compare; once one side is held, the second says what it will be
 * compared against.
 */
export function captureLabel(slots: CompareSlots): string {
  if (!slots.a) return 'Compare this one';
  if (!slots.b) return 'Compare with A';
  return 'Replace A';
}
