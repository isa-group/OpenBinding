// Adapted from SPHERE frontend/src/modules/presentation/layouts/components/team-member-card/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: fed by OpenBinding's reviewed team data (`content/platform.ts`): initials instead of a portrait (none is shipped),
// the role, the affiliation pill in the institution token instead of a hex class, and the profiles the data names (ORCID,
// GitHub, Google Scholar, the research profile) with no e-mail; the card is an article named by its heading; SPHERE's
// undefined `sphere-grey` classes and hand-written shadows become tokens.

import { FaGithub, FaOrcid } from 'react-icons/fa';
import { FaGoogleScholar } from 'react-icons/fa6';
import { MdLanguage } from 'react-icons/md';
import type { IconType } from 'react-icons';
import type { TeamMember } from '../../../../../content/platform';

/** The profiles a member may name, in the order the card shows them. */
const PROFILES: ReadonlyArray<{ key: string; label: string; icon: IconType }> = [
  { key: 'profile', label: 'Research profile', icon: MdLanguage },
  { key: 'github', label: 'GitHub', icon: FaGithub },
  { key: 'scholar', label: 'Google Scholar', icon: FaGoogleScholar },
  { key: 'orcid', label: 'ORCID', icon: FaOrcid },
];

export default function TeamMemberCard({ member }: { member: TeamMember }) {
  const iconButtonClass =
    'flex h-9 w-9 cursor-pointer items-center justify-center rounded-full text-tp-slate transition-colors hover:bg-tp-surface hover:text-tp-ink';
  const headingId = `team-${member.initials.toLowerCase()}`;

  return (
    <article
      aria-labelledby={headingId}
      className="mx-auto w-full max-w-[400px] rounded-xl border border-tp-hairline-soft bg-tp-canvas shadow-elevation-3 transition duration-300 hover:shadow-elevation-4"
    >
      <div
        className="mx-auto my-5 flex h-40 w-40 items-center justify-center overflow-hidden rounded-full border-4 border-tp-canvas bg-tp-surface shadow-elevation-2 sm:h-[200px] sm:w-[200px]"
        aria-hidden="true"
      >
        <p className="font-display text-5xl text-tp-ink">{member.initials}</p>
      </div>
      <div className="p-4 text-center">
        <h2 id={headingId} className="text-2xl font-semibold text-tp-ink">
          {member.name}
        </h2>
        <p className="text-sm text-tp-steel">{member.role}</p>
        <span className="mt-1 inline-flex rounded-full bg-tp-institution px-3 py-1 text-xs text-tp-on-primary">
          {member.affiliation}
        </span>
        {Object.keys(member.links).length > 0 && (
          <nav
            aria-label={`${member.name} profiles`}
            className="flex flex-wrap items-center justify-center gap-2 pt-2"
          >
            {PROFILES.filter(profile => member.links[profile.key]).map(profile => (
              <a
                key={profile.key}
                title={profile.label}
                href={member.links[profile.key]}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={profile.label}
                className={iconButtonClass}
              >
                <profile.icon aria-hidden="true" />
              </a>
            ))}
          </nav>
        )}
      </div>
    </article>
  );
}
