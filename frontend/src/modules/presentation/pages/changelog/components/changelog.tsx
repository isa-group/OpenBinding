// Adapted from SPHERE frontend/src/modules/presentation/pages/changelog/components/changelog.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: a list of release cards instead of a fixed table, so a phone reads it without scrolling sideways; each release
// has one disclosure of its changes (OpenBinding's changelog does not split features from fixes), the newest open; a release
// with no change recorded says so.

import type { StreamRelease } from '../types';
import ReleaseChanges from './release-changes';
import ReleaseContent from './release-content';
import ReleaseVersion from './release-version';

interface ChangelogProps {
  releases: readonly StreamRelease[];
}

export default function Changelog({ releases }: ChangelogProps) {
  return (
    <ol className="flex flex-col gap-8">
      {releases.map((release, index) => (
        <li
          key={`${release.stream}-${release.version}`}
          className="grid grid-cols-1 gap-3 md:grid-cols-[12rem_1fr] md:gap-6"
        >
          <ReleaseVersion
            version={release.version}
            releaseDate={release.date}
            stream={release.stream}
          />
          <ReleaseContent description={release.title}>
            {release.changes.length > 0 ? (
              <ReleaseChanges name="Changes" changes={release.changes} defaultOpen={index === 0} />
            ) : (
              <p className="text-tp-steel">No changes recorded yet.</p>
            )}
          </ReleaseContent>
        </li>
      ))}
    </ol>
  );
}
