// Adapted from SPHERE frontend/src/modules/pricing/components/pricing-version-graph/change-summary-card.tsx
// (revision 73779a8a), https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: a composition's sections (binding, values, offering) from the gateway's diff instead of a pricing's plans,
// features, add-ons and usage limits; the tasks whose candidate moved and the values whose number moved instead of new
// prices; why the values were not compared, when they were not. A version is only ever compared with the one before it.

import { format, parseISO } from 'date-fns';
import type { IconType } from 'react-icons';
import { FiLink, FiSettings, FiSliders, FiTag, FiRepeat } from 'react-icons/fi';
import { notComparableShort } from '../../../core/utils/composition/changes';
import { formatNumber } from '../../../core/utils/composition/values';
import type { SectionChanges } from '../../../core/utils/sphere/change-summary';
import type { ChangesState } from './useVersionChanges';

const SECTION_ICONS: Record<SectionChanges['key'], IconType> = {
  binding: FiLink,
  values: FiSliders,
  offering: FiTag,
};

/** Names shown under a section before "+N more". */
const NAMES_SHOWN = 3;

interface ChangeSummaryCardProps {
  compositionName: string;
  version: string;
  createdAt: string | null;
  /** "Changes since 1.0.0". */
  heading: string;
  /** Nothing to compare with. */
  firstVersion: boolean;
  state: ChangesState;
  /** Where its top centre goes, inside the graph. */
  left: number;
  top: number;
}

function Count({ sign, value, className }: { sign: string; value: number; className: string }) {
  if (value === 0) return null;
  return (
    <span className={`font-mono text-[11px] font-semibold tabular-nums ${className}`}>
      {sign}
      {value}
    </span>
  );
}

function SectionRow({ section }: { section: SectionChanges }) {
  const Icon = SECTION_ICONS[section.key];
  const names = [
    ...section.added.map(name => ({ name, sign: '+', className: 'text-emerald-700' })),
    ...section.removed.map(name => ({ name, sign: '−', className: 'text-red-700' })),
    ...section.changed.map(name => ({ name, sign: '~', className: 'text-amber-800' })),
  ];
  const hidden = names.length - NAMES_SHOWN;
  return (
    <li className="py-1">
      <div className="flex items-center gap-2">
        <Icon className="h-3.5 w-3.5 shrink-0 text-tp-steel" aria-hidden="true" />
        <span className="min-w-0 flex-1 text-xs font-medium text-tp-ink">{section.label}</span>
        <span className="flex items-center gap-1.5">
          <Count sign="+" value={section.added.length} className="text-emerald-700" />
          <Count sign="−" value={section.removed.length} className="text-red-700" />
          <Count sign="~" value={section.changed.length} className="text-amber-800" />
        </span>
      </div>
      <p className="ml-5.5 truncate text-[11px] leading-4 text-tp-steel">
        {names.slice(0, NAMES_SHOWN).map(({ name, sign, className }, index) => (
          <span key={`${sign}${name}`}>
            {index > 0 && ', '}
            <span className={className}>{sign}</span>
            {name}
          </span>
        ))}
        {hidden > 0 && ` +${hidden} more`}
      </p>
    </li>
  );
}

const candidateText = (candidate: string | null) => candidate ?? 'local';
const numberText = (value: number | null) => (value === null ? 'not set' : formatNumber(value));

/**
 * What a version of the graph changed since the one before it, shown while the viewer points at its dot: binding, values and
 * offering entries added (+), removed (−) or changed (~), the tasks whose candidate moved, the values whose number moved, and
 * other fields. Every word comes from the gateway's diff.
 */
export default function ChangeSummaryCard({
  compositionName,
  version,
  createdAt,
  heading,
  firstVersion,
  state,
  left,
  top,
}: ChangeSummaryCardProps) {
  return (
    <div
      role="tooltip"
      style={{ left, top }}
      className="pointer-events-none absolute z-30 w-72 -translate-x-1/2 rounded-xl border border-tp-hairline-strong bg-tp-canvas p-3 shadow-lg"
    >
      <p className="flex items-baseline gap-2 text-sm text-tp-ink">
        <span className="truncate font-medium">{compositionName}</span>
        <span className="shrink-0 font-mono">{version}</span>
        {createdAt && (
          <span className="ml-auto shrink-0 text-[11px] text-tp-steel">
            {format(parseISO(createdAt), 'PP')}
          </span>
        )}
      </p>
      <p className="mb-1.5 text-[11px] text-tp-steel">{heading}</p>

      {firstVersion ? null : state.status === 'loading' || state.status === 'idle' ? (
        <div className="space-y-1.5 py-1" aria-label="Comparing">
          <div className="h-3 w-3/4 animate-pulse rounded bg-tp-surface" />
          <div className="h-3 w-1/2 animate-pulse rounded bg-tp-surface" />
        </div>
      ) : state.status === 'error' ? (
        <p className="py-1 text-xs text-tp-steel">Could not compare this version.</p>
      ) : state.summary.isEmpty ? (
        <p className="py-1 text-xs text-tp-steel">No changes.</p>
      ) : (
        <>
          <ul className="divide-y divide-tp-hairline">
            {state.summary.sections.map(section => (
              <SectionRow key={section.key} section={section} />
            ))}
          </ul>
          {(state.summary.candidateChanges.length > 0 ||
            state.summary.valueChanges.length > 0 ||
            state.summary.otherFields > 0) && (
            <div className="mt-1 space-y-1 border-t border-tp-hairline pt-1.5 text-[11px] text-tp-slate">
              {state.summary.candidateChanges.length > 0 && (
                <p className="flex items-center gap-2">
                  <FiRepeat className="h-3.5 w-3.5 shrink-0 text-tp-steel" aria-hidden="true" />
                  <span className="truncate">
                    {state.summary.candidateChanges
                      .map(
                        change =>
                          `${change.task}: ${candidateText(change.before)} → ${candidateText(change.after)}`
                      )
                      .join(', ')}
                  </span>
                </p>
              )}
              {state.summary.valueChanges.length > 0 && (
                <p className="flex items-center gap-2">
                  <FiSliders className="h-3.5 w-3.5 shrink-0 text-tp-steel" aria-hidden="true" />
                  <span className="truncate">
                    {state.summary.valueChanges
                      .map(
                        change =>
                          `${change.name}: ${numberText(change.before)} → ${numberText(change.after)}`
                      )
                      .join(', ')}
                  </span>
                </p>
              )}
              {state.summary.otherFields > 0 && (
                <p className="flex items-center gap-2">
                  <FiSettings className="h-3.5 w-3.5 shrink-0 text-tp-steel" aria-hidden="true" />
                  {state.summary.otherFields} other{' '}
                  {state.summary.otherFields === 1 ? 'field' : 'fields'} changed
                </p>
              )}
            </div>
          )}
        </>
      )}
      {state.status === 'ready' && !state.summary.comparison.comparable && (
        <p className="mt-1 text-[11px] text-tp-steel">
          Not comparable: {notComparableShort(state.summary.comparison)}
        </p>
      )}
    </div>
  );
}
