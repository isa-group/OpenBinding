import { useId } from 'react';
import { Badge } from '../ui/Badge';
import './DiagnosticsList.css';

export interface Diagnostic {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  resource?: string;
  pointer?: string;
  hint?: string;
}

interface DiagnosticsListProps {
  diagnostics: Diagnostic[];
  headingLevel?: 2 | 3 | 4 | 5;
}

const RANK = { error: 0, warning: 1, info: 2 } as const;

function summary(diagnostics: Diagnostic[]): string {
  const parts: string[] = [];
  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = diagnostics.filter((d) => d.severity === 'warning').length;
  const infos = diagnostics.filter((d) => d.severity === 'info').length;
  if (errors) parts.push(`${errors} ${errors === 1 ? 'error' : 'errors'}`);
  if (warnings) parts.push(`${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`);
  if (infos) parts.push(`${infos} info`);
  return parts.join(', ');
}

/** Diagnostics grouped by resource, most severe first. Severity is always text, never colour alone. */
// [impl->req~frontend-rendering-diagnostics-list~1]
export function DiagnosticsList({ diagnostics, headingLevel = 3 }: DiagnosticsListProps) {
  const base = useId();
  const Heading = `h${headingLevel}` as const;
  const sorted = [...diagnostics].sort((a, b) => RANK[a.severity] - RANK[b.severity]);
  const groups = new Map<string | null, Diagnostic[]>();
  for (const d of sorted) {
    const key = d.resource || null;
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }
  // Inside a resource, items with the same pointer stay together, in order of first appearance.
  for (const [key, items] of groups) {
    const byPointer = new Map<string | null, Diagnostic[]>();
    for (const d of items) {
      const p = d.pointer || null;
      byPointer.set(p, [...(byPointer.get(p) ?? []), d]);
    }
    groups.set(key, [...byPointer.values()].flat());
  }

  return (
    <div className="rendering-diagnostics">
      <p role="status" className="rendering-diagnostics__summary">{summary(diagnostics) || 'No diagnostics'}</p>
      {[...groups].map(([resource, items], g) => (
        <section key={resource ?? ''} aria-labelledby={`${base}-${g}`} className="rendering-diagnostics__group">
          <Heading id={`${base}-${g}`}>{resource ?? 'General'}</Heading>
          <ul>
            {items.map((d, i) => (
              <li key={i} className="rendering-diagnostics__item">
                <Badge variant={d.severity}>{d.severity}</Badge> <code>{d.code}</code>
                <span className="rendering-diagnostics__message">{d.message}</span>
                {d.pointer && (
                  <span className="rendering-diagnostics__meta">
                    <span>Pointer</span> <code>{d.pointer}</code>
                  </span>
                )}
                {d.hint && <span className="rendering-diagnostics__meta">Hint: {d.hint}</span>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
