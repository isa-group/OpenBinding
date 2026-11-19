// Adapted from SPHERE frontend/src/modules/settings/components/IntegrationsSection.tsx (revision 73779a8a), through
// OpenBinding's own copy of it (removed with CAS in F5), https://github.com/SCORELabUS/SPHERE.
// Copyright (c) 2024 Alejandro García Fernández. MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: one provider row for the organization's SPHERE key instead of the account's identities: not connected (a
// write-only password field and Connect), connected as a SPHERE user with the key's scopes in words, its hint and when it was
// validated, or refused by SPHERE (Replace the key); replacing asks in the Modal, removing with `customConfirm`; a 412 offers
// to reload.

import { useState, type FormEvent } from 'react';
import { FiAlertTriangle, FiCheck, FiKey, FiLoader, FiTrash2 } from 'react-icons/fi';
import { readApiError } from '../../../core/api/errors';
import BlockAlert from '../../../core/components/block-alert';
import { FormField } from '../../../core/components/form-field';
import { Modal } from '../../../core/components/modal';
import customConfirm from '../../../core/utils/custom-confirm';
import { formatDate } from '../../../core/utils/format';
import { offerReloadIfChanged } from '../../../core/utils/offer-reload';
import type { ConnectionView } from '../../api/connectionsApi';
import { scopesText } from './scopes';

/** A SPHERE API key as the gateway accepts it: `sk-` and 64 hexadecimal characters. */
const KEY_FORM = /^sk-[0-9a-f]{64}$/;

/** What a refusal of the key means, in words. */
function refusalText(caught: unknown): string {
  const read = readApiError(caught);
  if (read.code === 'sphere_key_rejected')
    return `SPHERE refused the key${read.message ? `: ${read.message}` : '.'}`;
  if (read.code === 'sphere_key_malformed')
    return 'A SPHERE key is sk- followed by 64 hexadecimal characters.';
  if (read.code === 'secrets_unavailable')
    return 'This installation keeps no secrets yet (no encryption key is set), so it cannot store a SPHERE key.';
  if (read.status === 503 || read.code === 'sphere_busy' || read.code === 'sphere_unavailable')
    return 'SPHERE could not be asked about the key right now. Try again in a moment.';
  return `The key could not be saved${read.message ? `: ${read.message}` : '.'}`;
}

function KeyForm({
  label,
  busy,
  error,
  onSubmit,
}: {
  label: string;
  busy: boolean;
  error: string | null;
  onSubmit: (key: string) => void;
}) {
  const [key, setKey] = useState('');
  const trimmed = key.trim();
  const malformed = trimmed !== '' && !KEY_FORM.test(trimmed);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (KEY_FORM.test(trimmed)) onSubmit(trimmed);
  };
  return (
    <form className="flex min-w-0 flex-col gap-3" onSubmit={submit}>
      <FormField
        label="SPHERE API key"
        type="password"
        autoComplete="off"
        spellCheck={false}
        mono
        value={key}
        onChange={event => setKey(event.target.value)}
        placeholder="sk-…"
        error={
          malformed
            ? 'A SPHERE key is sk- followed by 64 hexadecimal characters.'
            : (error ?? undefined)
        }
        hint="Written once and never shown again: only its last four characters are kept in view."
      />
      <div>
        <button
          type="submit"
          disabled={busy || !KEY_FORM.test(trimmed)}
          className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-tp-accent px-4 py-2 text-sm font-semibold text-tp-on-primary transition-colors hover:bg-tp-accent-hover disabled:cursor-not-allowed disabled:opacity-45"
        >
          {busy && <FiLoader className="h-4 w-4 animate-spin" aria-hidden="true" />}
          {busy ? 'Asking SPHERE…' : label}
        </button>
      </div>
    </form>
  );
}

interface Props {
  connection: ConnectionView | null;
  /** The revision a replace sends back (`If-Match`), when the last write answered one. */
  etag: string | null;
  onSave: (key: string, ifMatch: string | null) => Promise<void>;
  onRemove: () => Promise<void>;
  onReload: () => void;
}

