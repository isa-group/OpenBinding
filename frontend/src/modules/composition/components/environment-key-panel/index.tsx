// An environment's feed: its address, the download of the composition in effect, and its feed keys (ADMIN). The block that
// shows a new key once is OpenBinding's API keys page block (frontend/src/modules/api-keys/pages/api-keys-page), itself
// adapted from SPHERE frontend/src/modules/api-keys/pages/ApiKeysPage.tsx (revision fc776b4d),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: an environment's own feed keys (`obe_…`) instead of a person's API keys: they read that environment's feed and
// nothing else, outlive whoever made them and are at most two live at once (rotation: make the second, reconfigure the
// application, revoke the first). The secret is held only until it is dismissed; the list shows hints, who made each key
// (marked when that person left the organization) and when it was last used. A reader below ADMIN sees how many keys exist.

import { formatDistanceToNow, parseISO } from 'date-fns';
import { useState, type FormEvent } from 'react';
import { FiCheck, FiCopy } from 'react-icons/fi';
import { readApiError } from '../../../core/api/errors';
import type { CompositionEnvironmentView, FeedKeyCreated } from '../../../core/api/types';
import BlockAlert from '../../../core/components/block-alert';
import { CopyField } from '../../../core/components/copy-field';
import { useCopy } from '../../../core/hooks/useCopy';
import customConfirm from '../../../core/utils/custom-confirm';
import { gatewayUrl } from '../../../core/utils/gatewayUrl';
import { useEnvironmentsApi } from '../../api/environmentsApi';
import { saveText } from '../../utils/download';

/** At most this many live keys per environment: two, so a key can be rotated without a gap. */
export const MAX_LIVE_KEYS = 2;

const actionClass =
  'flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-tp-input-border bg-tp-input-bg px-3 text-xs text-tp-ink transition-colors hover:bg-tp-surface disabled:cursor-default disabled:opacity-50';

interface Props {
  org: string;
  composition: string;
  environment: CompositionEnvironmentView;
  /** ADMIN: the keys are listed, made and revoked. */
  canAdminister: boolean;
  /** The environment's keys changed: read it again. */
  onChanged: () => void;
}

