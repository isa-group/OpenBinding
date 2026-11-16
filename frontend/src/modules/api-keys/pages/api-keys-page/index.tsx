// Adapted from SPHERE frontend/src/modules/api-keys/pages/ApiKeysPage.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's keys through `useApiKeysApi()` (refusals read and said, never swallowed); the dialog opens at
// `?create=key` from a link; the secret of a created or rotated key is shown once in SPHERE's warning panel; rotate and revoke
// are confirmed; the plan's key limit is shown and enforced in words; a Helmet title.

import { useCallback, useEffect, useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { FiCheck, FiCopy, FiPlus } from 'react-icons/fi';
import { formatCount, LIMIT } from '../../../../utils/limits';
import { classifyAuthError } from '../../../core/api/errors';
import BlockAlert from '../../../core/components/block-alert';
import { useCopy } from '../../../core/hooks/useCopy';
import customConfirm from '../../../core/utils/custom-confirm';
import { fallbackMessage } from '../../../core/utils/account-errors';
import { useApiKeysApi, type ApiKeySummary, type CreatedApiKey } from '../../api/apiKeysApi';
import ApiKeyList from '../../components/ApiKeyList';
import CreateApiKeyDialog from '../../components/CreateApiKeyDialog';

const API_KEYS_PATH = '/me/api-keys';
const CREATE_KEY = `${API_KEYS_PATH}?create=key`;

interface Snapshot {
  keys: ApiKeySummary[];
  /** `null`: no limit; `undefined`: not known. */
  limit: number | null | undefined;
  loadedAt: number;
}

interface Secret {
  name: string;
  secret: string;
  rotated: boolean;
}

interface Banner {
  variant: 'success' | 'error' | 'warning';
  text: string;
}

export default function ApiKeysPage() {
  const api = useApiKeysApi();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const creating = params.get('create') === 'key';
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [secret, setSecret] = useState<Secret | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);
  const { copy, status } = useCopy();
  const copied = status() === 'copied';

  useEffect(() => {
    let current = true;
    Promise.all([api.listApiKeys(), api.getUsage().catch(() => null)])
      .then(([keys, usage]) => {
        if (!current) return;
        setSnapshot({
          keys,
          limit: usage?.capabilities?.[LIMIT.maxApiKeys],
          loadedAt: Date.now(),
        });
        setLoadError(null);
      })
      .catch((caught: unknown) => {
        if (!current) return;
        const failure = classifyAuthError(caught);
        setLoadError(
          failure.status === 403
            ? 'This request was refused (403). To manage keys, a request needs keys:read or a browser session.'
            : fallbackMessage(failure, 'loaded')
        );
      });
    return () => {
      current = false;
    };
  }, [api, attempt]);

  const reload = useCallback(() => setAttempt(value => value + 1), []);

  const gone = () =>
    setBanner({
      variant: 'warning',
      text: 'That key no longer exists or isn’t yours (404). The list was refreshed.',
    });

  const handleCreated = (created: CreatedApiKey) => {
    setBanner(null);
    setSecret({ name: created.name, secret: created.secret, rotated: false });
    navigate(API_KEYS_PATH, { replace: true });
    reload();
  };

  const handleRotate = async (key: ApiKeySummary) => {
    try {
      await customConfirm(
        `Rotate “${key.name}”? You’ll get a new secret and the current one stops working immediately. Permissions, engines and limits stay the same.`,
        { confirmLabel: 'Rotate key' }
      );
    } catch {
      return;
    }
    try {
      const created = await api.rotateApiKey(key.id);
      setBanner(null);
      setSecret({ name: key.name, secret: created.secret, rotated: true });
    } catch (caught) {
      const failure = classifyAuthError(caught);
      if (failure.kind === 'not-found') gone();
      else setBanner({ variant: 'error', text: fallbackMessage(failure, 'rotated') });
    }
    reload();
  };

  const handleRevoke = async (key: ApiKeySummary) => {
    try {
      await customConfirm(
        `Revoke “${key.name}”? Anything using this key stops working right away. This can’t be undone.`,
        { danger: true, confirmLabel: 'Revoke key' }
      );
    } catch {
      return;
    }
    try {
      await api.revokeApiKey(key.id);
      setBanner({ variant: 'success', text: `“${key.name}” was revoked.` });
    } catch (caught) {
      const failure = classifyAuthError(caught);
      if (failure.kind === 'not-found') gone();
      else setBanner({ variant: 'error', text: fallbackMessage(failure, 'revoked') });
    }
    reload();
  };

  const count = snapshot?.keys.length ?? 0;
  const limit = snapshot?.limit;
  const atLimit = typeof limit === 'number' && count >= limit;
  const share =
    typeof limit === 'number' && limit > 0 ? Math.min(100, Math.round((count / limit) * 100)) : 0;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <Helmet>
        <title>OpenBinding - API keys</title>
      </Helmet>
      <div className="mb-8">
        <h1 className="font-display text-3xl text-tp-ink">API keys</h1>
        <p className="mt-1 text-sm text-tp-steel">
          Create and manage API keys for programmatic access to OpenBinding. A key can never do more
          than your account.
        </p>
      </div>

      {secret && (
        <BlockAlert variant="warning" className="mb-6">
          <div className="min-w-0">
            <p className="mb-2 font-medium">
              {secret.rotated
                ? `“${secret.name}” has a new secret`
                : `Your API key “${secret.name}” has been created`}
            </p>
            <div className="flex items-center gap-2">
              <code
                className="min-w-0 flex-1 truncate rounded bg-tp-surface p-2 text-sm text-tp-ink"
                aria-label="Secret"
              >
                {secret.secret}
              </code>
              <button
                type="button"
                onClick={() => void copy(secret.secret)}
                className="shrink-0 cursor-pointer rounded-md border border-tp-severity-warning-border bg-tp-severity-warning-bg p-1.5 text-tp-severity-warning transition-colors hover:bg-tp-severity-warning-border/20"
                aria-label={copied ? 'Copied' : 'Copy key'}
                title={copied ? 'Copied' : 'Copy key'}
              >
                {copied ? (
                  <FiCheck className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <FiCopy className="h-4 w-4" aria-hidden="true" />
                )}
              </button>
            </div>
            <p className="mt-2 text-sm">
              Copy this key now. You won’t be able to see it again.
              {secret.rotated ? ' The previous secret has stopped working.' : ''} Use it as{' '}
              <code>X-API-Key</code> or <code>Authorization: Bearer</code>.
            </p>
            <button
              type="button"
              onClick={() => setSecret(null)}
              className="mt-3 cursor-pointer rounded-md border border-tp-severity-warning-border px-3 py-1.5 text-xs font-medium text-tp-ink transition-colors hover:bg-tp-severity-warning-border/20"
            >
              Dismiss
            </button>
          </div>
        </BlockAlert>
      )}

      {banner && (
        <BlockAlert
          variant={banner.variant}
          className="mb-6"
          message={banner.text}
          onDismiss={() => setBanner(null)}
        />
      )}

      {loadError && (
        <div className="mb-6">
          <BlockAlert variant="error" message={loadError} />
          <button
            type="button"
            onClick={reload}
            className="mt-3 cursor-pointer rounded-lg border border-tp-hairline px-3 py-1.5 text-sm text-tp-slate transition-colors hover:bg-tp-surface"
          >
            Try again
          </button>
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-tp-ink">Your API keys</h2>
        <Link
          to={CREATE_KEY}
          className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-tp-accent px-4 py-2 text-sm font-medium text-tp-on-primary transition-colors hover:bg-tp-primary-deep"
        >
          <FiPlus className="h-4 w-4" aria-hidden="true" />
          Create new API key
        </Link>
      </div>

      {snapshot && (
        <div className="mb-4 rounded-lg border border-tp-hairline bg-tp-canvas p-4">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="font-medium text-tp-ink">Active keys</span>
            <span className="text-tp-steel">
              {count} of {typeof limit === 'number' ? limit : limit === null ? 'unlimited' : '—'}{' '}
              keys
            </span>
          </div>
          {typeof limit === 'number' && (
            <div
              className="mt-2 h-1.5 overflow-hidden rounded-full bg-tp-hairline"
              role="meter"
              aria-label="Active keys"
              aria-valuemin={0}
              aria-valuemax={limit}
              aria-valuenow={count}
            >
              <div
                className={`h-full rounded-full ${atLimit ? 'bg-amber-500' : 'bg-tp-primary'}`}
                style={{ width: `${share}%` }}
              />
            </div>
          )}
          {atLimit && (
            <p className="mt-2 text-xs text-amber-800">
              You’ve reached your plan’s API key limit ({formatCount(limit)}). Revoke a key or ask
              for an agreement with more keys; creating one now returns 402.
            </p>
          )}
          <p className="mt-2 text-xs text-tp-steel">
            Treat a key like a password: it acts as you within its permissions. The secret is shown
            only once, when you create or rotate it; OpenBinding keeps only its prefix.
          </p>
        </div>
      )}

      {!snapshot && !loadError ? (
        <div
          className="rounded-lg border border-tp-hairline bg-tp-canvas p-8 text-center"
          aria-busy="true"
        >
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-tp-primary border-t-transparent" />
          <p className="mt-3 text-sm text-tp-steel">Loading…</p>
        </div>
      ) : (
        snapshot && (
          <ApiKeyList
            keys={snapshot.keys}
            loadedAt={snapshot.loadedAt}
            createTo={CREATE_KEY}
            onRotate={handleRotate}
            onRevoke={handleRevoke}
          />
        )
      )}

      {creating && (
        <CreateApiKeyDialog
          onClose={() => navigate(API_KEYS_PATH, { replace: true })}
          onCreated={handleCreated}
        />
      )}
    </div>
  );
}
