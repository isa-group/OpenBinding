import { Link } from 'react-router-dom';
import './SectionNav.css';

export type ProjectSection = 'overview' | 'cases' | 'library' | 'jobs' | 'studies' | 'reports' | 'files' | 'package' | 'settings';

interface ProjectTabsProps {
  active?: ProjectSection;
  orgSlug: string;
  projectSlug: string;
}

const tabs: ReadonlyArray<{ key: ProjectSection; label: string; suffix: string }> = [
  { key: 'overview', label: 'Overview', suffix: '' },
  { key: 'cases', label: 'Cases', suffix: '/cases' },
  { key: 'library', label: 'Library', suffix: '/library' },
  { key: 'jobs', label: 'Jobs', suffix: '/jobs' },
  { key: 'studies', label: 'Studies', suffix: '/studies' },
  { key: 'reports', label: 'Reports', suffix: '/reports' },
  { key: 'files', label: 'Files', suffix: '/files' },
];

const trailing: ReadonlyArray<{ key: ProjectSection; label: string; suffix: string }> = [
  { key: 'package', label: 'Package', suffix: '/package' },
  { key: 'settings', label: 'Settings', suffix: '/settings' },
];

/** Section tabs shown at the top of every project screen. */
export function ProjectTabs({ active = 'overview', orgSlug, projectSlug }: ProjectTabsProps) {
  const root = `/app/${orgSlug}/${projectSlug}`;
  const renderTab = ({ key, label, suffix }: (typeof tabs)[number]) => (
    <Link key={key} to={`${root}${suffix}`} viewTransition className="project-tab" aria-current={active === key ? 'page' : undefined}>
      {label}
    </Link>
  );

  return (
    <div className="project-tabs">
      <nav className="project-tabs-inner" aria-label="Project sections">
        <div className="project-tabs-main">{tabs.map(renderTab)}</div>
        <div className="project-tabs-trailing">{trailing.map(renderTab)}</div>
      </nav>
    </div>
  );
}
