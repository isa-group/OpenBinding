// Adapted from SPHERE frontend/src/modules/settings/components/AvatarEditor.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the avatar is SCORETech Identity's descriptor, so a local-mode avatar has the shape of an Identity one: Initials,
// Icons (Identity's five glyphs and SPHERE's predefined artwork, `avatar-{1-4,6-10}`) and Presets (Identity's four animals,
// in Identity's colours), with Identity's colour palette; the upload and the crop are not ported (F9), so neither is
// `react-easy-crop`; the artwork is drawn from Identity's inline copies instead of fetched; the dialog is OpenBinding's
// accessible Modal (focus trap, Escape), the choices are toggle buttons with names, and a failed save is said in the dialog;
// the change goes through `PATCH /v1/users/me` and the session is re-read so the header follows. Local mode only.

import { useState } from 'react';
import { motion } from 'framer-motion';
import { FiCamera, FiCheck, FiLoader } from 'react-icons/fi';
import { useAuth } from '../../auth/hooks/useAuth';
import { classifyAuthError } from '../../core/api/errors';
import { Modal } from '../../core/components/modal';
import UserAvatar from '../../core/components/user-avatar';
import {
  avatarChoices,
  avatarIcons,
  avatarPalette,
  avatarPresets,
  type AvatarDescriptor,
} from '../../core/components/user-avatar/avatar-values';
import { fallbackMessage } from '../../core/utils/account-errors';
import { useUserSettingsApi } from '../api/userSettingsApi';

type Mode = AvatarDescriptor['kind'];
type IconId = Extract<AvatarDescriptor, { kind: 'icon' }>['assetId'];
type PresetId = Extract<AvatarDescriptor, { kind: 'preset' }>['assetId'];

const MODES: Array<{ id: Mode; label: string }> = [
  { id: 'initials', label: 'Initials' },
  { id: 'icon', label: 'Icons' },
  { id: 'preset', label: 'Presets' },
];
const ICONS: ReadonlyArray<{ id: IconId; label: string }> = [...avatarIcons, ...avatarChoices];

const DEFAULT_BACKGROUND = '#be1d37';
const DEFAULT_FOREGROUND = '#ffffff';

const choice = (selected: boolean) =>
  `cursor-pointer rounded-[8px] border-2 transition-colors ${
    selected
      ? 'border-tp-primary ring-1 ring-tp-primary/30'
      : 'border-tp-hairline hover:border-tp-hairline-strong'
  }`;

interface Props {
  username: string;
  displayName?: string | null;
  avatar?: AvatarDescriptor | null;
}

