import { MdLock } from 'react-icons/md';
import type { SphereManifestView } from '../../../api/sphereApi';

const formatDate = (value?: string | null) => {
  if (!value) return 'no date';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'no date'
    : date.toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' });
};

interface Props {
  manifest: SphereManifestView;
  value: string | null;
  onChange: (versionId: string) => void;
}

/**
 * A family's versions, by name and date, newest first: SPHERE's latest is the newest by date, not by name, and is marked;
 * a private version is flagged. Never an id or a hash.
 */
export default function VersionStep({ manifest, value, onChange }: Props) {
  // The gateway answers them newest first by date, SPHERE's own order (its latest is the newest by date, not by name).
  const versions = manifest.versions;
  const chosen = value ?? manifest.latestVersionId;
  return (
    <fieldset className="flex min-w-0 flex-col gap-2">
      <legend className="mb-1 text-sm font-medium text-tp-ink">Versions of {manifest.name}</legend>
      {versions.map(version => (
        <label
          key={version.versionId}
          className={`flex min-w-0 cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 ${chosen === version.versionId ? 'border-tp-primary bg-tp-primary/5' : 'border-tp-hairline bg-tp-canvas hover:bg-tp-surface'}`}
        >
          <input
            type="radio"
            name="sphere-version"
            checked={chosen === version.versionId}
            onChange={() => onChange(version.versionId)}
          />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold [overflow-wrap:anywhere] text-tp-ink">
              {version.label}
            </span>
            <span className="block text-xs text-tp-steel">{formatDate(version.createdAt)}</span>
          </span>
          {version.versionId === manifest.latestVersionId && (
            <span className="rounded-full bg-tp-primary/10 px-2 py-0.5 text-[10px] font-medium text-tp-accent">
              Latest
            </span>
          )}
          {version.private && (
            <span className="inline-flex items-center gap-1 rounded-full bg-tp-surface px-2 py-0.5 text-[10px] font-medium text-tp-steel">
              <MdLock aria-hidden="true" className="h-3 w-3" />
              Private
            </span>
          )}
        </label>
      ))}
    </fieldset>
  );
}
