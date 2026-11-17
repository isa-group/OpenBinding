import type { ChangelogData, StreamRelease } from './types';

/** The tabs of the page and the streams of `changelog.json` each one shows. */
export const CHANGELOG_TABS = [
  { id: 'openbinding', label: 'OpenBinding', streams: ['platform', 'documentation'] },
  { id: 'language', label: 'Language', streams: ['bim'] },
] as const;

export type ChangelogTab = (typeof CHANGELOG_TABS)[number]['id'];

/** `?tab=` as the address carries it; anything else is the first tab. */
export function parseChangelogTab(value: string | null): ChangelogTab {
  return CHANGELOG_TABS.find(tab => tab.id === value)?.id ?? 'openbinding';
}

const STREAM_LABELS: Readonly<Record<string, string>> = {
  platform: 'Platform',
  bim: 'BIM-Engines',
  documentation: 'Documentation',
};

export function streamLabel(stream: string): string {
  return STREAM_LABELS[stream] ?? stream.charAt(0).toUpperCase() + stream.slice(1);
}

const isDated = (date: string) => /^\d{4}-\d{2}-\d{2}/.test(date);

/** Every release of the given streams: unreleased first, then newest first. */
export function changelogEntries(
  changelog: ChangelogData,
  streams: readonly string[]
): StreamRelease[] {
  const entries = Object.entries(changelog)
    .filter(([name]) => streams.includes(name))
    .flatMap(([name, releases]) => releases.map(release => ({ ...release, stream: name })));
  return entries.sort((a, b) => {
    if (isDated(a.date) !== isDated(b.date)) return isDated(a.date) ? 1 : -1;
    return b.date.localeCompare(a.date);
  });
}

/** `Nov 4, 2026` for a date, the word itself (`Unreleased`) otherwise. */
export function releaseDateLabel(date: string): string {
  if (!isDated(date)) return date;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date.slice(0, 10)}T00:00:00Z`));
}
