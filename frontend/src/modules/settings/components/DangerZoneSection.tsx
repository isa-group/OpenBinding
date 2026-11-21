// Adapted from SPHERE frontend/src/modules/settings/components/DangerZoneSection.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's deletion (`DELETE /v1/users/me` with the typed username and the current password) and its refusals
// (the last owner of an organization hands it over first); the confirmation is OpenBinding's accessible Modal instead of
// SPHERE's portaled motion overlay; the browser leaves with a clean session; the current password is asked only of an
// account that has one (`password_enabled`); SPHERE's SCORETech wording (the Identity account stays) in Identity mode.

import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { FiAlertTriangle, FiLoader, FiShield, FiTrash2 } from 'react-icons/fi';
import { apiClient } from '../../core/api/http';
import { leaveTo } from '../../core/utils/navigation';
import { useAuth } from '../../auth/hooks/useAuth';
import { useAuthConfig } from '../../auth/contexts/authConfigContext';
import { classifyAuthError, marker } from '../../core/api/errors';
import { FormField } from '../../core/components/form-field';
import { Modal } from '../../core/components/modal';
import { useUserSettingsApi } from '../api/userSettingsApi';
import { fallbackMessage } from '../../core/utils/account-errors';

const WRONG_PASSWORD = 'That isn’t your current password (401 · invalid_credentials).';
const MISMATCH = 'The text doesn’t match your username (422 · confirmation_mismatch).';

interface Refusal {
  text: string;
  /** The last owner of an organization: the place to hand it over. */
  orgs?: boolean;
}

export default function DangerZoneSection() {
  const { user } = useAuth();
  const centralized = useAuthConfig().provider === 'scoretech';
  const asksPassword = user?.password_enabled ?? true;
  const api = useUserSettingsApi();
  const [showConfirm, setShowConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<Refusal | null>(null);
  const [passwordError, setPasswordError] = useState<string>();
  const [confirmText, setConfirmText] = useState('');
  const [password, setPassword] = useState('');

  const username = user?.username ?? '';
  const isConfirmed = username !== '' && confirmText === username;

  const closeModal = () => {
    if (deleting) return;
    setShowConfirm(false);
    setError(null);
    setPasswordError(undefined);
    setConfirmText('');
    setPassword('');
  };

  const confirmDelete = async (event: FormEvent) => {
    event.preventDefault();
    if (!isConfirmed) {
      setError({ text: MISMATCH });
      return;
    }
    setDeleting(true);
    setError(null);
    setPasswordError(undefined);
    try {
      await api.deleteAccount(confirmText, password);
      // The account no longer exists; nothing to revoke. Leave with a clean browser.
      apiClient.clearTokens();
      leaveTo('/');
    } catch (caught) {
      const failure = classifyAuthError(caught);
      if (failure.kind === 'rejected') setPasswordError(WRONG_PASSWORD);
      else if (failure.kind === 'invalid') setError({ text: MISMATCH });
      else if (failure.kind === 'conflict' && failure.code === 'last_owner')
        setError({
          text: 'You own an organization (409 · last_owner). Hand the organization over to another member, or delete it, first.',
          orgs: true,
        });
      else if (failure.kind === 'conflict' && failure.code === 'last_pricing_admin')
        setError({
          text: 'You’re the last pricing administrator (409 · last_pricing_admin). Another admin must exist before this account can go.',
        });
      else if (failure.kind === 'conflict')
        setError({
          text: `${failure.message ?? 'The account can’t be deleted now.'}${marker(failure)}`,
        });
      else setError({ text: fallbackMessage(failure, 'deleted') });
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-medium text-tp-ink">Danger Zone</h2>
        <p className="mt-0.5 text-sm text-tp-steel">Irreversible actions on your account</p>
      </div>

      <div className="rounded-[12px] border border-red-200 bg-tp-canvas p-6">
        <div className="flex items-start gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[8px] bg-red-50">
            <FiAlertTriangle className="h-5 w-5 text-red-600" aria-hidden="true" />
          </div>
          <div className="flex-1">
            <h3 className="text-sm font-medium text-tp-ink">
              {centralized ? 'Delete OpenBinding account' : 'Delete account'}
            </h3>
            <p className="mt-1 text-sm text-tp-steel">
              Permanently deletes your account, its API keys, memberships and notifications. The
              runs and engines you created stay without your name, and your federated engines are
              deactivated. Organizations you own must be handed over first.
            </p>
            {centralized && (
              <p className="mt-2 text-sm text-tp-steel">
                Your SCORETech Identity account and your access to other SCORE services remain
                separate.
              </p>
            )}
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              type="button"
              onClick={() => setShowConfirm(true)}
              className="mt-4 flex cursor-pointer items-center gap-2 rounded-[8px] border border-red-300 bg-tp-canvas px-4 py-2.5 text-sm font-medium text-red-700 transition-colors hover:bg-red-50"
            >
              <FiTrash2 className="h-4 w-4" aria-hidden="true" />
              Delete my account
            </motion.button>
          </div>
        </div>
      </div>

      {showConfirm && (
        <Modal title="Confirm deletion" tone="danger" size="sm" onClose={closeModal}>
          <form onSubmit={confirmDelete} noValidate className="space-y-4">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[8px] bg-red-50">
                <FiAlertTriangle className="h-5 w-5 text-red-600" aria-hidden="true" />
              </div>
              <div>
                <p className="text-sm text-tp-ink">
                  Are you sure you want to delete your account? This can’t be undone.
                </p>
                <p className="mt-2 text-sm text-tp-steel">
                  You will lose your API keys, memberships, notifications and settings.
                </p>
              </div>
            </div>

            <FormField
              label={`Type ${username} to confirm`}
              value={confirmText}
              onChange={event => {
                setConfirmText(event.target.value);
                setError(null);
              }}
              disabled={deleting}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder={username}
              mono
            />
            {asksPassword && (
              <FormField
                label="Current password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={event => {
                  setPassword(event.target.value);
                  setPasswordError(undefined);
                }}
                disabled={deleting}
                error={passwordError}
              />
            )}

            <div aria-live="assertive">
              {error && (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-[8px] border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-700"
                >
                  <FiShield className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>
                    {error.text}
                    {error.orgs && (
                      <>
                        {' '}
                        <Link to="/me/orgs" className="cursor-pointer font-medium underline">
                          Your organizations
                        </Link>
                      </>
                    )}
                  </span>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={closeModal}
                disabled={deleting}
                className="cursor-pointer rounded-[8px] px-4 py-2.5 text-sm font-medium text-tp-steel transition-colors hover:text-tp-ink disabled:cursor-not-allowed disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={deleting || !isConfirmed}
                aria-busy={deleting || undefined}
                className="flex cursor-pointer items-center gap-2 rounded-[8px] bg-red-700 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {deleting ? (
                  <FiLoader className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <FiTrash2 className="h-4 w-4" aria-hidden="true" />
                )}
                {deleting ? 'Deleting…' : 'Delete account'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
