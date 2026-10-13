import { useState } from 'react';
import { KeyRound, Plus } from 'lucide-react';
import { apiClient } from '../../api/client';
import type { ApiKeySummary, CreatedApiKey } from '../../api/auth';
import { Action } from '../../components/ui/Action';
import { Chip } from '../../components/ui/Chip';
import { EmptyState } from '../../components/ui/EmptyState';
import { Modal } from '../../components/ui/Modal';
import { Notice, type NoticeTone } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { useCopy } from '../../components/ui/useCopy';
import { useAuth } from '../../contexts/auth';
import { formatDate } from '../../utils/format';
import { formatCount } from '../../utils/limits';
import { useResource } from '../../utils/useResource';
import { classifyAuthError, fallbackMessage } from './accountErrors';
import { AccountLayout, LoadFailure, PermissionNotice } from './AccountLayout';
import { boundaryLabels, describeEngineAccess } from './keysModel';
import { SecretDialog } from './SecretDialog';
import './AccountKeys.css';

type Dialog =
  | { kind: 'rotate' | 'revoke'; key: ApiKeySummary }
  | { kind: 'secret'; name: string; created: CreatedApiKey };

interface Banner {
  tone: NoticeTone;
  text: string;
}

interface Snapshot {
  keys: ApiKeySummary[];
  /** `null`: no limit; `undefined`: not known. */
  limit: number | null | undefined;
  loadedAt: number;
}

async function loadSnapshot(): Promise<Snapshot> {
  const [keys, usage] = await Promise.all([apiClient.listApiKeys(), apiClient.getOwnUsage().catch(() => null)]);
  return { keys, limit: usage?.capabilities.apiKeys, loadedAt: Date.now() };
}

