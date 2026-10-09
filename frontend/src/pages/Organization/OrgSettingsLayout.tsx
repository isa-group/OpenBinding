import type { ReactNode } from 'react';
import type { Organization } from '../../api/platform';
import { OrgNav, type OrgSection } from '../../components/PlatformShell/OrgNav';
import { atLeast } from './orgModel';
import './Organization.css';

interface OrgSettingsLayoutProps {
  organization: Organization;
  section: OrgSection;
  title: string;
  lede: ReactNode;
  /** Buttons aligned with the title (“Invite by email”, “Export this view”). */
  actions?: ReactNode;
  /** A column to the right of the content (the pending-changes queue). */
  aside?: ReactNode;
  width?: 'md' | 'lg';
  children: ReactNode;
}

/**
 * The frame of the settings screens of one organization: title and lede, the settings side navigation and the
 * content column. The content column is one live region, so a message that appears in it is read out.
 */
export function OrgSettingsLayout({ organization, section, title, lede, actions, aside, width = 'md', children }: OrgSettingsLayoutProps) {
  return (
    <div className={`org-page${width === 'lg' ? ' is-lg' : ''}`}>
      <header className="org-head">
        <div>
          <h1>{title}</h1>
          <p>{lede}</p>
        </div>
        {actions && <div className="org-head-actions">{actions}</div>}
      </header>
      <div className="org-frame">
        <div className="org-side">
          <OrgNav active={section} orgName={organization.name} orgSlug={organization.slug} canAudit={atLeast(organization.effective_role, 'ADMIN')} />
        </div>
        <div className="org-content" aria-live="polite">{children}</div>
        {aside}
      </div>
    </div>
  );
}
