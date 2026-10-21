import changelogJson from '../../content/changelog.generated.json';
import {
  contributionTracks, fundingEntities, relatedProjects, researchCorpus, researchFacts, team,
  type ContributionTrack, type FundingEntity, type RelatedProject, type ResearchPaper, type TeamMember,
} from '../../content/platform';

export interface Release {
  version: string;
  date: string;
  title: string;
  changes: readonly string[];
}

export type AboutTab = 'team' | 'research' | 'funding' | 'contrib' | 'changelog';

export const ABOUT_TABS: ReadonlyArray<{ id: AboutTab; label: string }> = [
  { id: 'team', label: 'Team' },
  { id: 'research', label: 'Research' },
  { id: 'funding', label: 'Funding' },
  { id: 'contrib', label: 'Contributions' },
  { id: 'changelog', label: 'Changelog' },
];

/** The reviewed data behind the five tabs. Tests hand the page their own to reach the empty states. */
export interface AboutData {
  team: readonly TeamMember[];
  research: readonly ResearchPaper[];
  researchFacts: ReadonlyArray<{ value: string; label: string }>;
  funding: readonly FundingEntity[];
  relatedProjects: readonly RelatedProject[];
  contributions: readonly ContributionTrack[];
  /** Release streams by name, as written to changelog.generated.json. */
  changelog: Readonly<Record<string, readonly Release[]>>;
}

export const aboutData: AboutData = {
  team,
  research: researchCorpus,
  researchFacts,
  funding: fundingEntities,
  relatedProjects,
  contributions: contributionTracks,
  changelog: changelogJson,
};

/** `?tab=` as the footer and header write it; `contributions` is accepted as the long form of `contrib`. */
export function parseAboutTab(value: string | null): AboutTab {
  if (value === 'contributions') return 'contrib';
  return ABOUT_TABS.find((tab) => tab.id === value)?.id ?? 'team';
}

const STREAM_LABELS: Readonly<Record<string, string>> = {
  platform: 'Platform',
  bim: 'BIM-Engines',
  documentation: 'Documentation',
};

export function streamLabel(stream: string): string {
  return STREAM_LABELS[stream] ?? stream.charAt(0).toUpperCase() + stream.slice(1);
}

export interface ChangelogEntry extends Release {
  stream: string;
}

const isDated = (date: string) => /^\d{4}-\d{2}-\d{2}/.test(date);

/** Every release of the chosen stream (or of all of them): unreleased first, then newest first. */
export function changelogEntries(changelog: AboutData['changelog'], stream: string): ChangelogEntry[] {
  const entries = Object.entries(changelog)
    .filter(([name]) => stream === 'all' || name === stream)
    .flatMap(([name, releases]) => releases.map((release) => ({ ...release, stream: name })));
  return entries.sort((a, b) => {
    if (isDated(a.date) !== isDated(b.date)) return isDated(a.date) ? 1 : -1;
    return b.date.localeCompare(a.date);
  });
}

const LINK_LABELS: Readonly<Record<string, string>> = {
  orcid: 'ORCID', github: 'GitHub', scholar: 'Google Scholar', profile: 'Research profile',
};

export function linkLabel(name: string): string {
  return LINK_LABELS[name] ?? name.charAt(0).toUpperCase() + name.slice(1);
}
