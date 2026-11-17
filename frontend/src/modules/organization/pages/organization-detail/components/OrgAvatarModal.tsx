// Adapted from SPHERE frontend/src/modules/organization/pages/organization-detail/components/OrgAvatarModal.tsx (revision
// 73779a8a), https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the predefined avatars are the gateway's (`GET /v1/avatars`), not a list kept here; the colour swatches are
// theme tokens (`--color-tp-avatar-*`) whose values are sent; the upload is cropped square with react-easy-crop and sent as
// the raw body; OpenBinding's accessible dialog with the three modes as tabs; refusals shown in place.

import { useCallback, useEffect, useState } from 'react';
import Cropper, { type Area } from 'react-easy-crop';
import { readApiError } from '../../../../core/api/errors';
import BlockAlert from '../../../../core/components/block-alert';
import { Modal } from '../../../../core/components/modal';
import OrgAvatar from '../../../../core/components/org-avatar';
import { useOrganizationsApi, type Organization } from '../../../api/organizationsApi';

interface Props {
  org: Organization;
  onClose: () => void;
  onSaved: (updated: Organization) => void;
}

/** The swatches, by token: the classes are written out so Tailwind generates them. */
const SWATCHES = [
  { token: '--color-tp-avatar-1', className: 'bg-tp-avatar-1' },
  { token: '--color-tp-avatar-2', className: 'bg-tp-avatar-2' },
  { token: '--color-tp-avatar-3', className: 'bg-tp-avatar-3' },
  { token: '--color-tp-avatar-4', className: 'bg-tp-avatar-4' },
  { token: '--color-tp-avatar-5', className: 'bg-tp-avatar-5' },
  { token: '--color-tp-avatar-6', className: 'bg-tp-avatar-6' },
  { token: '--color-tp-avatar-7', className: 'bg-tp-avatar-7' },
  { token: '--color-tp-avatar-8', className: 'bg-tp-avatar-8' },
  { token: '--color-tp-avatar-9', className: 'bg-tp-avatar-9' },
  { token: '--color-tp-avatar-10', className: 'bg-tp-avatar-10' },
  { token: '--color-tp-avatar-11', className: 'bg-tp-avatar-11' },
  { token: '--color-tp-avatar-12', className: 'bg-tp-avatar-12' },
  { token: '--color-tp-avatar-13', className: 'bg-tp-avatar-13' },
  { token: '--color-tp-avatar-14', className: 'bg-tp-avatar-14' },
  { token: '--color-tp-avatar-15', className: 'bg-tp-avatar-15' },
] as const;

const MAX_BYTES = 2 * 1024 * 1024;
const OUTPUT_SIZE = 256;
const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp'];

type AvatarMode = 'initials' | 'predefined' | 'upload';

/** The hex value of a swatch token, as the theme defines it. */
function tokenValue(token: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(token).trim().toLowerCase();
}

/** The predefined file an avatar URL names (`/v1/avatars/<file>`). */
function predefinedFile(org: Organization): string | null {
  return org.avatar?.kind === 'predefined' && org.avatar.url
    ? (org.avatar.url.split('/').pop() ?? null)
    : null;
}

async function cropToSquare(imageSrc: string, area: Area): Promise<Blob> {
  const image = new Image();
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = reject;
    image.src = imageSrc;
  });
  const canvas = document.createElement('canvas');
  canvas.width = OUTPUT_SIZE;
  canvas.height = OUTPUT_SIZE;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser cannot crop images.');
  context.drawImage(image, area.x, area.y, area.width, area.height, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      blob => (blob ? resolve(blob) : reject(new Error('The image could not be cropped.'))),
      'image/png'
    )
  );
}

function SwatchRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string | null;
  onChange: (token: string) => void;
}) {
  return (
    <fieldset>
      <legend className="mb-1.5 text-xs font-medium tracking-wide text-tp-steel uppercase">
        {label}
      </legend>
      <div className="flex flex-wrap gap-1.5">
        {SWATCHES.map((swatch, index) => (
          <button
            key={swatch.token}
            type="button"
            onClick={() => onChange(swatch.token)}
            aria-pressed={value === swatch.token}
            aria-label={`${label} ${index + 1}`}
            className={`h-7 w-7 cursor-pointer rounded-full border border-tp-hairline-strong ${swatch.className} ${
              value === swatch.token ? 'ring-2 ring-tp-primary ring-offset-2' : ''
            }`}
          />
        ))}
      </div>
    </fieldset>
  );
}

export default function OrgAvatarModal({ org, onClose, onSaved }: Props) {
  const { getDefaultAvatars, setOrgAvatar, uploadOrgAvatar, removeOrgAvatar } =
    useOrganizationsApi();
  const initialMode: AvatarMode =
    org.avatar?.kind === 'upload'
      ? 'upload'
      : org.avatar?.kind === 'predefined'
        ? 'predefined'
        : 'initials';
  const [mode, setMode] = useState<AvatarMode>(initialMode);
  const [files, setFiles] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(predefinedFile(org));
  // The swatch whose value is the stored colour, when one is.
  const [bgToken, setBgToken] = useState<string | null>(
    () =>
      SWATCHES.find(
        s => org.avatar?.bg_color && tokenValue(s.token) === org.avatar.bg_color.toLowerCase()
      )?.token ?? null
  );
  const [fgToken, setFgToken] = useState<string | null>(
    () =>
      SWATCHES.find(
        s => org.avatar?.fg_color && tokenValue(s.token) === org.avatar.fg_color.toLowerCase()
      )?.token ?? null
  );
  const [cropImage, setCropImage] = useState<string | null>(null);
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [pixelCrop, setPixelCrop] = useState<Area | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getDefaultAvatars()
      .then(setFiles)
      .catch(() => setFiles([]));
  }, [getDefaultAvatars]);

  useEffect(
    () => () => {
      if (cropImage) URL.revokeObjectURL(cropImage);
    },
    [cropImage]
  );

  const bgColor = bgToken ? tokenValue(bgToken) || null : (org.avatar?.bg_color ?? null);
  const fgColor = fgToken ? tokenValue(fgToken) || null : (org.avatar?.fg_color ?? null);

  const finish = useCallback(
    (updated: Organization) => {
      onSaved(updated);
      onClose();
    },
    [onSaved, onClose]
  );

  const run = async (action: () => Promise<Organization>) => {
    setBusy(true);
    setError(null);
    try {
      finish(await action());
    } catch (caught) {
      setError(readApiError(caught).message || 'The image could not be saved.');
      setBusy(false);
    }
  };

  const save = () => {
    if (mode === 'upload') {
      if (!cropImage || !pixelCrop) return;
      void run(async () => uploadOrgAvatar(org.slug, await cropToSquare(cropImage, pixelCrop)));
      return;
    }
    void run(() =>
      setOrgAvatar(org.slug, {
        avatar: mode === 'predefined' ? selectedFile : null,
        bg_color: bgColor,
        fg_color: fgColor,
      })
    );
  };

  const pick = (file: File | undefined) => {
    setError(null);
    if (!file) return;
    if (!ACCEPTED.includes(file.type)) {
      setError('Choose a PNG, JPEG or WebP image.');
      return;
    }
    if (file.size > MAX_BYTES) {
      setError('The image is larger than 2 MB.');
      return;
    }
    setCropImage(URL.createObjectURL(file));
  };

  const canSave =
    !busy &&
    (mode === 'upload'
      ? Boolean(cropImage && pixelCrop)
      : mode === 'initials' || Boolean(selectedFile));

  return (
    <Modal title="Organization image" onClose={onClose} size="lg">
      <div className="flex flex-col gap-4">
        <div className="flex justify-center">
          <OrgAvatar
            name={org.name}
            avatar={
              mode === 'predefined' && selectedFile
                ? `/v1/avatars/${selectedFile}`
                : mode === 'upload'
                  ? (org.avatar?.url ?? null)
                  : null
            }
            avatarBgColor={bgColor ?? undefined}
            avatarFgColor={fgColor ?? undefined}
            size={80}
            square
          />
        </div>

        <div
          role="tablist"
          aria-label="Kind of image"
          className="flex gap-1 rounded-lg border border-tp-hairline bg-tp-surface p-1"
        >
          {(
            [
              ['initials', 'Initials'],
              ['predefined', 'Avatar'],
              ['upload', 'Upload'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={mode === value}
              onClick={() => setMode(value)}
              className={`flex-1 cursor-pointer rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                mode === value
                  ? 'bg-tp-canvas text-tp-ink shadow-elevation-1'
                  : 'text-tp-steel hover:text-tp-ink'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {error && <BlockAlert variant="error" message={error} />}

        {mode === 'predefined' && (
          <fieldset>
            <legend className="mb-1.5 text-xs font-medium tracking-wide text-tp-steel uppercase">
              Avatar
            </legend>
            {files.length === 0 ? (
              <p className="text-sm text-tp-steel">No avatars are available.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {files.map(file => (
                  <button
                    key={file}
                    type="button"
                    onClick={() => setSelectedFile(file)}
                    aria-pressed={selectedFile === file}
                    aria-label={file.replace(/\.svg$/, '')}
                    className={`cursor-pointer rounded-md ${selectedFile === file ? 'ring-2 ring-tp-primary ring-offset-2' : ''}`}
                  >
                    <OrgAvatar
                      name={org.name}
                      avatar={`/v1/avatars/${file}`}
                      avatarBgColor={bgColor ?? undefined}
                      avatarFgColor={fgColor ?? undefined}
                      size={44}
                      square
                    />
                  </button>
                ))}
              </div>
            )}
          </fieldset>
        )}

        {mode !== 'upload' && (
          <>
            <SwatchRow label="Background" value={bgToken} onChange={setBgToken} />
            <SwatchRow label="Foreground" value={fgToken} onChange={setFgToken} />
          </>
        )}

        {mode === 'upload' && (
          <div className="flex flex-col gap-3">
            <label className="flex cursor-pointer flex-col items-center gap-1 rounded-lg border border-dashed border-tp-hairline-strong px-4 py-6 text-center text-sm text-tp-slate hover:bg-tp-surface">
              <span className="font-medium text-tp-ink">Choose an image</span>
              <span className="text-xs text-tp-steel">PNG, JPEG or WebP, up to 2 MB</span>
              <input
                type="file"
                accept={ACCEPTED.join(',')}
                className="sr-only"
                onChange={event => pick(event.target.files?.[0])}
              />
            </label>
            {cropImage && (
              <div className="relative h-64 overflow-hidden rounded-lg bg-tp-ink">
                <Cropper
                  image={cropImage}
                  crop={crop}
                  zoom={zoom}
                  aspect={1}
                  onCropChange={setCrop}
                  onZoomChange={setZoom}
                  onCropComplete={(_, area) => setPixelCrop(area)}
                />
              </div>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          {org.avatar?.kind ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => removeOrgAvatar(org.slug))}
              className="cursor-pointer text-sm font-medium text-red-700 hover:underline disabled:opacity-50"
            >
              Remove image
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="cursor-pointer rounded-lg border border-tp-hairline-strong px-4 py-2 text-sm font-medium text-tp-slate hover:bg-tp-surface"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!canSave}
              onClick={save}
              className="cursor-pointer rounded-lg bg-tp-accent px-4 py-2 text-sm font-medium text-tp-on-primary transition-colors hover:bg-tp-primary-deep disabled:opacity-50"
            >
              {busy ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
