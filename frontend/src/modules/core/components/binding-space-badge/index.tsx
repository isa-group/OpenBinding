import React, { useMemo } from 'react';
import { MdAutoAwesome, MdLayers } from 'react-icons/md';
import { parseBindingSpace } from './bindingSpace';

export interface BindingSpaceBadgeProps {
  cardinality: string | number;
  breakdown?: Record<string, number>;
  variant?: 'badge' | 'card' | 'inline';
  showScale?: boolean;
  className?: string;
}

type Tier = ReturnType<typeof parseBindingSpace>['tier'];

/** The colours of a tier: calm for small spaces, warmer as the space grows. Text always uses the deeper shade of the hue. */
const TIER: Record<Tier, { text: string; dot: string; border: string; bar: string; soft: string }> =
  {
    micro: {
      text: 'text-tp-success-strong',
      dot: 'bg-tp-success-strong',
      border: 'border-tp-severity-success-border',
      bar: 'before:bg-tp-success-strong',
      soft: 'bg-tp-severity-success-bg',
    },
    small: {
      text: 'text-tp-accent',
      dot: 'bg-tp-accent',
      border: 'border-tp-accent/35',
      bar: 'before:bg-tp-accent',
      soft: 'bg-tp-cream',
    },
    medium: {
      text: 'text-tp-accent-hover',
      dot: 'bg-tp-accent-hover',
      border: 'border-tp-accent-hover/35',
      bar: 'before:bg-tp-accent-hover',
      soft: 'bg-tp-cream',
    },
    large: {
      text: 'text-tp-warning-strong',
      dot: 'bg-tp-warning-strong',
      border: 'border-tp-severity-warning-border',
      bar: 'before:bg-tp-warning-strong',
      soft: 'bg-tp-severity-warning-bg',
    },
    massive: {
      text: 'text-tp-error-strong',
      dot: 'bg-tp-error-strong',
      border: 'border-tp-severity-error-border',
      bar: 'before:bg-tp-error-strong',
      soft: 'bg-tp-severity-error-bg',
    },
  };

const TOOLTIP =
  'invisible absolute top-[calc(100%+8px)] right-0 z-20 -translate-y-1 rounded-md border border-tp-hairline bg-tp-canvas px-3.5 py-2.5 text-left font-body opacity-0 shadow-elevation-3 transition-all group-hover:visible group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:visible group-focus-visible:translate-y-0 group-focus-visible:opacity-100';

function Meter({ tier, dots }: { tier: Tier; dots: number }) {
  return (
    <div className="ml-1 flex items-center gap-0.5" aria-hidden="true">
      {[1, 2, 3, 4].map(dot => (
        <span
          key={dot}
          className={`h-1 w-1 rounded-full ${dot <= dots ? TIER[tier].dot : 'bg-tp-hairline'}`}
        />
      ))}
    </div>
  );
}

export const BindingSpaceBadge: React.FC<BindingSpaceBadgeProps> = ({
  cardinality,
  breakdown,
  variant = 'badge',
  showScale = true,
  className = '',
}) => {
  const parsed = useMemo(() => parseBindingSpace(cardinality), [cardinality]);
  const tone = TIER[parsed.tier];

  const tooltip = (wide: boolean) => (
    <div
      className={`${TOOLTIP} ${wide ? 'left-0 w-full' : 'max-w-[340px] min-w-[240px]'}`}
      role="tooltip"
    >
      <div className="mb-1.5 flex items-center justify-between border-b border-tp-hairline pb-1">
        <span className={`text-[11px] font-bold tracking-wide uppercase ${tone.text}`}>
          Binding Space
        </span>
        <span
          className={`rounded px-1.5 py-px text-[10px] font-semibold ${tone.soft} ${tone.text}`}
        >
          {parsed.tierLabel}
        </span>
      </div>
      <div className="mb-1 font-mono text-[13px] font-bold break-all text-tp-ink">
        {parsed.exact} combinations
      </div>
      <div className="text-xs leading-snug text-tp-slate">
        Combinatorial search space (∏ |candidates(t)|). Order of magnitude ≈ 10
        <sup>{parsed.log10.toFixed(2)}</sup>.
        {breakdown && Object.keys(breakdown).length > 0 && (
          <div className="mt-1.5 border-t border-tp-hairline pt-1">
            <strong>Tasks ({Object.keys(breakdown).length}): </strong>
            {Object.entries(breakdown)
              .slice(0, 5)
              .map(([t, count]) => `${t}:${count}`)
              .join(' × ')}
            {Object.keys(breakdown).length > 5 ? ' …' : ''}
          </div>
        )}
      </div>
    </div>
  );

  if (variant === 'card') {
    return (
      <article
        className={`group relative grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-xl border border-tp-hairline bg-tp-canvas px-4 py-3 transition-colors before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:rounded-l-xl hover:border-tp-stone focus-visible:border-tp-stone ${tone.bar} ${className}`}
        data-tier={parsed.tier}
        tabIndex={0}
      >
        <div className={`flex items-center ${tone.text}`} aria-hidden="true">
          <MdLayers className="h-4 w-4" />
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="font-mono text-[10px] tracking-wider text-tp-steel uppercase">
            Binding Space
          </span>
          <strong className="text-xl font-semibold text-tp-ink">{parsed.formatted}</strong>
          <span className="text-xs text-tp-slate">{parsed.exact} candidate combinations</span>
        </div>
        {showScale && (
          <div title={`Scale tier: ${parsed.tierLabel}`}>
            <Meter tier={parsed.tier} dots={parsed.dots} />
          </div>
        )}
        {tooltip(true)}
      </article>
    );
  }

  return (
    <div
      className={`group relative inline-flex cursor-help items-center gap-2 rounded-full border bg-tp-canvas px-2.5 py-1 font-mono text-xs font-semibold tracking-tight select-none ${tone.border} ${className}`}
      data-tier={parsed.tier}
      tabIndex={0}
      role="status"
      aria-label={`Binding space size: ${parsed.formatted} combinations (${parsed.tierLabel})`}
    >
      <span className={`flex items-center ${tone.text}`} aria-hidden="true">
        {parsed.tier === 'massive' ? (
          <MdAutoAwesome className="h-3.5 w-3.5" />
        ) : (
          <MdLayers className="h-3.5 w-3.5" />
        )}
      </span>
      <span className="text-[10px] tracking-wide text-tp-steel uppercase">Space</span>
      <span className="font-bold text-tp-ink">{parsed.formatted}</span>
      {showScale && <Meter tier={parsed.tier} dots={parsed.dots} />}
      {tooltip(false)}
    </div>
  );
};
