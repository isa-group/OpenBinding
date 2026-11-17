// Adapted from SPHERE frontend/src/modules/pricing-editor/components/problems-panel/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: an adapter's findings (core/diagnostics/located: the gateway's `c2y_*` and BIM diagnostics) instead of the
// Pricing2Yaml linter's, counted by the panel, so there is no separate list of parser errors; a finding's place may be a
// line, a diagram element, a file or the whole package, and only a finding with a place to jump to is a button (none without
// `onSelect`, as in the catalog); findings can be grouped by file; the counts are said in words, also in a polite live region,
// and each entry says its severity to assistive technology; a light tone for the pages outside the dark editors.

import { AnimatePresence, motion } from 'framer-motion';
import { useId, useState, type ReactElement } from 'react';
import {
  FiAlertCircle,
  FiAlertTriangle,
  FiCheckCircle,
  FiChevronDown,
  FiInfo,
} from 'react-icons/fi';
import {
  byLocation,
  counts,
  locatedKey,
  type Counts,
  type Located,
  type Severity,
} from '../../diagnostics/located';

interface ProblemsPanelProps {
  /** The gateway's findings, located (`fromC2y`, `fromBim`). The panel orders them by place. */
  diagnostics: readonly Located[];
  /** Jumps to a finding. Without it the list is read-only, as in the catalog. */
  onSelect?: (diagnostic: Located) => void;
  /** Lists the findings under a heading per file, with those about the whole package last (a BIM package). */
  groups?: boolean;
  title?: string;
  /** `dark` under the editors' code (SPHERE's), `light` on the other pages. */
  tone?: 'dark' | 'light';
}

const TONES = {
  dark: {
    frame: 'border-t border-white/10 bg-tp-surface-code',
    head: 'hover:bg-white/5',
    title: 'text-white/60',
    chevron: 'text-white/40',
    list: 'border-t border-white/5',
    item: 'hover:bg-white/5',
    message: 'text-white/80',
    meta: 'text-white/45',
    group: 'text-white/45',
    clean: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300',
    error: 'border-red-400/20 bg-red-400/10 text-red-300',
    warning: 'border-amber-400/20 bg-amber-400/10 text-amber-300',
    info: 'border-sky-400/20 bg-sky-400/10 text-sky-300',
    icon: { error: 'text-red-400', warning: 'text-amber-400', info: 'text-sky-400' },
    place: { error: 'text-red-300', warning: 'text-amber-300', info: 'text-sky-300' },
  },
  light: {
    frame: 'rounded-xl border border-tp-hairline bg-tp-canvas',
    head: 'rounded-xl hover:bg-tp-surface',
    title: 'text-tp-slate',
    chevron: 'text-tp-steel',
    list: 'border-t border-tp-hairline',
    item: 'hover:bg-tp-surface',
    message: 'text-tp-ink',
    meta: 'text-tp-steel',
    group: 'text-tp-steel',
    clean: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    error: 'border-red-200 bg-red-50 text-red-800',
    warning: 'border-amber-200 bg-amber-50 text-amber-900',
    info: 'border-sky-200 bg-sky-50 text-sky-800',
    icon: { error: 'text-red-600', warning: 'text-amber-600', info: 'text-sky-600' },
    place: { error: 'text-red-700', warning: 'text-amber-800', info: 'text-sky-700' },
  },
} as const;

type Tone = (typeof TONES)[keyof typeof TONES];

