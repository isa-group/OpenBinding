// Adapted from SPHERE frontend/src/modules/settings/components/PublicProfileSection.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding keeps only the display name and the avatar (no bio, city, country or date of birth); in SCORETech
// Identity mode both are Identity's, shown read-only with "Edit in SCORETech Identity" (SPHERE hides the section there);
// in local mode they are saved through `PATCH /v1/users/me`, the field is OpenBinding's FormField with its saved flash, and a
// failure is said, never only logged.

import { useEffect, useState, type FormEvent } from 'react';
import { FiExternalLink } from 'react-icons/fi';
import { useAuthConfig } from '../../auth/contexts/authConfigContext';
import { useAuth } from '../../auth/hooks/useAuth';
import { classifyAuthError } from '../../core/api/errors';
import { FormField } from '../../core/components/form-field';
import UserAvatar from '../../core/components/user-avatar';
import { fallbackMessage } from '../../core/utils/account-errors';
import { useUserSettingsApi } from '../api/userSettingsApi';
import { identityAccountHref } from '../utils/identityAccount';
import { useSavedFlash } from '../utils/useSavedFlash';
import AvatarEditor from './AvatarEditor';
import SaveButton from './SaveButton';

const DISPLAY_NAME_MAX = 160;

interface Props {
  onDirtyChange?: (dirty: boolean) => void;
}

export default function PublicProfileSection({ onDirtyChange }: Props) {
  const { user, refresh } = useAuth();
  const config = useAuthConfig();
  const centralized = config.provider === 'scoretech';
  const api = useUserSettingsApi();
  const saved = user?.display_name ?? '';
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [justSaved, flash] = useSavedFlash();

  const value = displayName ?? saved;
  const dirty = !centralized && value.trim() !== saved;

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  if (!user) return null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      await api.updateProfile({ display_name: value.trim() });
      await refresh();
      setDisplayName(null);
      flash();
    } catch (caught) {
      setError(fallbackMessage(classifyAuthError(caught), 'saved'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-medium text-tp-ink">Public profile</h2>
        <p className="mt-0.5 text-sm text-tp-steel">
          How other people see you on OpenBinding: next to your username in organizations, runs and
          invitations.
        </p>
      </div>

      {centralized ? (
        <div className="rounded-[12px] border border-tp-hairline bg-tp-canvas p-6">
          <div className="flex flex-wrap items-center gap-5">
            <UserAvatar
              username={user.username}
              displayName={user.display_name}
              avatar={user.avatar}
              size={96}
            />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-tp-steel">Display name</p>
              <p className="mt-0.5 text-base font-medium break-words text-tp-ink">
                {user.display_name || 'No display name'}
              </p>
              <p className="mt-0.5 text-xs break-all text-tp-steel">@{user.username}</p>
            </div>
          </div>
          <p className="mt-5 max-w-[36rem] text-sm text-tp-steel">
            Your display name and avatar come from your SCORETech Identity profile. OpenBinding
            shows the ones you had when you last signed in.
          </p>
          <a
            className="mt-4 inline-flex cursor-pointer items-center gap-2 rounded-lg bg-tp-primary px-4 py-2.5 text-sm font-medium text-tp-on-primary"
            href={identityAccountHref(config.account_url)}
            target="_blank"
            rel="noopener noreferrer"
          >
            Edit in SCORETech Identity
            <FiExternalLink size={16} aria-hidden="true" />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        </div>
      ) : (
        <div className="rounded-[12px] border border-tp-hairline bg-tp-canvas p-6">
          <AvatarEditor
            username={user.username}
            displayName={user.display_name}
            avatar={user.avatar}
          />

          <div className="my-6 border-t border-tp-hairline" />

          <form onSubmit={submit} noValidate className="space-y-4">
            <FormField
              label="Display name"
              value={value}
              maxLength={DISPLAY_NAME_MAX}
              onChange={event => {
                setDisplayName(event.target.value);
                setError(undefined);
              }}
              placeholder="The name others will see"
              hint="Shown above your username. Leave it empty to show only your username."
              error={error}
            />
            <div className="flex items-center gap-3">
              <SaveButton
                type="submit"
                saving={saving}
                saved={justSaved}
                disabled={!dirty}
                label="Save display name"
              />
              {dirty && <span className="text-xs text-tp-steel">You have unsaved changes</span>}
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
