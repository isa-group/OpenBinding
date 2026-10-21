import type { ReactNode } from 'react';
import type { Organization, Project } from '../../api/platform';
import { ProjectTabs, type ProjectSection } from '../../components/PlatformShell/ProjectTabs';
import { Breadcrumb, type Crumb } from '../Organization/parts';
import '../Project/Project.css';
import '../Cases/Cases.css';
import '../Library/Library.css';
import './Resources.css';

interface ResourceFrameProps {
  organization: Organization;
  project: Project;
  /** The project tab that is open: the files, or the library (collections and resources live under it). */
  section: Extract<ProjectSection, 'files' | 'library'>;
  /** The crumbs below the project; the last one is where you are. */
  trail: Crumb[];
  width?: 'md' | 'lg' | 'wide';
  children: ReactNode;
}

/** The frame of the files, resources and collections: breadcrumb, project tabs and one live content column. */
export function ResourceFrame({ organization, project, section, trail, width = 'wide', children }: ResourceFrameProps) {
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
      <ProjectTabs active={section} orgSlug={organization.slug} projectSlug={project.slug} access={project.access} />
      <div className={`proj-body is-${width}`} aria-live="polite">{children}</div>
    </div>
  );
}

interface MeterProps {
  label: string;
  /** 0 to 100. */
  percent: number;
  /** What the figure means in words, for assistive technology. */
  valueText: string;
  full?: boolean;
}

/** A thin bar for an allowance. It is a meter: it measures a quantity inside a known range. */
export function Meter({ label, percent, valueText, full = false }: MeterProps) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div className={`res-meter${full ? ' is-full' : ''}`} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={clamped} aria-valuetext={valueText}>
      <i style={{ width: `${clamped}%` }} />
    </div>
  );
}
