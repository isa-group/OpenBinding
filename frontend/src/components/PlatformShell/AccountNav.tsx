import { Bell, BarChart3, Fingerprint, KeyRound, User, type LucideIcon } from 'lucide-react';
import { useRef } from 'react';
import { Link } from 'react-router-dom';
import { useCurrentIntoView } from './useCurrentIntoView';
import './SectionNav.css';

export type AccountSection = 'profile' | 'usage' | 'keys' | 'identities' | 'notifications';

const sections: ReadonlyArray<{ key: AccountSection; label: string; to: string; icon: LucideIcon }> = [
  { key: 'profile', label: 'Profile & security', to: '/app/account', icon: User },
  { key: 'usage', label: 'Usage & plan', to: '/app/account/usage', icon: BarChart3 },
  { key: 'keys', label: 'API keys', to: '/app/account/keys', icon: KeyRound },
  { key: 'identities', label: 'Identities', to: '/app/account/identities', icon: Fingerprint },
  { key: 'notifications', label: 'Notifications', to: '/app/account/notifications', icon: Bell },
];

/** Side navigation shared by the account screens. */
export function AccountNav({ active = 'profile' }: { active?: AccountSection }) {
  const nav = useRef<HTMLElement>(null);
  useCurrentIntoView(nav, active);
  return (
    <nav ref={nav} className="section-nav" aria-label="Account">
      <span className="section-nav-title">Account</span>
      {sections.map(({ key, label, to, icon: Icon }) => (
        <Link key={key} to={to} viewTransition className="section-nav-link" aria-current={active === key ? 'page' : undefined}>
          <Icon aria-hidden="true" />{label}
        </Link>
      ))}
    </nav>
  );
}
