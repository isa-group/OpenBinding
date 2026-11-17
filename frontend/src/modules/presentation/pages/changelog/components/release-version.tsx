// Adapted from SPHERE frontend/src/modules/presentation/pages/changelog/components/release-version.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: a cell of a release card instead of a table cell; an unreleased version says so instead of an invalid date; the
// stream the release belongs to is named under the date.

import { Chip } from '../../../../core/components/chip';
import { releaseDateLabel, streamLabel } from '../changelog-model';

interface ReleaseVersionProps {
  version: string;
  releaseDate: string;
  stream: string;
}

export default function ReleaseVersion({ version, releaseDate, stream }: ReleaseVersionProps) {
  const dated = /^\d{4}-\d{2}-\d{2}/.test(releaseDate);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 md:flex-col md:items-start md:pt-6">
      <p className="text-lg font-medium text-tp-ink">
        <code className="font-mono">{version}</code>
      </p>
      {dated ? (
        <time className="text-sm text-tp-steel" dateTime={releaseDate}>
          {releaseDateLabel(releaseDate)}
        </time>
      ) : (
        <span className="text-sm text-tp-steel">{releaseDate}</span>
      )}
      <Chip>{streamLabel(stream)}</Chip>
    </div>
  );
}
