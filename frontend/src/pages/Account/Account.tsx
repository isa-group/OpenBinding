import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { apiClient } from '../../api/client';
import type { ApiKeySummary, CreatedApiKey, UsageView } from '../../api/auth';
import { PricingUnavailableError } from '../../api/auth';
import { useAuth } from '../../contexts/AuthContext';
import { QuotaBar, isBalance } from '../../components/QuotaBar';
import { Card } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Alert } from '../../components/ui/Alert';
import './Account.css';

export function Account() {
  const { user, refresh } = useAuth();
  const [usage, setUsage] = useState<UsageView | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [keys, setKeys] = useState<ApiKeySummary[]>([]);
  const [minted, setMinted] = useState<CreatedApiKey | null>(null);
  const [keyName, setKeyName] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadUsage = useCallback(async () => {
    try {
      setUsage(await apiClient.getOwnUsage());
      setUsageError(null);
    } catch (err) {
      // The account may be perfectly healthy; the pricing service is not.
      setUsageError(
        err instanceof PricingUnavailableError
          ? 'Quotas cannot be read right now. Solving may be on hold until the pricing service is back.'
          : 'Quotas could not be loaded.'
      );
    }
  }, []);

  const loadKeys = useCallback(async () => {
    try {
      setKeys(await apiClient.listApiKeys());
    } catch {
      setError('Your API keys could not be loaded.');
    }
  }, []);

  useEffect(() => {
    void loadUsage();
    void loadKeys();
  }, [loadUsage, loadKeys]);

  const createKey = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      const created = await apiClient.createApiKey(keyName.trim() || 'Untitled key');
      setMinted(created);
      setKeyName('');
      await loadKeys();
      await loadUsage();
    } catch {
      setError('The key could not be created. You may have reached your plan’s limit.');
    }
  };

  const revokeKey = async (keyId: string) => {
    setError(null);
    try {
      await apiClient.revokeApiKey(keyId);
      if (minted?.id === keyId) setMinted(null);
      await loadKeys();
      await loadUsage();
    } catch {
      setError('That key could not be revoked.');
    }
  };

  const copySecret = async (secret: string) => {
    try {
      await navigator.clipboard.writeText(secret);
      setNotice('Key copied to the clipboard.');
    } catch {
      setNotice('Select the key and copy it manually.');
    }
  };

  if (!user) return null;

  return (
    <div className="account-page">
      <div className="container">
        <div className="page-header">
          <h1>Your account</h1>
          <p className="page-description">
            Everything here is a documented endpoint of the gateway API, so anything this page
            does, a script with an API key can do too.
          </p>
        </div>

        {error && <Alert type="error">{error}</Alert>}
        {notice && <Alert type="info">{notice}</Alert>}

        <div className="account-grid">
          <Card padding="lg">
            <h2>Profile</h2>
            <dl className="account-facts">
              <dt>Username</dt>
              <dd>{user.username}</dd>
              <dt>Email</dt>
              <dd>{user.email}</dd>
              <dt>Plan</dt>
              <dd>
                <Badge variant={user.plan === 'PRO' ? 'accent' : 'default'}>{user.plan}</Badge>
                {usage?.contract_pending && (
                  <span className="account-pending">
                    {' '}
                    contract pending &mdash; it will be settled automatically
                  </span>
                )}
              </dd>
              {user.role === 'admin' && (
                <>
                  <dt>Role</dt>
                  <dd>
                    <Badge variant="accent">Administrator</Badge>
                  </dd>
                </>
              )}
            </dl>
            <p className="account-note">
              Moving between plans is done by an administrator: there is no payment gateway.
            </p>
            <Button variant="secondary" size="sm" onClick={() => void refresh()}>
              Refresh
            </Button>
          </Card>

          <Card padding="lg">
            <h2>Allowances</h2>
            {usageError && <Alert type="warning">{usageError}</Alert>}
            {usage && (
              <>
                <div className="account-quotas">
                  {usage.limits
                    .filter((limit) => isBalance(limit.limit_id) && limit.limit > 0)
                    .map((limit) => (
                      <QuotaBar key={limit.limit_id} limit={limit} />
                    ))}
                </div>

                <h3 className="account-subheading">Per request</h3>
                <dl className="account-facts account-caps">
                  <dt>Longest solver budget</dt>
                  <dd>{usage.caps.max_timeout_s} s</dd>
                  <dt>Largest instance</dt>
                  <dd>{usage.caps.max_payload_mb} MB</dd>
                  <dt>Largest binding space</dt>
                  <dd>10^{usage.caps.max_binding_space_log10}</dd>
                  <dt>Search effort ceiling</dt>
                  <dd>{usage.caps.max_iterations.toLocaleString()} iterations</dd>
                </dl>
                <p className="account-note">
                  A request asking for more than these is reduced to them rather than refused,
                  and the reduction is reported with the result.
                </p>
              </>
            )}
          </Card>
        </div>

        <Card padding="lg" className="account-keys">
          <h2>API keys</h2>
          <p className="account-note">
            A key reaches the same account this page does, so it draws on the same allowances.
          </p>

          {minted && (
            <Alert type="success" title="Copy this key now">
              <p>It is shown once. What is stored is a hash, so it cannot be shown again.</p>
              <code className="account-secret">{minted.secret}</code>
              <Button size="sm" variant="secondary" onClick={() => void copySecret(minted.secret)}>
                Copy
              </Button>
            </Alert>
          )}

          <form className="account-key-form" onSubmit={createKey}>
            <input
              aria-label="What this key is for"
              placeholder="What is this key for?"
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
              maxLength={128}
            />
            <Button type="submit" size="sm">
              Create key
            </Button>
          </form>

          {keys.length === 0 ? (
            <p className="account-empty">No keys yet.</p>
          ) : (
            <table className="account-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Prefix</th>
                  <th>Created</th>
                  <th>Last used</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {keys.map((key) => (
                  <tr key={key.id}>
                    <td>{key.name}</td>
                    <td>
                      <code>{key.prefix}</code>
                    </td>
                    <td>{new Date(key.created_at).toLocaleDateString()}</td>
                    <td>
                      {key.last_used_at
                        ? new Date(key.last_used_at).toLocaleDateString()
                        : 'never'}
                    </td>
                    <td>
                      <Button size="sm" variant="ghost" onClick={() => void revokeKey(key.id)}>
                        Revoke
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </div>
  );
}