export default function AvatarEditor({ username, displayName, avatar }: Props) {
  const api = useUserSettingsApi();
  const { refresh } = useAuth();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>(avatar?.kind ?? 'initials');
  const [icon, setIcon] = useState<IconId>(avatar?.kind === 'icon' ? avatar.assetId : 'spark');
  const [preset, setPreset] = useState<PresetId>(
    avatar?.kind === 'preset' ? avatar.assetId : 'owl'
  );
  const [bgColor, setBgColor] = useState(
    avatar && 'backgroundColor' in avatar ? avatar.backgroundColor : DEFAULT_BACKGROUND
  );
  const [fgColor, setFgColor] = useState(
    avatar && 'foregroundColor' in avatar ? avatar.foregroundColor : DEFAULT_FOREGROUND
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const draft: AvatarDescriptor =
    mode === 'preset'
      ? { kind: 'preset', assetId: preset }
      : mode === 'icon'
        ? { kind: 'icon', assetId: icon, backgroundColor: bgColor, foregroundColor: fgColor }
        : { kind: 'initials', backgroundColor: bgColor, foregroundColor: fgColor };

  const save = async (value: AvatarDescriptor | null) => {
    setSaving(true);
    setError(null);
    try {
      await api.updateProfile({ avatar: value });
      await refresh();
      setOpen(false);
    } catch (caught) {
      setError(fallbackMessage(classifyAuthError(caught), 'saved'));
    } finally {
      setSaving(false);
    }
  };

  const swatches = (label: string, value: string, set: (colour: string) => void) => (
    <div>
      <p className="mb-2 text-xs font-medium text-tp-steel" id={`avatar-${label}`}>
        {label}
      </p>
      <div role="group" aria-labelledby={`avatar-${label}`} className="flex flex-wrap gap-2">
        {avatarPalette.map(colour => (
          <button
            key={colour}
            type="button"
            onClick={() => set(colour)}
            aria-pressed={value === colour}
            aria-label={`${label} ${colour}`}
            className={`h-7 w-7 cursor-pointer rounded-full border transition-transform hover:scale-110 ${
              value === colour
                ? 'border-0 ring-2 ring-tp-primary ring-offset-2 ring-offset-tp-canvas'
                : 'border-tp-hairline'
            }`}
            style={{ backgroundColor: colour }}
          />
        ))}
      </div>
    </div>
  );

  return (
    <>
      <div className="flex flex-col items-center">
        <motion.button
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Change avatar"
          className="group relative cursor-pointer overflow-hidden rounded-full shadow-elevation-2 ring-2 ring-tp-hairline transition-shadow hover:ring-tp-primary"
        >
          <UserAvatar username={username} displayName={displayName} avatar={avatar} size={96} />
          <span className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
            <FiCamera className="h-6 w-6 text-white" aria-hidden="true" />
          </span>
        </motion.button>
        <p className="mt-2 text-xs text-tp-steel">Click to change avatar</p>
      </div>

      {open && (
        <Modal title="Edit avatar" onClose={() => !saving && setOpen(false)} size="lg">
          <div className="space-y-5">
            <div className="flex justify-center">
              <UserAvatar username={username} displayName={displayName} avatar={draft} size={96} />
            </div>

            <div>
              <p className="mb-2 text-xs font-medium text-tp-steel" id="avatar-options">
                Options
              </p>
              <div role="group" aria-labelledby="avatar-options" className="flex flex-wrap gap-2">
                {MODES.map(option => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setMode(option.id)}
                    aria-pressed={mode === option.id}
                    className={`cursor-pointer rounded-[6px] border px-3 py-2 text-xs font-medium transition-colors ${
                      mode === option.id
                        ? 'border-tp-primary bg-tp-primary/10 text-tp-primary'
                        : 'border-tp-hairline-strong text-tp-ink hover:border-tp-hairline'
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            {mode === 'icon' && (
              <div role="group" aria-label="Icons" className="grid grid-cols-5 gap-2.5">
                {ICONS.map(option => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setIcon(option.id)}
                    aria-pressed={icon === option.id}
                    aria-label={option.label}
                    title={option.label}
                    className={`flex aspect-square items-center justify-center ${choice(icon === option.id)}`}
                  >
                    <UserAvatar
                      username={username}
                      avatar={{
                        kind: 'icon',
                        assetId: option.id,
                        backgroundColor: bgColor,
                        foregroundColor: fgColor,
                      }}
                      size={40}
                    />
                  </button>
                ))}
              </div>
            )}

            {mode === 'preset' && (
              <div role="group" aria-label="Presets" className="grid grid-cols-4 gap-2.5">
                {avatarPresets.map(option => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setPreset(option.id)}
                    aria-pressed={preset === option.id}
                    aria-label={option.label}
                    title={option.label}
                    className={`flex aspect-square items-center justify-center ${choice(preset === option.id)}`}
                  >
                    <UserAvatar
                      username={username}
                      avatar={{ kind: 'preset', assetId: option.id }}
                      size={40}
                    />
                  </button>
                ))}
              </div>
            )}

            {mode !== 'preset' && (
              <div className="space-y-3">
                {swatches('Background colour', bgColor, setBgColor)}
                {swatches(mode === 'icon' ? 'Icon colour' : 'Text colour', fgColor, setFgColor)}
              </div>
            )}

            {error && (
              <p role="alert" className="text-sm text-tp-severity-error">
                {error}
              </p>
            )}

            <div className="flex flex-wrap justify-between gap-2 border-t border-tp-hairline pt-4">
              {avatar && (
                <button
                  type="button"
                  onClick={() => void save(null)}
                  disabled={saving}
                  className="flex cursor-pointer items-center gap-2 rounded-[8px] border border-red-300 px-4 py-2.5 text-sm font-medium text-red-700 transition-colors hover:bg-red-50 disabled:opacity-40"
                >
                  Remove avatar
                </button>
              )}
              <div className="ml-auto flex gap-2">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  disabled={saving}
                  className="cursor-pointer rounded-[8px] px-4 py-2.5 text-sm font-medium text-tp-steel transition-colors hover:text-tp-ink"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void save(draft)}
                  disabled={saving}
                  aria-busy={saving || undefined}
                  className="flex cursor-pointer items-center gap-2 rounded-[8px] bg-tp-primary px-4 py-2.5 text-sm font-medium text-tp-on-primary disabled:opacity-40"
                >
                  {saving ? (
                    <FiLoader className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <FiCheck className="h-4 w-4" aria-hidden="true" />
                  )}
                  Save avatar
                </button>
              </div>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
