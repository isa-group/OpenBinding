import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Eye } from 'lucide-react';
import type { ProjectAccessKind } from '../../api/platform';
import { canOpenSection, levelOf } from '../../utils/accessLevel';
import './SectionNav.css';

// The keys `cases` and `jobs` are the section names the problem and run screens pass today; the slices that rename their addresses
// rename the keys with them.
export type ProjectSection = 'overview' | 'cases' | 'collections' | 'jobs' | 'studies' | 'published' | 'settings';

interface ProjectTabsProps {
  active?: ProjectSection;
  orgSlug: string;
  projectSlug: string;
  /** `public_read`: a visitor of a public project. The tabs only members can open disappear and a strip says the project is read-only. */
  access?: ProjectAccessKind;
}

interface Tab {
  key: ProjectSection;
  label: string;
  /** Appended to the project address. Problems and Runs lead to `/cases` and `/jobs` until the address slices move them to `/problems` and `/runs`. */
  suffix: string;
  /** Shown at the end of the row, apart from the others. */
  trailing?: true;
}

// [impl->req~frontend-nav-project-tabs~1]
// [impl->req~frontend-retire-reports-navigation~1]
// [impl->req~frontend-retire-library-navigation~1]
const TABS: readonly Tab[] = [
  { key: 'overview', label: 'Overview', suffix: '' },
  { key: 'cases', label: 'Problems', suffix: '/cases' },
  { key: 'collections', label: 'Collections', suffix: '/collections' },
  { key: 'jobs', label: 'Runs', suffix: '/jobs' },
  { key: 'studies', label: 'Studies', suffix: '/studies' },
  { key: 'published', label: 'Published', suffix: '/published' },
  { key: 'settings', label: 'Settings', suffix: '/settings', trailing: true },
];

/** Section tabs shown at the top of every project screen. On a narrow screen the row scrolls, and the current tab is always brought into view. */
export function ProjectTabs({ active = 'overview', orgSlug, projectSlug, access }: ProjectTabsProps) {
  const root = `/app/${orgSlug}/${projectSlug}`;
  const nav = useRef<HTMLElement>(null);
  // Runs and the settings are only for members: the gateway refuses them to a visitor.
  const level = levelOf(access, null);
  const readOnly = level === 'public_read';

  useEffect(() => {
    // `scrollIntoView` is missing where there is no layout (the unit-test DOM): nothing to scroll there.
    nav.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [active, root]);

  const renderTab = ({ key, label, suffix }: Tab) => (
    <Link key={key} to={`${root}${suffix}`} viewTransition className="project-tab" aria-current={active === key ? 'page' : undefined}>
      {label}
    </Link>
  );
  const shown = TABS.filter((tab) => canOpenSection(level, tab.key));

  return (
    <>
      <div className="project-tabs">
        <nav ref={nav} className="project-tabs-inner" aria-label="Project sections">
          <div className="project-tabs-main">{shown.filter((tab) => !tab.trailing).map(renderTab)}</div>
          <div className="project-tabs-trailing">{shown.filter((tab) => tab.trailing).map(renderTab)}</div>
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
