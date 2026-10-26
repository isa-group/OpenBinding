import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Eye } from 'lucide-react';
import type { ProjectAccessKind } from '../../api/platform';
import { canOpenSection, levelOf } from '../../utils/accessLevel';
import './SectionNav.css';

export type ProjectSection = 'overview' | 'cases' | 'collections' | 'jobs' | 'studies' | 'publications' | 'files' | 'package' | 'settings';

interface ProjectTabsProps {
  active?: ProjectSection;
  orgSlug: string;
  projectSlug: string;
  /** `public_read`: a visitor of a public project. The tabs only members can open disappear and a strip says the project is read-only. */
  access?: ProjectAccessKind;
}

// [impl->req~frontend-retire-reports-navigation~1]
// [impl->req~frontend-retire-library-navigation~1]
const tabs: ReadonlyArray<{ key: ProjectSection; label: string; suffix: string }> = [
  { key: 'overview', label: 'Overview', suffix: '' },
  { key: 'cases', label: 'Cases', suffix: '/cases' },
  { key: 'collections', label: 'Collections', suffix: '/collections' },
  { key: 'jobs', label: 'Jobs', suffix: '/jobs' },
  { key: 'studies', label: 'Studies', suffix: '/studies' },
  { key: 'publications', label: 'Publications', suffix: '/publications' },
  { key: 'files', label: 'Files', suffix: '/files' },
];

const trailing: ReadonlyArray<{ key: ProjectSection; label: string; suffix: string }> = [
  { key: 'package', label: 'Package', suffix: '/package' },
  { key: 'settings', label: 'Settings', suffix: '/settings' },
];

/** Section tabs shown at the top of every project screen. On a narrow screen the row scrolls, and the current tab is always brought into view. */
export function ProjectTabs({ active = 'overview', orgSlug, projectSlug, access }: ProjectTabsProps) {
  const root = `/app/${orgSlug}/${projectSlug}`;
  const nav = useRef<HTMLElement>(null);
  // Jobs, the package export and the settings are only for members: the gateway refuses them to a visitor.
  const level = levelOf(access, null);
  const readOnly = level === 'public_read';

  useEffect(() => {
    // `scrollIntoView` is missing where there is no layout (the unit-test DOM): nothing to scroll there.
    nav.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [active, root]);

  const renderTab = ({ key, label, suffix }: (typeof tabs)[number]) => (
    <Link key={key} to={`${root}${suffix}`} viewTransition className="project-tab" aria-current={active === key ? 'page' : undefined}>
      {label}
    </Link>
  );
  const shown = (list: typeof tabs) => list.filter((tab) => canOpenSection(level, tab.key));

  return (
    <>
      <div className="project-tabs">
        <nav ref={nav} className="project-tabs-inner" aria-label="Project sections">
          <div className="project-tabs-main">{shown(tabs).map(renderTab)}</div>
          <div className="project-tabs-trailing">{shown(trailing).map(renderTab)}</div>
        </nav>
      </div>
      {readOnly && (
        <div className="project-public-banner" role="note">
          <div className="project-public-banner-inner">
            <Eye aria-hidden="true" />
            <span><strong>You are viewing a public project (read-only).</strong> Everything that changes it is hidden.</span>
          </div>
        </div>
      )}
    </>
  );
}
