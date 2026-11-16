// Design follows SPHERE frontend/src/modules/pricing-editor/components/problems-panel/index.tsx (revision 73779a8a); no code copied
import { useId, useState } from 'react';
import { ChevronDown, CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';
import {
  byLocation,
  counts,
  locatedKey,
  type Counts,
  type Located,
  type Severity,
} from '../../diagnostics/located';
import './ProblemsPanel.css';

interface ProblemsPanelProps {
  /** The gateway's findings, located (`fromC2y`, `fromBim`). The panel orders them by place. */
  diagnostics: readonly Located[];
  /** Jumps to a finding. Without it the list is read-only, as in the catalog. */
  onSelect?: (diagnostic: Located) => void;
  /** Lists the findings under a heading per file, with those about the whole package last (a BIM package). */
  groups?: boolean;
  title?: string;
}

const SEVERITY: Record<Severity, { word: string; Icon: typeof CircleAlert }> = {
  error: { word: 'Error', Icon: CircleAlert },
  warning: { word: 'Warning', Icon: TriangleAlert },
  info: { word: 'Info', Icon: Info },
};

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** The counts in words: "2 errors, 1 warning", or "No issues". */
function countsText(tally: Counts): string {
  if (tally.total === 0) return 'No issues';
  const parts: string[] = [];
  if (tally.error) parts.push(plural(tally.error, 'error', 'errors'));
  if (tally.warning) parts.push(plural(tally.warning, 'warning', 'warnings'));
  if (tally.info) parts.push(plural(tally.info, 'note', 'notes'));
  return parts.join(', ');
}

/** Where a finding is, in words. */
function placeText(diagnostic: Located): string {
  const { where } = diagnostic;
  switch (where.kind) {
    case 'text':
      return `Line ${where.line}, column ${where.column}`;
    case 'bpmn':
      return `Diagram element ${where.element}`;
    case 'file':
      return where.file;
    case 'package':
      return 'Package';
  }
}

const groupOf = (diagnostic: Located) =>
  diagnostic.where.kind === 'package' ? 'Package' : diagnostic.where.file;

function Finding({
  diagnostic,
  onSelect,
}: {
  diagnostic: Located;
  onSelect?: (diagnostic: Located) => void;
}) {
  const { word, Icon } = SEVERITY[diagnostic.severity];
  const body = (
    <>
      <Icon className="pp-icon" aria-hidden="true" />
      <span className="pp-text">
        <span className="pp-message">
          <span className="sr-only">{word}: </span>
          {diagnostic.message}
        </span>
        <span className="pp-meta">
          <span className="pp-place">{placeText(diagnostic)}</span>
          {diagnostic.path && <code>{diagnostic.path}</code>}
          <code className="pp-code">{diagnostic.code}</code>
        </span>
      </span>
    </>
  );
  return onSelect ? (
    <button
      type="button"
      className={`pp-item is-${diagnostic.severity}`}
      onClick={() => onSelect(diagnostic)}
    >
      {body}
    </button>
  ) : (
    <div className={`pp-item is-${diagnostic.severity}`}>{body}</div>
  );
}

/** One React key per finding: the stable key, numbered when the same finding is reported twice. */
function keyed(diagnostics: readonly Located[]): Array<{ key: string; diagnostic: Located }> {
  const seen = new Map<string, number>();
  return diagnostics.map(diagnostic => {
    const key = locatedKey(diagnostic);
    const repeat = seen.get(key) ?? 0;
    seen.set(key, repeat + 1);
    return { key: repeat ? `${key}#${repeat}` : key, diagnostic };
  });
}

/**
 * Every finding of the last check, the way an IDE's Problems view lists them: a header with the counts that folds the
 * list, and one entry per finding with its place, path and code. With `onSelect` each entry is a button that jumps there.
 */
export function ProblemsPanel({
  diagnostics,
  onSelect,
  groups = false,
  title = 'Problems',
}: ProblemsPanelProps) {
  const [expanded, setExpanded] = useState(true);
  const listId = useId();
  const ordered = keyed(byLocation(diagnostics));
  const tally = counts(diagnostics);
  const summary = countsText(tally);
  const clean = tally.total === 0;

  const items = (entries: typeof ordered) =>
    entries.map(({ key, diagnostic }) => (
      <li key={key}>
        <Finding diagnostic={diagnostic} onSelect={onSelect} />
      </li>
    ));

  const grouped: Array<{ name: string; entries: typeof ordered }> = [];
  if (groups) {
    for (const entry of ordered) {
      const name = groupOf(entry.diagnostic);
      const last = grouped[grouped.length - 1];
      if (last?.name === name) last.entries.push(entry);
      else grouped.push({ name, entries: [entry] });
    }
  }

  return (
    <section className="pp" aria-label={title}>
      <button
        type="button"
        className="pp-head"
        aria-expanded={expanded}
        aria-controls={listId}
        onClick={() => setExpanded(open => !open)}
      >
        <span className="pp-title">{title}</span>
        <span className="pp-counts">
          {clean ? (
            <span className="pp-count is-clean">
              <CircleCheck aria-hidden="true" />
              No issues
            </span>
          ) : (
            <>
              {tally.error > 0 && (
                <span className="pp-count is-error">
                  <CircleAlert aria-hidden="true" />
                  {plural(tally.error, 'error', 'errors')}
                </span>
              )}
              {tally.warning > 0 && (
                <span className="pp-count is-warning">
                  <TriangleAlert aria-hidden="true" />
                  {plural(tally.warning, 'warning', 'warnings')}
                </span>
              )}
              {tally.info > 0 && (
                <span className="pp-count is-info">
                  <Info aria-hidden="true" />
                  {plural(tally.info, 'note', 'notes')}
                </span>
              )}
            </>
          )}
        </span>
        <ChevronDown className={`pp-chevron${expanded ? ' is-open' : ''}`} aria-hidden="true" />
      </button>
      <p className="sr-only" aria-live="polite">
        {summary}
      </p>
      <div id={listId} className="pp-body" hidden={!expanded || clean}>
        {groups ? (
          <ul className="pp-list">
            {grouped.map(group => (
              <li key={group.name} className="pp-group">
                <span className="pp-group-name">{group.name}</span>
                <ul className="pp-list">{items(group.entries)}</ul>
              </li>
            ))}
          </ul>
        ) : (
          <ul className="pp-list">{items(ordered)}</ul>
        )}
      </div>
    </section>
  );
}