export default function EnvironmentKeyPanel({
  org,
  composition,
  environment,
  canAdminister,
  onChanged,
}: Props) {
  const api = useEnvironmentsApi();
  const { copy, status } = useCopy();
  const [secret, setSecret] = useState<FeedKeyCreated | null>(null);
  const [making, setMaking] = useState(false);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const keys = environment.keys ?? [];
  const live = keys.filter(key => !key.revokedAt);
  const full = live.length >= MAX_LIVE_KEYS;
  const address = gatewayUrl(environment.feed.path);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const created = await api.createFeedKey(org, composition, environment.slug, label.trim());
      setSecret(created);
      setMaking(false);
      setLabel('');
      onChanged();
    } catch (caught) {
      const refusal = readApiError(caught);
      setError(
        refusal.code === 'feed_key_limit'
          ? 'This environment has two live keys: revoke one first.'
          : `The key couldn’t be made${refusal.code ? ` (${refusal.code})` : ''}${refusal.message ? `: ${refusal.message}` : '.'}`
      );
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string, hint: string) => {
    try {
      await customConfirm(
        `Revoke ${hint}? An application reading the feed with it gets “not authorised” from its next request.`,
        { danger: true, confirmLabel: 'Revoke key' }
      );
    } catch {
      return;
    }
    setError('');
    try {
      await api.revokeFeedKey(org, composition, environment.slug, id);
      onChanged();
    } catch (caught) {
      setError(`The key couldn’t be revoked: ${readApiError(caught).message}`);
    }
  };

  const download = async () => {
    setError('');
    try {
      saveText(
        await api.downloadInEffect(org, composition, environment.slug),
        `${composition}-${environment.slug}.yaml`
      );
    } catch (caught) {
      setError(`The composition in effect couldn’t be downloaded: ${readApiError(caught).message}`);
    }
  };

  return (
    <section
      aria-labelledby={`feed-${environment.slug}`}
      className="flex flex-col gap-4 rounded-xl border border-tp-hairline bg-tp-canvas px-5 py-4"
    >
      <div>
        <h3 id={`feed-${environment.slug}`} className="text-sm font-semibold text-tp-ink">
          Feed
        </h3>
        <p className="text-xs text-tp-steel">
          Applications read the composition in effect here with a feed key, and poll it: it changes
          only when someone adopts a version.
        </p>
      </div>
      <CopyField value={address} label="feed address" />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void download()}
          disabled={!environment.inEffect}
          className={actionClass}
        >
          Download the composition in effect
        </button>
        {!environment.inEffect && (
          <span className="text-xs text-tp-steel">Nothing is adopted here yet.</span>
        )}
      </div>

      {secret && (
        <BlockAlert variant="warning">
          <div className="min-w-0">
            <p className="mb-2 font-medium">
              {secret.key.label
                ? `Feed key “${secret.key.label}” has been created`
                : 'Your feed key has been created'}
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
                aria-label={status() === 'copied' ? 'Copied' : 'Copy key'}
                title={status() === 'copied' ? 'Copied' : 'Copy key'}
              >
                {status() === 'copied' ? (
                  <FiCheck className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <FiCopy className="h-4 w-4" aria-hidden="true" />
                )}
              </button>
            </div>
            <p className="mt-2 text-sm">
              Copy this key now. You won’t be able to see it again. Configure the application with
              it as <code>X-API-Key</code> or <code>Authorization: Bearer</code>; it reads this
              environment’s feed and nothing else.
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

      {canAdminister ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-xs font-semibold tracking-wide text-tp-steel uppercase">
              Feed keys
            </h4>
            {!making && (
              <button
                type="button"
                onClick={() => setMaking(true)}
                disabled={full}
                className={actionClass}
                title={full ? 'Revoke a key first: an environment has at most two.' : undefined}
              >
                Create key
              </button>
            )}
          </div>
          {full && !making && (
            <p className="text-xs text-tp-steel">
              Two live keys, the most an environment has: revoke one before making another.
            </p>
          )}
          {making && (
            <form
              onSubmit={event => void create(event)}
              className="flex flex-wrap items-end gap-2"
              noValidate
            >
              <label className="flex flex-col gap-1 text-xs font-medium text-tp-ink">
                Key label
                <input
                  value={label}
                  onChange={event => setLabel(event.target.value)}
                  maxLength={80}
                  placeholder="Where it is configured"
                  className="h-9 w-64 max-w-full rounded-md border border-tp-input-border bg-tp-input-bg px-3 text-sm font-normal text-tp-ink outline-none focus:border-tp-primary"
                />
              </label>
              <button
                type="submit"
                disabled={busy}
                className="h-9 cursor-pointer rounded-lg bg-tp-primary px-3 text-xs font-semibold text-white hover:bg-tp-primary/90 disabled:opacity-50"
              >
                {busy ? 'Creating…' : 'Create'}
              </button>
              <button type="button" onClick={() => setMaking(false)} className={actionClass}>
                Cancel
              </button>
            </form>
          )}
          {keys.length === 0 ? (
            <p className="text-sm text-tp-steel">No feed key yet.</p>
          ) : (
            <ul
              aria-label="Feed keys"
              className="divide-y divide-tp-hairline rounded-lg border border-tp-hairline"
            >
              {keys.map(key => (
                <li
                  key={key.id}
                  className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm">
                      <code className="font-mono text-tp-ink">{key.hint}</code>
                      {key.label && <span className="text-tp-slate">{key.label}</span>}
                      {key.revokedAt && (
                        <span className="rounded-full bg-tp-surface px-2 py-0.5 text-[10px] text-tp-steel">
                          Revoked
                        </span>
                      )}
                    </p>
                    <p className="text-[11px] text-tp-steel">
                      {`Created ${formatDistanceToNow(parseISO(key.createdAt))} ago`}
                      {key.createdBy ? ` by ${key.createdBy}` : ''}
                      {key.creatorIsMember ? '' : ', who is no longer in the organization'}
                      {' · '}
                      {key.lastUsedAt
                        ? `last used ${formatDistanceToNow(parseISO(key.lastUsedAt))} ago`
                        : 'never used'}
                    </p>
                  </div>
                  {!key.revokedAt && (
                    <button
                      type="button"
                      onClick={() => void revoke(key.id, key.hint)}
                      className={`${actionClass} text-red-700`}
                    >
                      Revoke
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <p className="text-xs text-tp-steel">
          {environment.keyCount === 1
            ? 'One live feed key.'
            : `${environment.keyCount} live feed keys.`}{' '}
          An admin of this organization makes and revokes them.
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      )}
    </section>
  );
}
