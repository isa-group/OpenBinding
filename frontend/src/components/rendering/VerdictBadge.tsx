import { Badge } from '../ui/Badge';
import './VerdictBadge.css';

interface VerdictBadgeProps {
  verdict: 'OPTIMAL' | 'FEASIBLE' | 'UNSAT' | 'TIMEOUT' | 'INCOMPATIBLE' | (string & {});
  reasons?: string[];
  size?: 'sm' | 'md';
}

const KNOWN: Record<string, { variant: 'success' | 'info' | 'error' | 'warning' | 'default'; description: string }> = {
  OPTIMAL: { variant: 'success', description: 'proven best combination' },
  FEASIBLE: { variant: 'info', description: 'a valid combination, not proven best' },
  UNSAT: { variant: 'error', description: 'no combination satisfies the rules' },
  TIMEOUT: { variant: 'warning', description: 'stopped at the time budget' },
  INCOMPATIBLE: { variant: 'default', description: 'the engine cannot solve this problem' },
};

/** The outcome of a solve as text in a badge, with a plain-language description for assistive technology. */
// [impl->req~frontend-rendering-verdict-badge~1]
export function VerdictBadge({ verdict, reasons = [], size = 'sm' }: VerdictBadgeProps) {
  const known = Object.hasOwn(KNOWN, verdict) ? KNOWN[verdict] : undefined;

  return (
    <div className="rendering-verdict">
      <span>
        <Badge variant={known?.variant ?? 'default'} size={size}>{verdict}</Badge>
        {known && <span className="sr-only">, {known.description}</span>}
      </span>
      {reasons.length > 0 && (
        <ul aria-label="Reasons" className="rendering-verdict__reasons">
          {reasons.map((reason, i) => <li key={i}>{reason}</li>)}
        </ul>
      )}
    </div>
  );
}
