import type { ReactNode } from 'react';
import { Lock } from 'lucide-react';
import { AccountNav, type AccountSection } from '../../components/PlatformShell/AccountNav';
import { Action } from '../../components/ui/Action';
import { Notice } from '../../components/ui/Notice';
import './Account.css';

interface AccountLayoutProps {
  section: AccountSection;
  title: string;
  lede: ReactNode;
  /** Buttons aligned with the title (“Refresh usage”, “New key”). */
  actions?: ReactNode;
  /** Something above the title, for screens that sit below another (a breadcrumb). */
  above?: ReactNode;
  children: ReactNode;
}

/**
 * The frame of every account screen: title and lede, the account side navigation and the content column.
 * The content column is one live region, so a message that appears in it is read out.
 */
export function AccountLayout({ section, title, lede, actions, above, children }: AccountLayoutProps) {
  return (
    <div className="acct-page">
      {above}
      <header className="acct-head">
        <div>
          <h1>{title}</h1>
          <p>{lede}</p>
        </div>
        {actions && <div className="acct-head-actions">{actions}</div>}
      </header>
      <div className="acct-frame">
        <div className="acct-side"><AccountNav active={section} /></div>
        <div className="acct-content" aria-live="polite">{children}</div>
      </div>
    </div>
  );
}

/**
 * A 403: the account is fine, the credential is not enough. Browser sessions are never limited this way;
 * a request made with an API key lacking the permission is.
 */
export function PermissionNotice({ permissions, action }: { permissions: string[]; action: string }) {
  return (
    <div className="acct-forbidden" role="alert">
      <Lock aria-hidden="true" />
      <span>
        This request was refused (403). To {action}, a request needs{' '}
        {permissions.map((permission, index) => (
          <span key={permission}>{index > 0 && ' and '}<code>{permission}</code></span>
        ))}
        {' '}or a browser session.
      </span>
    </div>
  );
}

/** A load that failed for a reason that is not a refusal: said plainly, with the way to try again. */
export function LoadFailure({ children, onRetry }: { children: ReactNode; onRetry: () => void }) {
  return (
    <Notice tone="error" action={<Action variant="secondary" size="sm" onClick={onRetry}>Try again</Action>}>
      {children}
    </Notice>
  );
}