function KeyCard({ apiKey, expired, onRotate, onRevoke }: {
  apiKey: ApiKeySummary;
  expired: boolean;
  onRotate: () => void;
  onRevoke: () => void;
}) {
  const { copy, status } = useCopy();
  const state = status(apiKey.id);
  const bounds = boundaryLabels(apiKey.boundary);
  return (
    <article className="key-card" aria-label={apiKey.name}>
      <div className="key-card-head">
        <KeyRound aria-hidden="true" />
        <h2>{apiKey.name}</h2>
        <Chip tone={expired ? 'warning' : 'success'}>{expired ? 'Expired' : 'Active'}</Chip>
        <span className="key-card-spacer" />
        <div className="key-card-actions">
          <Action variant="secondary" size="sm" onClick={onRotate} aria-label={`Rotate ${apiKey.name}`}>Rotate</Action>
          <Action variant="danger-outline" size="sm" onClick={onRevoke} aria-label={`Revoke ${apiKey.name}`}>Revoke</Action>
        </div>
      </div>
      <div className="key-card-meta">
        <code>{apiKey.prefix}…</code>
        <button type="button" className="key-copy" onClick={() => void copy(apiKey.prefix, apiKey.id)} aria-label={`Copy prefix of ${apiKey.name}`}>
          {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy prefix'}
        </button>
        {/* Three facts, spaced by the row's gap: a bullet typed between them lands at the start of a line when the row wraps. */}
        <span className="key-dates">
          <span>created {formatDate(apiKey.created_at) ?? '—'}</span>
          <span>last used {formatDate(apiKey.last_used_at) ?? 'never'}</span>
          <span>{apiKey.expires_at ? `${expired ? 'expired' : 'expires'} ${formatDate(apiKey.expires_at)}` : 'no expiry'}</span>
        </span>
      </div>
      <dl className="key-card-grid">
        <dt>Permissions</dt>
        <dd className="key-chips">
          {apiKey.permissions.map((permission) => <code key={permission} className="key-permission">{permission}</code>)}
        </dd>
        <dt>Engines</dt>
        <dd>{describeEngineAccess(apiKey.engine_access)}</dd>
        <dt>Limited to</dt>
        <dd className="key-chips">
          {bounds.length > 0 ? bounds.map((label) => <span key={label} className="key-bound">{label}</span>) : <span className="acct-muted">No extra limits</span>}
        </dd>
      </dl>
    </article>
  );
}

/** API keys (`acct-keys`, `/app/account/keys`): the list, rotate and revoke. New keys are made at `/app/account/keys/new`. */
export function AccountKeys() {
  const { user } = useAuth();
  const data = useResource(`keys:${user?.id ?? ''}`, loadSnapshot);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<Banner | null>(null);

  const failure = data.status === 'error' ? classifyAuthError(data.error) : null;
  const snapshot = data.data;
  const count = snapshot?.keys.length ?? 0;
  const limit = snapshot?.limit;
  const atLimit = typeof limit === 'number' && count >= limit;
  const share = typeof limit === 'number' && limit > 0 ? Math.min(100, Math.round((count / limit) * 100)) : limit === null ? 4 : 0;

  const goneBanner = () => setBanner({ tone: 'warning', text: 'That key no longer exists or isn’t yours (404). The list was refreshed.' });

  const revoke = async (key: ApiKeySummary) => {
    setBusy(true);
    try {
      await apiClient.revokeApiKey(key.id);
      setBanner({ tone: 'success', text: `“${key.name}” was revoked.` });
    } catch (caught) {
      const refusal = classifyAuthError(caught);
      if (refusal.kind === 'not-found') goneBanner();
      else setBanner({ tone: 'error', text: fallbackMessage(refusal, 'revoked') });
    } finally {
      setBusy(false);
      setDialog(null);
      data.reload();
    }
  };

  const rotate = async (key: ApiKeySummary) => {
    setBusy(true);
    try {
      const created = await apiClient.rotateApiKey(key.id);
      setBanner(null);
      setDialog({ kind: 'secret', name: key.name, created });
      data.reload();
    } catch (caught) {
      const refusal = classifyAuthError(caught);
      if (refusal.kind === 'not-found') goneBanner();
      else setBanner({ tone: 'error', text: fallbackMessage(refusal, 'rotated') });
      setDialog(null);
      data.reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <AccountLayout
      section="keys"
      title="API keys"
      lede="Keys for scripts and CI. A key can never do more than your account."
      actions={<Action to="/app/account/keys/new" variant="primary"><Plus aria-hidden="true" className="key-plus" />New key</Action>}
    >
      {banner && <Notice tone={banner.tone}>{banner.text}</Notice>}
      {atLimit && (
        <Notice tone="warning">
          You’ve reached your plan’s API key limit ({formatCount(limit)}). Revoke a key or ask for an agreement with more keys;
          creating one now returns 402.
        </Notice>
      )}

      {failure?.status === 403 && <PermissionNotice permissions={['keys:read']} action="manage keys" />}
      {failure && failure.status !== 403 && <LoadFailure onRetry={data.reload}>{fallbackMessage(failure, 'loaded')}</LoadFailure>}

      {data.status === 'loading' && (
        <div aria-busy="true" className="key-skeleton"><Skeleton variant="tile" /><Skeleton variant="panel" /><Skeleton variant="panel" /></div>
      )}

      {snapshot && (
        <>
          <div className="key-meter">
            <span>Active keys</span>
            <div className="key-meter-track" role="meter" aria-label="Active keys" aria-valuemin={0} aria-valuemax={typeof limit === 'number' ? limit : count} aria-valuenow={count}>
              <div className={atLimit ? 'is-full' : undefined} style={{ width: `${share}%` }} />
            </div>
            <span className="key-meter-label">{count} of {typeof limit === 'number' ? limit : limit === null ? 'unlimited' : '—'} keys</span>
          </div>

          <Notice tone="info">
            Treat a key like a password: it acts as you within its permissions. The secret is shown only once, when you create or rotate it.
            We only keep its prefix.
          </Notice>

          {count === 0 ? (
            <EmptyState
              icon={<KeyRound />}
              title="No API keys"
              action={<Action to="/app/account/keys/new" variant="link">Create your first key</Action>}
            >
              Create a key to call OpenBinding from scripts or CI.
            </EmptyState>
          ) : (
            snapshot.keys.map((key) => (
              <KeyCard
                key={key.id}
                apiKey={key}
                expired={Boolean(key.expires_at) && new Date(key.expires_at as string).getTime() <= snapshot.loadedAt}
                onRotate={() => setDialog({ kind: 'rotate', key })}
                onRevoke={() => setDialog({ kind: 'revoke', key })}
              />
            ))
          )}
        </>
      )}

      {dialog && dialog.kind !== 'secret' && (
        <Modal
          title={dialog.kind === 'rotate' ? `Rotate “${dialog.key.name}”?` : `Revoke “${dialog.key.name}”?`}
          tone={dialog.kind === 'revoke' ? 'danger' : 'default'}
          onClose={() => !busy && setDialog(null)}
        >
          <p>
            {dialog.kind === 'rotate'
              ? 'You’ll get a new secret and the current one stops working immediately. Permissions, engines and limits stay the same. Update anything that uses this key.'
              : 'Anything using this key stops working right away. This can’t be undone; create a new key if you need access again.'}
          </p>
          <div className="ui-modal-actions">
            <Action variant="secondary" onClick={() => setDialog(null)} disabled={busy}>Cancel</Action>
            <Action
              variant={dialog.kind === 'revoke' ? 'danger' : 'primary'}
              busy={busy}
              onClick={() => void (dialog.kind === 'rotate' ? rotate(dialog.key) : revoke(dialog.key))}
            >
              {dialog.kind === 'rotate' ? 'Rotate key' : 'Revoke key'}
            </Action>
          </div>
        </Modal>
      )}

      {dialog?.kind === 'secret' && (
        <SecretDialog title="Copy your new secret now" secret={dialog.created.secret} onDone={() => setDialog(null)}>
          <p>This is the only time it’s shown. The previous secret of “{dialog.name}” has stopped working; permissions didn’t change.</p>
        </SecretDialog>
      )}
    </AccountLayout>
  );
}
