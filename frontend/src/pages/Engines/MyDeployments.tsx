import { useCallback, useEffect, useState } from 'react';
import { CloudCog } from 'lucide-react';
import { Link } from 'react-router-dom';
import { apiClient, bimResourceKey, HttpError, type EngineRegistrationRevision, type EngineRegistrationState } from '../../api/client';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { shortDigest } from '../../utils/digest';

const deploymentStates: Record<EngineRegistrationState, {
  label: string;
  hint: string;
  badge: 'default' | 'success' | 'warning' | 'error' | 'info';
}> = {
  private: { label: 'Private', hint: 'Visible only to your account; administrators cannot discover it.', badge: 'info' },
  pending_review: { label: 'In review', hint: 'Visible to administrators because you requested publication.', badge: 'warning' },
  published: { label: 'Published', hint: 'Available to every authenticated compatible account.', badge: 'success' },
  rejected: { label: 'Rejected', hint: 'Not published; it remains private to your account.', badge: 'error' },
};

function deploymentErrorMessage(reason: unknown): string {
  if (reason instanceof HttpError) {
    const diagnostic = reason.diagnostics?.find(
      (item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
    );
    const diagnosticMessage = diagnostic?.message;
    if (typeof diagnosticMessage === 'string' && diagnosticMessage) {
      return `${reason.message} ${diagnosticMessage}`;
    }
  }
  return reason instanceof Error ? reason.message : 'The deployment change was refused.';
}

/**
 * The signed-in account's own engine registrations (deployments): activate, deactivate, ask for publication and
 * replace the credential. Activation and publication are independent of each other, as the gateway keeps them.
 */
export function MyDeployments({ username, onChanged }: { username: string; onChanged?: () => void }) {
  const [deployments, setDeployments] = useState<EngineRegistrationRevision[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [credentialEditor, setCredentialEditor] = useState('');
  const [credentialValue, setCredentialValue] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const registrations = await apiClient.listEngineRegistrations();
      setDeployments(registrations.filter((registration) => registration.namespace === username));
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Your deployments could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [username]);

  useEffect(() => {
    void load();
  }, [load]);

  const change = async (
    registration: EngineRegistrationRevision,
    action: (ref: EngineRegistrationRevision) => Promise<EngineRegistrationRevision>,
    message: string,
  ) => {
    const key = bimResourceKey(registration);
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const updated = await action(registration);
      setDeployments((current) => current.map((item) => bimResourceKey(item) === key ? updated : item));
      setNotice(message);
      onChanged?.();
      return true;
    } catch (reason: unknown) {
      setError(deploymentErrorMessage(reason));
      return false;
    } finally {
      setBusy('');
    }
  };

  const replaceCredential = async (registration: EngineRegistrationRevision) => {
    if (!credentialValue) {
      setError('A non-empty bearer token or Basic username:password credential is required.');
      return;
    }
    const changed = await change(
      registration,
      (ref) => apiClient.setEngineRegistrationCredential(ref, credentialValue),
      `${registration.name} has a new encrypted credential and is private and inactive until it is verified again.`,
    );
    if (changed) {
      setCredentialEditor('');
      setCredentialValue('');
    }
  };

  return (
    <section className="engines-section" aria-labelledby="deployment-title">
      <div className="engines-section-heading">
        <h2 id="deployment-title">My deployments</h2>
        <span>You control private activation independently from publication. A deployment reaches administrators only after you submit it for review.</span>
      </div>

      {error && (
        <Notice tone="error" title="Deployment change unavailable" action={<Button size="sm" variant="secondary" onClick={() => void load()}>Retry</Button>}>
          {error}
        </Notice>
      )}
      {notice && <Notice tone="success">{notice}</Notice>}
      {loading ? <Skeleton variant="tile" /> : error && deployments.length === 0 ? null : deployments.length === 0 ? (
        <EmptyState
          icon={<CloudCog />}
          title={`No deployments in ${username} yet.`}
          action={<Link to="/app/engines/new">Register deployment</Link>}
        >
          Register an engine endpoint to keep it private while the gateway verifies it. Production requires HTTPS.
        </EmptyState>
      ) : (
        <ul className="deployment-list" aria-label="My federated deployments">
          {deployments.map((registration) => {
            const state = deploymentStates[registration.status];
            const key = bimResourceKey(registration);
            const working = busy === key;
            return (
              <li key={key} data-state={registration.status}>
                <div className="deployment-identity">
                  <div className="deployment-badges">
                    <Badge variant={state.badge}>{state.label}</Badge>
                    <Badge variant={registration.active ? 'success' : 'default'}>{registration.active ? 'active for you' : 'inactive for you'}</Badge>
                    <span>{state.hint}</span>
                  </div>
                  <h3>{registration.name}</h3>
                  <p><code>{registration.namespace}/{registration.name}</code> · <code>{registration.version}</code></p>
                </div>
                <code className="deployment-digest" title={registration.digest}>{shortDigest(registration.digest)}</code>
                <div className="deployment-actions">
                  {!registration.active && (
                    <Button size="sm" disabled={working} aria-label={`Activate ${registration.name}`} onClick={() => void change(registration, (ref) => apiClient.activateEngineRegistration(ref), `${registration.name} is verified and active for your account.`)}>Activate</Button>
                  )}
                  {registration.active && (
                    <Button size="sm" variant="secondary" disabled={working} aria-label={`Deactivate ${registration.name}`} onClick={() => {
                      if (window.confirm(`Deactivate ${registration.name} for your account? Its publication state will not change.`)) {
                        void change(registration, (ref) => apiClient.deactivateEngineRegistration(ref), `${registration.name} is inactive for your account.`);
                      }
                    }}>Deactivate</Button>
                  )}
                  {registration.active && (registration.status === 'private' || registration.status === 'rejected') && (
                    <Button size="sm" variant="ghost" disabled={working} aria-label={`Request publication for ${registration.name}`} onClick={() => {
                      if (window.confirm(`Submit ${registration.name} for publication? Administrators will then be able to discover and review this exact revision.`)) {
                        void change(registration, (ref) => apiClient.requestEngineRegistrationPublication(ref), `${registration.name} was submitted for publication review.`);
                      }
                    }}>Request publication</Button>
                  )}
                  {registration.status !== 'published' && (
                    <Button size="sm" variant="ghost" disabled={working} aria-label={`Replace credential for ${registration.name}`} onClick={() => {
                      setCredentialEditor((current) => current === key ? '' : key);
                      setCredentialValue('');
                    }}>Credential</Button>
                  )}
                </div>
                {credentialEditor === key && (
                  <form className="credential-editor" onSubmit={(event) => {
                    event.preventDefault();
                    void replaceCredential(registration);
                  }}>
                    <label htmlFor={`credential-${registration.digest}`}>
                      <span>New deployment credential</span>
                      <input
                        id={`credential-${registration.digest}`}
                        type="password"
                        autoComplete="off"
                        value={credentialValue}
                        onChange={(event) => setCredentialValue(event.target.value)}
                        placeholder="Bearer token or username:password"
                      />
                    </label>
                    <p>Use the token alone for bearer auth or <code>username:password</code> for Basic. Replacing it makes the deployment private and inactive, so activation and publication review must be repeated.</p>
                    <div>
                      <Button type="submit" size="sm" disabled={working}>Store encrypted credential</Button>
                      <Button type="button" size="sm" variant="ghost" disabled={working} onClick={() => {
                        setCredentialEditor('');
                        setCredentialValue('');
                      }}>Cancel</Button>
                    </div>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
