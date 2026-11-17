// Adapted from SPHERE frontend/src/modules/pricing/components/configuration-details-modal/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: a binding of a composition instead of a pricing configuration: each task with its candidate (the moved one marked)
// and, for a move, the gateway's comparison, deltas and broken rules; drawn in OpenBinding's modal (a focus trap and Escape,
// which SPHERE's lacked) with the theme's tokens instead of white and black.

import { Modal } from '../../../core/components/modal';
import { comparisonText } from '../../../core/utils/binding/comparison';
import { signed } from '../../../core/components/composition-renderer/modes/calculatorModel';
import type { ExplorerConfiguration } from '../configuration-space-view/configurations';

export default function ConfigurationDetailsModal({
  configuration,
  onClose,
}: Readonly<{
  configuration: ExplorerConfiguration;
  onClose: () => void;
}>) {
  const move = configuration.move;
  return (
    <Modal title={configuration.label} size="lg" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <section aria-label="Binding">
          <h3 className="mb-2 text-sm font-semibold text-tp-ink">Binding</h3>
          <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {Object.entries(configuration.binding).map(([task, candidate]) => (
              <li
                key={task}
                className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-1.5 text-xs ${
                  move?.task === task ? 'border-tp-primary bg-tp-primary/5' : 'border-tp-hairline'
                }`}
              >
                <span className="font-mono font-medium text-tp-ink">{task}</span>
                <span className="truncate font-mono text-tp-slate">{candidate}</span>
              </li>
            ))}
          </ul>
        </section>
        {move && (
          <section aria-label="What the move changes">
            <h3 className="mb-2 text-sm font-semibold text-tp-ink">What the move changes</h3>
            <p className="text-xs text-tp-slate">
              {comparisonText(move.comparisonSent).label}
              {move.feasible ? '' : ' · not feasible'}
              {move.provider ? ` · provider ${move.provider}` : ''}
            </p>
            <ul className="mt-2 flex flex-wrap gap-2 text-xs">
              {move.deltas.map((delta, position) => (
                <li
                  key={`${delta.feature}-${position}`}
                  className="rounded-md bg-tp-surface px-2 py-1 text-tp-ink"
                >
                  {delta.feature}{' '}
                  <b>
                    {delta.value === null
                      ? '—'
                      : `${signed(delta.value)}${delta.unit && delta.unit !== '1' ? ` ${delta.unit}` : ''}`}
                  </b>
                </li>
              ))}
              <li className="rounded-md bg-tp-surface px-2 py-1 text-tp-ink">
                penalty <b>{signed(move.penaltyDelta)}</b>
              </li>
            </ul>
            {move.violations.length > 0 && (
              <ul className="mt-2 list-disc pl-5 text-xs text-red-800" aria-label="Rules it breaks">
                {move.violations.map(violation => (
                  <li key={violation}>{violation}</li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </Modal>
  );
}
