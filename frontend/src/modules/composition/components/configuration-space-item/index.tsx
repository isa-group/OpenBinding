// Adapted from SPHERE frontend/src/modules/pricing/components/configuration-space-item/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: a configuration of a composition (a binding: the version's, or one task moved) in the Quick Browse row of the
// feat/pricing-renderer explorer: the move, the gateway's comparison word and the penalty change; a real button with the
// theme's tokens instead of a clickable div and slate classes; a second action holds it for comparison.

import { comparisonText } from '../../../core/utils/binding/comparison';
import { signed } from '../../../core/components/composition-renderer/modes/calculatorModel';
import type { ExplorerConfiguration } from '../configuration-space-view/configurations';

interface Props {
  configuration: ExplorerConfiguration;
  index: number;
  active: boolean;
  onFocus: () => void;
  onDetails: () => void;
  /** Hold it for comparison; absent until the explorer can compare. */
  onCapture?: () => void;
  captureText: string;
}

export default function ConfigurationSpaceItem({
  configuration,
  index,
  active,
  onFocus,
  onDetails,
  onCapture,
  captureText,
}: Props) {
  const move = configuration.move;
  return (
    <li
      className={`flex w-full items-center gap-1 rounded-lg border transition-colors ${active ? 'border-tp-primary bg-tp-primary/5' : 'border-tp-hairline bg-tp-canvas hover:bg-tp-surface'}`}
    >
      <button
        type="button"
        onClick={onFocus}
        onDoubleClick={onDetails}
        aria-current={active ? 'true' : undefined}
        className="min-w-0 flex-1 cursor-pointer px-3 py-2 text-left"
      >
        <span className="flex items-center justify-between gap-2">
          <span className="truncate font-mono text-sm font-medium text-tp-ink">
            {configuration.label}
          </span>
          <span className="shrink-0 text-[10px] text-tp-steel">#{index}</span>
        </span>
        <span className="mt-0.5 block text-[11px] text-tp-steel">
          {move
            ? `${comparisonText(move.comparisonSent).label} · penalty ${signed(move.penaltyDelta)}${move.feasible ? '' : ' · infeasible'}`
            : 'As sealed'}
        </span>
      </button>
      <button
        type="button"
        onClick={onDetails}
        aria-label={`Details of ${configuration.label}`}
        className="shrink-0 cursor-pointer rounded-md px-1.5 py-1 text-[10px] font-medium text-tp-steel hover:bg-tp-surface hover:text-tp-ink"
      >
        Details
      </button>
      {onCapture && (
        <button
          type="button"
          onClick={onCapture}
          aria-label={`${captureText}: ${configuration.label}`}
          title={captureText}
          className="mr-2 shrink-0 cursor-pointer rounded-md border border-tp-hairline-strong bg-tp-canvas px-2 py-1 text-[10px] font-medium text-tp-slate transition-colors hover:bg-tp-surface"
        >
          {captureText === 'Compare with A' ? 'vs A' : 'Compare'}
        </button>
      )}
    </li>
  );
}
