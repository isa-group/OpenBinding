import { useRef, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Settings, Users, type LucideIcon } from 'lucide-react';
import type { Organization, Project } from '../../api/platform';
import { useCurrentIntoView } from '../../components/PlatformShell/useCurrentIntoView';
import { useAuth } from '../../contexts/auth';
import { RoleChip } from '../Organization/parts';
import { ProjectFrame } from './parts';
import '../Organization/Organization.css';
import './Project.css';

export type ProjectSettingsSection = 'general' | 'members';

interface ProjectSettingsLayoutProps {
  organization: Organization;
  project: Project;
  section: ProjectSettingsSection;
  children: ReactNode;
}

/** The frame of the project settings: the project tabs, the title with the person’s role, the sections General and Members, and the content. */
// [impl->req~frontend-nav-project-tabs~1]
export function ProjectSettingsLayout({ organization, project, section, children }: ProjectSettingsLayoutProps) {
  const { isAdmin } = useAuth();
  const nav = useRef<HTMLElement>(null);
  useCurrentIntoView(nav, section);
  const role = organization.effective_role ?? (isAdmin ? 'PLATFORM ADMIN' as const : null);
  const root = `/app/${organization.slug}/${project.slug}/settings`;
  const sections: ReadonlyArray<{ key: ProjectSettingsSection; label: string; to: string; icon: LucideIcon }> = [
    { key: 'general', label: 'General', to: root, icon: Settings },
    { key: 'members', label: 'Members', to: `${root}/members`, icon: Users },
  ];

  return (
    <ProjectFrame organization={organization} project={project} section="settings" crumb="Settings" width="lg">
      <header className="org-head">
        <div>
          <h1>Project settings</h1>
          <p>{project.name} · your role <RoleChip role={role} /></p>
        </div>
      </header>
      <div className="org-frame">
        <div className="org-side">
          <nav ref={nav} className="section-nav" aria-label="Settings sections">
            {sections.map(({ key, label, to, icon: Icon }) => (
              <Link key={key} to={to} viewTransition className="section-nav-link" aria-current={section === key ? 'page' : undefined}>
                <Icon aria-hidden="true" /><span className="section-nav-label">{label}</span>
              </Link>
            ))}
          </nav>
        </div>
        <div className="org-content">{children}</div>
      </div>
    </ProjectFrame>
  );
}
