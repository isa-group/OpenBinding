import type { ReactNode } from 'react';
import type { Organization, Project, StudyCell } from '../../api/platform';
import { ProjectTabs } from '../../components/PlatformShell/ProjectTabs';
import { Breadcrumb, Gate, type Crumb } from '../Organization/parts';
import { stateWord, countStates, breakdownText } from './studiesModel';
import '../Project/Project.css';
import '../Jobs/Jobs.css';
import './Studies.css';

interface StudyFrameProps {
  organization: Organization;
  project: Project;
  /** The crumbs below the project: `Studies`, then the screen. The last one is where you are. */
  trail: Crumb[];
  width?: 'md' | 'lg' | 'wide';
  children: ReactNode;
}

/** The frame of every project screen about studies: breadcrumb, the project tabs with Studies current, and one live content column. */
export function StudyFrame({ organization, project, trail, width = 'wide', children }: StudyFrameProps) {
  const root = `/app/${organization.slug}/${project.slug}`;
  const items: Crumb[] = [
    { label: 'Home', to: '/app' },
    { label: organization.name, to: `/app/${organization.slug}` },
    { label: project.name, to: root },
    ...trail,
  ];
  return (
    <div className="proj-frame">
      <div className="proj-band">
        <div className="proj-band-inner"><Breadcrumb items={items} /></div>
      </div>
      <ProjectTabs active="studies" orgSlug={organization.slug} projectSlug={project.slug} access={project.access} />
      <div className={`proj-body st-body is-${width}`} aria-live="polite">{children}</div>
    </div>
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
