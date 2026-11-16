// Adapted from SPHERE frontend/src/modules/api-keys/components/ApiKeyCard.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: an OpenBinding key: its prefix (with a copy button), permissions, boundary and engine access, when it was created,
// last used and expires; Rotate and Revoke, each confirmed in OpenBinding's accessible dialog, instead of SPHERE's revoke and
// inline delete; expired instead of revoked (a revoked key is gone); react-icons instead of an inline SVG.

import { useState } from 'react';
import { FiKey } from 'react-icons/fi';
import { useCopy } from '../../core/hooks/useCopy';
import { formatDate } from '../../../utils/format';
import type { ApiKeySummary } from '../api/apiKeysApi';
import { boundaryLabels, describeEngineAccess } from '../utils/keysModel';

interface ApiKeyCardProps {
  keyData: ApiKeySummary;
  expired: boolean;
  onRotate: (key: ApiKeySummary) => Promise<void>;
  onRevoke: (key: ApiKeySummary) => Promise<void>;
}

export default function ApiKeyCard({ keyData, expired, onRotate, onRevoke }: ApiKeyCardProps) {
  const [loading, setLoading] = useState(false);
  const { copy, status } = useCopy();
  const copyState = status();
  const bounds = boundaryLabels(keyData.boundary);

  const run = async (action: (key: ApiKeySummary) => Promise<void>) => {
    setLoading(true);
    try {
      await action(keyData);
    } finally {
      setLoading(false);
    }
  };

  return (
    <article
      className="rounded-lg border border-tp-hairline bg-tp-canvas p-4"
      aria-label={keyData.name}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <FiKey className="h-5 w-5 shrink-0 text-tp-steel" aria-hidden="true" />
          <h3 className="font-medium break-all text-tp-ink">{keyData.name}</h3>
        </div>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            expired ? 'bg-amber-100 text-amber-800' : 'bg-green-100 text-green-700'
          }`}
        >
          {expired ? 'Expired' : 'Active'}
        </span>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <code className="rounded bg-tp-surface px-2 py-1 text-sm text-tp-slate">
          {keyData.prefix}…
        </code>
        <button
          type="button"
          onClick={() => void copy(keyData.prefix)}
          aria-label={`Copy prefix of ${keyData.name}`}
          className="cursor-pointer text-xs font-medium text-tp-link hover:underline"
        >
          {copyState === 'copied'
            ? 'Copied'
            : copyState === 'failed'
              ? 'Copy failed'
              : 'Copy prefix'}
        </button>
        <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-tp-steel">
          <span>Created {formatDate(keyData.created_at) ?? '—'}</span>
          <span>Last used {formatDate(keyData.last_used_at) ?? 'never'}</span>
          <span>
            {keyData.expires_at
              ? `${expired ? 'Expired' : 'Expires'} ${formatDate(keyData.expires_at)}`
              : 'No expiry'}
          </span>
        </span>
      </div>

      <dl className="mb-3 grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-xs font-medium text-tp-steel">Permissions</dt>
        <dd className="flex flex-wrap gap-1.5">
          {keyData.permissions.map(permission => (
            <code
              key={permission}
              className="rounded-full bg-tp-surface px-2 py-0.5 text-xs text-tp-slate"
            >
              {permission}
            </code>
          ))}
        </dd>
        <dt className="text-xs font-medium text-tp-steel">Engines</dt>
        <dd className="text-xs text-tp-ink">{describeEngineAccess(keyData.engine_access)}</dd>
        <dt className="text-xs font-medium text-tp-steel">Limited to</dt>
        <dd className="flex flex-wrap gap-1.5">
          {bounds.length > 0 ? (
            bounds.map(label => (
              <code
                key={label}
                className="rounded-full bg-tp-primary/10 px-2 py-0.5 text-xs text-tp-ink"
              >
                {label}
              </code>
            ))
          ) : (
            <span className="text-xs text-tp-steel">No extra limits</span>
          )}
        </dd>
      </dl>

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => void run(onRotate)}
          disabled={loading}
          aria-label={`Rotate ${keyData.name}`}
          className="cursor-pointer rounded-lg border border-tp-hairline px-3 py-1.5 text-sm text-tp-slate transition-colors hover:bg-tp-surface disabled:cursor-not-allowed disabled:opacity-50"
        >
          Rotate
        </button>
        <button
          type="button"
          onClick={() => void run(onRevoke)}
          disabled={loading}
          aria-label={`Revoke ${keyData.name}`}
          className="cursor-pointer rounded-lg border border-red-200 px-3 py-1.5 text-sm text-red-700 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Revoke
        </button>
      </div>
    </article>
  );
}
