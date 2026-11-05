import { useParams } from 'react-router-dom';
import { NotFoundScreen } from '../../routes/NotFoundScreen';
import { Account } from './Account';
import { AccountIdentities } from './AccountIdentities';
import { AccountKeys } from './AccountKeys';
import { AccountNotifications } from './AccountNotifications';
import { AccountUsage } from './AccountUsage';

/**
 * The account page (`acct-profile`, `/app/account/:section?`): Profile (no segment), Plan (`usage`), API keys (`keys`),
 * Identities (`identities`) and Notifications (`notifications`). Any other section is a page that does not exist.
 */
export function AccountPage() {
  const { section } = useParams();
  if (section === undefined) return <Account />;
  if (section === 'usage') return <AccountUsage />;
  if (section === 'keys') return <AccountKeys />;
  if (section === 'identities') return <AccountIdentities />;
  if (section === 'notifications') return <AccountNotifications />;
  return <NotFoundScreen />;
}
