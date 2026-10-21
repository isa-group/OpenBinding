import { ChevronLeft, History, Settings, Users, type LucideIcon } from 'lucide-react';
import { useRef } from 'react';
import { Link } from 'react-router-dom';
import { useCurrentIntoView } from './useCurrentIntoView';
import './SectionNav.css';

export type OrgSection = 'general' | 'members' | 'audit';

interface OrgNavProps {
  active?: OrgSection;
  orgName: string;
  orgSlug: string;
  /** The audit log needs the ADMIN role; without it the entry is flagged instead of hidden. */
  canAudit?: boolean;
}

/** Side navigation of the organization settings screens. */
export function OrgNav({ active = 'general', orgName, orgSlug, canAudit = true }: OrgNavProps) {
  const base = `/app/${orgSlug}`;
  const nav = useRef<HTMLElement>(null);
  useCurrentIntoView(nav, active);
  const sections: ReadonlyArray<{ key: OrgSection; label: string; to: string; icon: LucideIcon; locked: boolean }> = [
    { key: 'general', label: 'General', to: `${base}/settings`, icon: Settings, locked: false },
    { key: 'members', label: 'Members & invitations', to: `${base}/settings/members`, icon: Users, locked: false },
    { key: 'audit', label: 'Audit log', to: `${base}/settings/audit`, icon: History, locked: !canAudit },
  ];

  return (
    <nav ref={nav} className="section-nav" aria-label="Organization settings">
      <Link to={base} viewTransition className="section-nav-back"><ChevronLeft aria-hidden="true" />{orgName}</Link>
      <span className="section-nav-title">Settings</span>
      {sections.map(({ key, label, to, icon: Icon, locked }) => (
        <Link key={key} to={to} viewTransition className="section-nav-link" aria-current={active === key ? 'page' : undefined}>
          <Icon aria-hidden="true" /><span className="section-nav-label">{label}</span>
          {locked && <span className="section-nav-lock" title="Needs ADMIN">ADMIN</span>}
        </Link>
      ))}
    </nav>
  );
}
