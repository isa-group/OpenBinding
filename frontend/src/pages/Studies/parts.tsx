import type { ReactNode } from 'react';
import type { Organization, StudyCell } from '../../api/platform';
import { Gate, type Crumb } from '../Organization/parts';
import { OrgFrame } from '../../features/workspace/OrgFrame';
import { stateWord, countStates, breakdownText } from './studiesModel';
import '../../features/workspace/kit.css';
import '../Jobs/Jobs.css';
import './Studies.css';

interface StudyFrameProps {
  organization: Organization;
  /** The crumbs below the organization: `Studies`, then the screen. The last one is where you are. */
  trail: Crumb[];
  width?: 'md' | 'lg' | 'wide';
  children: ReactNode;
}

/** The frame of every screen about the studies of an organization: breadcrumb and one live content column. */
export function StudyFrame({ organization, trail, width = 'wide', children }: StudyFrameProps) {
  return (
    <OrgFrame organization={organization} trail={trail} width={width} bodyClassName="st-body">
      {children}
    </OrgFrame>
  );
}

/** Where a run or a cell stands: a dot and a word, coloured by how it went. */
export function StateChip({ state, label }: { state: string; label?: string }) {
  const word = stateWord(state);
  return (
    <span className={`proj-status job-status is-${word.tone}`}>
      <span className={`proj-dot is-${word.tone}`} aria-hidden="true" />
      {label ?? word.label}
    </span>
  );
}

const SEGMENTS = [
  { id: 'completed', label: 'completed' },
  { id: 'failed', label: 'failed' },
  { id: 'cancelled', label: 'cancelled' },
  { id: 'pending', label: 'in progress' },
] as const;

function bucketed(counts: Record<string, number>): Record<(typeof SEGMENTS)[number]['id'], number> {
  return {
    completed: counts.completed ?? 0,
    failed: counts.failed ?? 0,
    cancelled: counts.cancelled ?? 0,
    pending: (counts.queued ?? 0) + (counts.running ?? 0) + (counts.partial ?? 0),
  };
}

/** How the cells of a run ended, as one stacked bar. The words for assistive technology are the same figures. */
export function CellBar({ cells, size = 'md', legend = false, note }: { cells: readonly StudyCell[]; size?: 'sm' | 'md' | 'lg'; legend?: boolean; note?: string }) {
  const buckets = bucketed(countStates(cells));
  const total = cells.length;
  return (
    <div className="st-bar-wrap">
      <span className={`st-bar is-${size}`} role="img" aria-label={breakdownText(cells)}>
        {SEGMENTS.map((segment) => buckets[segment.id] > 0 && (
          <span key={segment.id} className={`is-${segment.id}`} style={{ width: `${(buckets[segment.id] / total) * 100}%` }} />
        ))}
      </span>
      {legend && (
        <span className="st-legend">
          {SEGMENTS.filter((segment) => buckets[segment.id] > 0).map((segment) => (
            <span key={segment.id}><i className={`is-${segment.id}`} aria-hidden="true" />{buckets[segment.id].toLocaleString('en-US')} {segment.label}</span>
          ))}
          {note && <span>{note}</span>}
        </span>
      )}
    </div>
  );
}

/** A card that says why a study, a run or a cell is not shown. */
export function StudyGate({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return <Gate title={title} action={action}>{children}</Gate>;
}
