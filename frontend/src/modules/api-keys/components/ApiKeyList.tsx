// Adapted from SPHERE frontend/src/modules/api-keys/components/ApiKeyList.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's keys and actions (rotate, revoke), which keys have expired, and the empty state's link to create one;
// react-icons instead of an inline SVG.

import { Link } from 'react-router-dom';
import { FiKey } from 'react-icons/fi';
import type { ApiKeySummary } from '../api/apiKeysApi';
import ApiKeyCard from './ApiKeyCard';

interface ApiKeyListProps {
  keys: ApiKeySummary[];
  /** When the list was read (ms): a key that expired before is shown as expired. */
  loadedAt: number;
  createTo: string;
  onRotate: (key: ApiKeySummary) => Promise<void>;
  onRevoke: (key: ApiKeySummary) => Promise<void>;
}

export default function ApiKeyList({
  keys,
  loadedAt,
  createTo,
  onRotate,
  onRevoke,
}: ApiKeyListProps) {
  if (keys.length === 0) {
    return (
      <div className="rounded-lg border border-tp-hairline bg-tp-canvas p-8 text-center">
        <FiKey className="mx-auto h-12 w-12 text-tp-steel" aria-hidden="true" />
        <h3 className="mt-3 text-sm font-medium text-tp-ink">No API keys</h3>
        <p className="mt-1 text-sm text-tp-steel">
          Create an API key to call OpenBinding from scripts or CI.
        </p>
        <Link
          to={createTo}
          className="mt-3 inline-block cursor-pointer text-sm font-medium text-tp-link hover:underline"
        >
          Create your first key
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {keys.map(key => (
        <ApiKeyCard
          key={key.id}
          keyData={key}
          expired={
            Boolean(key.expires_at) && new Date(key.expires_at as string).getTime() <= loadedAt
          }
          onRotate={onRotate}
          onRevoke={onRevoke}
        />
      ))}
    </div>
  );
}
