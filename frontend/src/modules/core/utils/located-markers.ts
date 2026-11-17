// The gateway's findings as Monaco markers: what draws the squiggles and the hover messages over the text, as SPHERE's
// Pricing2Yaml editor publishes its linter's diagnostics (`setModelMarkers`, frontend/src/modules/pricing-editor/pages/
// pricing2yaml-editor/index.tsx, revision 73779a8a). Here the findings are OpenBinding's located diagnostics (diagnostics/
// located.ts): only those placed in the text become markers; a finding about a whole file, a diagram element or the
// package has no place in a text editor and stays in the problems panel.

import type { Located, Severity } from '../diagnostics/located';

/** Monaco's marker severities (`monaco.MarkerSeverity`), by value, so this module needs no Monaco to run. */
export const MARKER_SEVERITY = { hint: 1, info: 2, warning: 4, error: 8 } as const;

export interface LocatedMarker {
  severity: number;
  message: string;
  code: string;
  source: string;
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

const SEVERITY: Record<Severity, number> = {
  error: MARKER_SEVERITY.error,
  warning: MARKER_SEVERITY.warning,
  info: MARKER_SEVERITY.info,
};

/** The one-based line and column of a UTF-16 offset of `text`, as Monaco counts positions. */
export function positionAt(text: string, offset: number): { lineNumber: number; column: number } {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let lineNumber = 1;
  let lineStart = 0;
  for (let index = 0; index < clamped; index += 1) {
    if (text[index] === '\n') {
      lineNumber += 1;
      lineStart = index + 1;
    }
  }
  return { lineNumber, column: clamped - lineStart + 1 };
}

/**
 * The markers of the findings placed in `text` of `file`. An empty span (a missing key, say) is widened to the character
 * after it, or the one before it at the end of a line, so the squiggle shows.
 */
export function locatedMarkers(
  diagnostics: readonly Located[],
  text: string,
  file: string,
  source: string
): LocatedMarker[] {
  return diagnostics.flatMap(diagnostic => {
    const where = diagnostic.where;
    if (where.kind !== 'text' || where.file !== file) return [];
    let { from, to } = where;
    if (to <= from) {
      if (from < text.length && text[from] !== '\n') to = from + 1;
      else if (from > 0) from -= 1;
    }
    const start = positionAt(text, from);
    const end = positionAt(text, Math.max(from, to));
    return [
      {
        severity: SEVERITY[diagnostic.severity],
        message: diagnostic.message,
        code: diagnostic.code,
        source,
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: end.lineNumber,
        endColumn: end.column,
      },
    ];
  });
}