/** The organization's SPHERE key: connect it, see whose it is and what it may read, replace or remove it. */
export default function SphereKeyCard({ connection, etag, onSave, onRemove, onReload }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const save = async (key: string) => {
    setBusy(true);
    setError(null);
    try {
      await onSave(key, connection ? etag : null);
      setReplacing(false);
      setMessage('SPHERE accepted the key.');
    } catch (caught) {
      if (!offerReloadIfChanged(caught, { resource: 'the SPHERE connection', reload: onReload }))
        setError(refusalText(caught));
    } finally {
      setBusy(false);
    }
  };

  const remove = () =>
    customConfirm(
      'Remove the SPHERE key? The organization stops reading its private SPHERE pricings until a key is connected again.',
      { confirmLabel: 'Remove', cancelLabel: 'Keep it', danger: true }
    ).then(
      async () => {
        try {
          await onRemove();
          setMessage('The SPHERE key was removed.');
        } catch (caught) {
          setError(refusalText(caught));
        }
      },
      () => undefined
    );

  return (
    <div className="overflow-hidden rounded-[12px] border border-tp-hairline bg-tp-canvas">
      <div className="flex flex-wrap items-start gap-3 border-b border-tp-hairline px-5 py-4 sm:px-6">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] bg-tp-primary/10">
          <FiKey className="h-4 w-4 text-tp-accent" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium text-tp-ink">SPHERE</h3>
          <p className="mt-0.5 text-xs text-tp-steel">
            With a key, the organization’s members search and import its private SPHERE pricings.
          </p>
        </div>
        {connection && (
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${connection.status === 'active' ? 'bg-emerald-50 text-emerald-800' : 'bg-tp-severity-warning-bg text-tp-warning-text'}`}
          >
            {connection.status === 'active' ? (
              <FiCheck className="h-3 w-3" aria-hidden="true" />
            ) : (
              <FiAlertTriangle className="h-3 w-3" aria-hidden="true" />
            )}
            {connection.status === 'active' ? 'Connected' : 'Refused by SPHERE'}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-4 px-5 py-4 sm:px-6">
        <BlockAlert
          variant="success"
          message={message ?? undefined}
          onDismiss={() => setMessage(null)}
        />
        {connection ? (
          <>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-[13px] sm:grid-cols-2 [&_dd]:[overflow-wrap:anywhere] [&_dd]:text-tp-ink [&_dt]:text-xs [&_dt]:text-tp-steel">
              <div>
                <dt>Connected as</dt>
                <dd>{connection.username ?? 'a SPHERE user'}</dd>
              </div>
              <div>
                <dt>The key may act in</dt>
                <dd>{scopesText(connection.scopes)}</dd>
              </div>
              <div>
                <dt>Key</dt>
                <dd className="font-mono">…{connection.keyHint}</dd>
              </div>
              <div>
                <dt>Checked with SPHERE</dt>
                <dd>{formatDate(connection.validatedAt ?? null) ?? 'not yet'}</dd>
              </div>
            </dl>
            {connection.status === 'invalid' && (
              <BlockAlert
                variant="error"
                message="SPHERE refused this key when it was last used. Replace it to read private pricings again; public ones are read anonymously meanwhile."
              />
            )}
            {error && !replacing && <BlockAlert variant="error" message={error} />}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setReplacing(true);
                }}
                className="cursor-pointer rounded-[8px] border border-tp-hairline-strong px-3.5 py-2 text-xs font-medium text-tp-ink transition-colors hover:bg-tp-surface"
              >
                Replace the key
              </button>
              <button
                type="button"
                onClick={() => void remove()}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-[8px] px-3.5 py-2 text-xs font-medium text-red-700 transition-colors hover:bg-red-50"
              >
                <FiTrash2 className="h-3.5 w-3.5" aria-hidden="true" />
                Remove
              </button>
            </div>
          </>
        ) : (
          <KeyForm label="Connect" busy={busy} error={error} onSubmit={key => void save(key)} />
        )}
      </div>
      {replacing && connection && (
        <Modal title="Replace the SPHERE key" onClose={() => setReplacing(false)}>
          <p className="mb-3 text-sm text-tp-slate">
            SPHERE checks the new key first; the old one stays until it accepts it.
          </p>
          <KeyForm label="Replace" busy={busy} error={error} onSubmit={key => void save(key)} />
        </Modal>
      )}
    </div>
  );
}
