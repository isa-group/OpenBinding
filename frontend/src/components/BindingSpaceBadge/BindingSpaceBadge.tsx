import React, { useMemo } from 'react';
import { Layers3, Sparkles } from 'lucide-react';
import { parseBindingSpace } from './bindingSpace';
import './BindingSpaceBadge.css';

export interface BindingSpaceBadgeProps {
  cardinality: string | number;
  breakdown?: Record<string, number>;
  variant?: 'badge' | 'card' | 'inline';
  showScale?: boolean;
  className?: string;
}

export const BindingSpaceBadge: React.FC<BindingSpaceBadgeProps> = ({
  cardinality,
  breakdown,
  variant = 'badge',
  showScale = true,
  className = '',
}) => {
  const parsed = useMemo(() => parseBindingSpace(cardinality), [cardinality]);

  const tooltipContent = (
    <div className="binding-space-tooltip" role="tooltip">
      <div className="binding-space-tooltip-header">
        <span className="binding-space-tooltip-title">Binding Space</span>
        <span className="binding-space-tooltip-tier">{parsed.tierLabel}</span>
      </div>
      <div className="binding-space-tooltip-exact">{parsed.exact} combinations</div>
      <div className="binding-space-tooltip-info">
        Combinatorial search space (∏ |candidates(t)|). Order of magnitude ≈ 10<sup>{parsed.log10.toFixed(2)}</sup>.
        {breakdown && Object.keys(breakdown).length > 0 && (
          <div style={{ marginTop: '0.35rem', paddingTop: '0.25rem', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
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
      <article className={`binding-space-card tier-${parsed.tier} ${className}`} tabIndex={0}>
        <div className="binding-space-icon" aria-hidden="true">
          <Layers3 />
        </div>
        <div className="binding-space-card-main">
          <span className="binding-space-card-title">Binding Space</span>
          <strong className="binding-space-card-val">{parsed.formatted}</strong>
          <span className="binding-space-card-desc">{parsed.exact} candidate combinations</span>
        </div>
        {showScale && (
          <div className="binding-space-meter" aria-hidden="true" title={`Scale tier: ${parsed.tierLabel}`}>
            {[1, 2, 3, 4].map((dot) => (
              <span
                key={dot}
                className={`binding-space-meter-dot ${dot <= parsed.dots ? 'is-active' : ''}`}
              />
            ))}
          </div>
        )}
        {tooltipContent}
      </article>
    );
  }

  return (
    <div
      className={`binding-space-badge tier-${parsed.tier} ${className}`}
      tabIndex={0}
      role="status"
      aria-label={`Binding space size: ${parsed.formatted} combinations (${parsed.tierLabel})`}
    >
      <span className="binding-space-icon" aria-hidden="true">
        {parsed.tier === 'massive' ? <Sparkles /> : <Layers3 />}
      </span>
      <span className="binding-space-label">Space</span>
      <span className="binding-space-value">{parsed.formatted}</span>
      {showScale && (
        <div className="binding-space-meter" aria-hidden="true">
          {[1, 2, 3, 4].map((dot) => (
            <span
              key={dot}
              className={`binding-space-meter-dot ${dot <= parsed.dots ? 'is-active' : ''}`}
            />
          ))}
        </div>
      )}
      {tooltipContent}
    </div>
  );
};
