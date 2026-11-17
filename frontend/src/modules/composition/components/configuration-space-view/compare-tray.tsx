// Adapted from SPHERE frontend/src/modules/pricing/components/configuration-space-view/compare-tray.tsx (feat/pricing-renderer,
// revision 694f292b03), https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: each slot names a configuration of the composition (`describe`) instead of a pricing selection; the hints are set
// in steel, which reaches 4.5:1 (SPHERE's muted grey is 2.3:1); on a phone the tray is a sheet fixed to the bottom of the
// screen, so the slots stay in reach while the list scrolls.

import type { CompareSide, CompareSlots } from './compare-slots';

export interface CompareTrayProps {
  slots: CompareSlots;
  /** The words of a held configuration. */
  describe: (key: string) => string;
  onClear: (side?: CompareSide) => void;
  onSwap: () => void;
  /** Whether the two held configurations differ; equal ones have nothing to show. */
  identical: boolean;
}

/**
 * The two configurations held for comparison, kept at the top of the tab.
 *
 * It is always on screen, so the mechanism explains itself before anyone scrolls: two named slots
 * that fill as you capture.
 */
export default function CompareTray({
  slots,
  describe,
  onClear,
  onSwap,
  identical,
}: CompareTrayProps) {
  const filled = (slots.a ? 1 : 0) + (slots.b ? 1 : 0);
  return (
    <section
      aria-label="Compare"
      className={`rounded-xl border border-tp-hairline bg-tp-canvas p-3 ${
        filled > 0
          ? 'max-sm:fixed max-sm:inset-x-0 max-sm:bottom-0 max-sm:z-40 max-sm:rounded-b-none max-sm:shadow-elevation-4'
          : ''
      }`}
    >
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <p className="text-[10px] font-medium tracking-wider text-tp-steel uppercase">Compare</p>
          <p className="text-[11px] text-tp-steel" role="status">
            {filled === 0
              ? 'Hold two configurations to see what differs.'
              : filled === 1
                ? 'Hold a second one to see what differs.'
                : identical
                  ? 'Both slots hold the same configuration.'
                  : 'Showing what differs, below.'}
          </p>
        </div>
        <div className="flex flex-1 flex-wrap items-center gap-2">
          {(['a', 'b'] as const).map(side => {
            const held = slots[side];
            return (
              <div
                key={side}
                className={`flex min-w-45 flex-1 items-center gap-2 rounded-lg border px-3 py-2 ${
                  held
                    ? 'border-tp-primary bg-tp-primary/5'
                    : 'border-dashed border-tp-hairline-strong bg-tp-surface'
                }`}
              >
                <span
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
                    held ? 'bg-tp-accent text-tp-on-primary' : 'bg-tp-hairline-soft text-tp-steel'
                  }`}
                >
                  {side.toUpperCase()}
                </span>
                <span
                  className={`truncate text-xs ${held ? 'text-tp-ink' : 'text-tp-steel italic'}`}
                >
                  {held ? describe(held) : 'empty'}
                </span>
                {held && (
                  <button
                    type="button"
                    onClick={() => onClear(side)}
                    aria-label={`Clear ${side.toUpperCase()}`}
                    className="ml-auto cursor-pointer rounded p-0.5 text-tp-steel transition-colors hover:bg-tp-surface hover:text-tp-ink"
                  >
                    <svg
                      className="h-3.5 w-3.5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2.5}
                      aria-hidden="true"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>
            );
          })}
        </div>
        {filled > 0 && (
          <div className="flex items-center gap-2">
            {filled === 2 && (
              <button
                type="button"
                onClick={onSwap}
                className="cursor-pointer rounded-md border border-tp-hairline-strong bg-tp-canvas px-2.5 py-1 text-xs text-tp-slate transition-colors hover:bg-tp-surface"
              >
                Swap
              </button>
            )}
            <button
              type="button"
              onClick={() => onClear()}
              className="cursor-pointer text-[11px] text-tp-steel underline underline-offset-2 hover:text-tp-ink"
            >
              Clear both
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
