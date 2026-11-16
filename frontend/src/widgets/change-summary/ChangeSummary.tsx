// Design follows SPHERE frontend/src/modules/pricing/components/pricing-version-graph/change-summary-card.tsx (revision 73779a8a); no code copied
import { Gauge, Link2, Settings2, Tag, type LucideIcon } from 'lucide-react';
import { notComparableShort } from '../../entities/composition/changes';
import { formatNumber } from '../../entities/composition/values';
import type { SectionChanges } from '../../shared/sphere/change-summary';
import type { ChangesState } from './useVersionChanges';
import './ChangeSummary.css';

const SECTION_ICONS: Record<SectionChanges['key'], LucideIcon> = { binding: Link2, values: Gauge, offering: Tag };

/** Names shown under a section before "+N more". */
const NAMES_SHOWN = 3;

const DATE = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });

type Kind = 'added' | 'removed' | 'changed';
const SIGN: Record<Kind, string> = { added: '+', removed: '−', changed: '~' };

function Count({ kind, value }: { kind: Kind; value: number }) {
  if (value === 0) return null;
  return <span className={`cs-count is-${kind}`}>{SIGN[kind]}{value}<span className="sr-only"> {kind}</span></span>;
}

function SectionRow({ section }: { section: SectionChanges }) {
  const Icon = SECTION_ICONS[section.key];
  const names = [
    ...section.added.map((name) => ({ name, kind: 'added' as const })),
    ...section.removed.map((name) => ({ name, kind: 'removed' as const })),
    ...section.changed.map((name) => ({ name, kind: 'changed' as const })),
  ];
  const hidden = names.length - NAMES_SHOWN;
  return (
    <li className="cs-section">
      <span className="cs-section-head">
        <Icon aria-hidden="true" />
        <span className="cs-section-label">{section.label}</span>
        <Count kind="added" value={section.added.length} />
        <Count kind="removed" value={section.removed.length} />
        <Count kind="changed" value={section.changed.length} />
      </span>
      <span className="cs-names">
        {names.slice(0, NAMES_SHOWN).map(({ name, kind }, index) => (
          <span key={`${kind}:${name}`}>
            {index > 0 && ', '}
            <span className={`cs-sign is-${kind}`} aria-hidden="true">{SIGN[kind]}</span>
            <span className="sr-only">{kind} </span>
            {name}
          </span>
        ))}
        {hidden > 0 && ` +${hidden} more`}
      </span>
    </li>
  );
}

const candidateText = (candidate: string | null) => candidate ?? 'local';
const numberText = (value: number | null) => (value === null ? 'not set' : formatNumber(value));

interface ChangeSummaryProps {
  state: ChangesState;
  /** "Changes since 1.0.0". */
  heading?: string;
  /** When the later version was sealed. */
  createdAt?: string | null;
}

/**
 * What a version changed, inline: the binding, values and offering entries added (+), removed (−) or changed (~), the tasks
 * whose candidate moved, the values whose number moved (only when the gateway compared them), why it did not compare them, and
 * other fields. Every word comes from the gateway's diff.
 */
export function ChangeSummary({ state, heading, createdAt = null }: ChangeSummaryProps) {
  const sealed = createdAt && !Number.isNaN(Date.parse(createdAt)) ? DATE.format(new Date(createdAt)) : null;
  return (
    <div className="cs">
      {(heading || sealed) && (
        <p className="cs-heading">
          {heading && <span>{heading}</span>}
          {sealed && <span className="cs-date">Sealed {sealed}</span>}
        </p>
      )}
      {state.status === 'idle' || state.status === 'loading' ? (
        <p className="cs-note" role="status">Comparing…</p>
      ) : state.status === 'error' ? (
        <p className="cs-note">Could not compare these versions.</p>
      ) : state.summary.isEmpty ? (
        <p className="cs-note">No changes.</p>
      ) : (
        <>
          <ul className="cs-sections">
            {state.summary.sections.map((section) => <SectionRow key={section.key} section={section} />)}
          </ul>
          {state.summary.candidateChanges.length > 0 && (
            <ul className="cs-lines" aria-label="Candidate changes">
              {state.summary.candidateChanges.map((change) => (
                <li key={change.task}>
                  <code>{change.task}</code>: <code>{candidateText(change.before)}</code> → <code>{candidateText(change.after)}</code>
                </li>
              ))}
            </ul>
          )}
          {state.summary.valueChanges.length > 0 && (
            <ul className="cs-lines" aria-label="Value changes">
              {state.summary.valueChanges.map((change) => (
                <li key={change.name}>{change.name}: {numberText(change.before)} → {numberText(change.after)}</li>
              ))}
            </ul>
          )}
          {state.summary.otherFields > 0 && (
            <p className="cs-other">
              <Settings2 aria-hidden="true" />
              {state.summary.otherFields} other {state.summary.otherFields === 1 ? 'field' : 'fields'} changed
            </p>
          )}
        </>
      )}
      {state.status === 'ready' && !state.summary.comparison.comparable && (
        <p className="cs-not-comparable">Not comparable: {notComparableShort(state.summary.comparison)}</p>
      )}
    </div>
  );
}
