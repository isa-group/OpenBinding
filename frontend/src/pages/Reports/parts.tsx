import type { ReactNode } from 'react';
import type { Organization, Project } from '../../api/platform';
import { ProjectTabs } from '../../components/PlatformShell/ProjectTabs';
import { Breadcrumb, type Crumb } from '../Organization/parts';
import '../Project/Project.css';
import '../Jobs/Jobs.css';
import './Reports.css';

interface ReportFrameProps {
  organization: Organization;
  project: Project;
  /** The crumbs below the project: the screen, last, is where you are. */
  trail: Crumb[];
  width?: 'md' | 'lg' | 'wide';
  children: ReactNode;
}

/** The frame of the project's publications screen: breadcrumb, the project tabs with Publications current, and one live content column. */
export function ReportFrame({ organization, project, trail, width = 'wide', children }: ReportFrameProps) {
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
      <ProjectTabs active="publications" orgSlug={organization.slug} projectSlug={project.slug} access={project.access} />
      <div className={`proj-body rp-body is-${width}`} aria-live="polite">{children}</div>
    </div>
  );
}