const SEVERITY: Record<Severity, { word: string; Icon: typeof FiAlertCircle }> = {
  error: { word: 'Error', Icon: FiAlertCircle },
  warning: { word: 'Warning', Icon: FiAlertTriangle },
  info: { word: 'Info', Icon: FiInfo },
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

function Finding({
  diagnostic,
  onSelect,
  tone,
}: {
  diagnostic: Located;
  onSelect?: (diagnostic: Located) => void;
  tone: Tone;
}) {
  const { word, Icon } = SEVERITY[diagnostic.severity];
  const body = (
    <>
      <Icon
        className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${tone.icon[diagnostic.severity]}`}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1">
        <span className={`block text-xs leading-snug ${tone.message}`}>
          <span className="sr-only">{word}: </span>
          {diagnostic.message}
        </span>
        <span className={`mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] ${tone.meta}`}>
          <span className={tone.place[diagnostic.severity]}>{placeText(diagnostic)}</span>
          {diagnostic.path && <code className="font-mono">{diagnostic.path}</code>}
          <code className="font-mono opacity-80">{diagnostic.code}</code>
        </span>
      </span>
    </>
  );
  return onSelect ? (
    <button
      type="button"
      onClick={() => onSelect(diagnostic)}
      className={`flex w-full cursor-pointer items-start gap-2 px-3 py-1.5 text-left transition-colors ${tone.item}`}
    >
      {body}
    </button>
  ) : (
    <div className="flex items-start gap-2 px-3 py-1.5">{body}</div>
  );
}

/**
 * Lists every finding of the last check and lets the user jump to it, the way an IDE "Problems" view does: a header with the
 * counts that folds the list, and one entry per finding with its place, path and code.
 */
export default function ProblemsPanel({
  diagnostics,
  onSelect,
  groups = false,
  title = 'Problems',
  tone: toneName = 'light',
}: Readonly<ProblemsPanelProps>): ReactElement {
  const [isExpanded, setIsExpanded] = useState(true);
  const listId = useId();
  const tone = TONES[toneName];
  const ordered = keyed(byLocation(diagnostics));
  const tally = counts(diagnostics);
  const isClean = tally.total === 0;

  const items = (entries: typeof ordered) =>
    entries.map(({ key, diagnostic }) => (
      <li key={key}>
        <Finding diagnostic={diagnostic} onSelect={onSelect} tone={tone} />
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

  const pill =
    'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold tracking-wide';

  return (
    <section className={`flex min-w-0 shrink-0 flex-col ${tone.frame}`} aria-label={title}>
      <button
        type="button"
        onClick={() => setIsExpanded(current => !current)}
        className={`flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-left transition-colors ${tone.head}`}
        aria-expanded={isExpanded}
        aria-controls={listId}
      >
        <span className="flex flex-wrap items-center gap-2">
          <span className={`text-[11px] font-semibold tracking-[0.12em] uppercase ${tone.title}`}>
            {title}
          </span>
          {isClean ? (
            <span className={`${pill} ${tone.clean}`}>
              <FiCheckCircle className="h-3 w-3" aria-hidden="true" />
              No issues
            </span>
          ) : (
            <>
              {tally.error > 0 && (
                <span className={`${pill} ${tone.error}`}>
                  <FiAlertCircle className="h-3 w-3" aria-hidden="true" />
                  {plural(tally.error, 'error', 'errors')}
                </span>
              )}
              {tally.warning > 0 && (
                <span className={`${pill} ${tone.warning}`}>
                  <FiAlertTriangle className="h-3 w-3" aria-hidden="true" />
                  {plural(tally.warning, 'warning', 'warnings')}
                </span>
              )}
              {tally.info > 0 && (
                <span className={`${pill} ${tone.info}`}>
                  <FiInfo className="h-3 w-3" aria-hidden="true" />
                  {plural(tally.info, 'note', 'notes')}
                </span>
              )}
            </>
          )}
        </span>
        <motion.span animate={{ rotate: isExpanded ? 0 : 180 }} transition={{ duration: 0.2 }}>
          <FiChevronDown className={`h-4 w-4 ${tone.chevron}`} aria-hidden="true" />
        </motion.span>
      </button>
      <p className="sr-only" aria-live="polite">
        {countsText(tally)}
      </p>

      <div id={listId}>
        <AnimatePresence initial={false}>
          {isExpanded && !isClean && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className={`max-h-48 overflow-y-auto ${tone.list}`}
            >
              {groups ? (
                <ul>
                  {grouped.map(group => (
                    <li key={group.name} data-group={group.name}>
                      <span
                        className={`block px-3 pt-2 pb-0.5 font-mono text-[10px] font-semibold ${tone.group}`}
                      >
                        {group.name}
                      </span>
                      <ul>{items(group.entries)}</ul>
                    </li>
                  ))}
                </ul>
              ) : (
                <ul>{items(ordered)}</ul>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
}
