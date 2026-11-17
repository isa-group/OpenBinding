// Adapted from SPHERE frontend/src/modules/presentation/pages/team/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's reviewed team (`content/platform.ts`), a page heading and lede, the grid inside the page width
// (SPHERE's `w-dvw` scrolled sideways), keyed cards, the note that team changes are reviewed in Git, and an empty state while
// no entry has been reviewed.

import { Helmet } from 'react-helmet-async';
import { FiGithub } from 'react-icons/fi';
import { team as reviewedTeam, type TeamMember } from '../../../../content/platform';
import TeamMemberCard from '../../layouts/components/team-member-card';
import PendingReview from '../../components/pending-review';

export default function TeamPage({ team = reviewedTeam }: { team?: readonly TeamMember[] }) {
  return (
    <>
      <Helmet>
        <title>OpenBinding - Team</title>
      </Helmet>
      <div className="mx-auto w-full max-w-7xl px-4 pt-8 pb-4 sm:px-6 lg:px-8">
        <h1 className="font-display text-4xl text-tp-ink">Team</h1>
        <p className="mt-2 max-w-2xl text-tp-slate">
          The people behind OpenBinding. This page is reviewed as data in the repository, not served
          by the API.
        </p>
        {team.length === 0 ? (
          <div className="mt-10">
            <PendingReview what="team" />
          </div>
        ) : (
          <div className="mt-10 grid grid-cols-1 justify-items-center gap-10 md:grid-cols-2 xl:grid-cols-3">
            {team.map(member => (
              <TeamMemberCard key={member.name} member={member} />
            ))}
          </div>
        )}
        <aside className="mt-12 flex items-start gap-3 rounded-xl border border-tp-hairline bg-tp-surface p-4 text-sm text-tp-slate">
          <FiGithub className="mt-0.5 h-5 w-5 shrink-0 text-tp-ink" aria-hidden="true" />
          <div>
            <strong className="text-tp-ink">Contribution is the source of truth.</strong>
            <p>
              Team changes are reviewed in Git. We omit unverified links rather than filling a card
              with guesses.
            </p>
          </div>
        </aside>
      </div>
    </>
  );
}
