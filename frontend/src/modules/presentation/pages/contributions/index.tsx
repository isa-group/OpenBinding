// Adapted from SPHERE frontend/src/modules/presentation/pages/contributions/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's contribution tracks (`content/platform.ts`) under a heading and lede, in a grid inside the page width
// (SPHERE's `w-dvw` scrolled sideways), keyed by title instead of a fresh uuid per render; the dialog is the accessible
// Modal; an empty state while no track has been reviewed; a link to discuss an idea.

import { useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { MdNorthEast } from 'react-icons/md';
import { contributionTracks, type ContributionTrack } from '../../../../content/platform';
import PendingReview from '../../components/pending-review';
import ContributionCard from '../../layouts/components/contribution-card';
import ContributionDetailsModal from '../../layouts/components/contribution-details';

export default function ContributionsPage({
  tracks = contributionTracks,
}: {
  tracks?: readonly ContributionTrack[];
}) {
  const [selectedContribution, setSelectedContribution] = useState<ContributionTrack | null>(null);

  return (
    <>
      <Helmet>
        <title>OpenBinding - Contributions</title>
      </Helmet>
      <div className="mx-auto w-full max-w-7xl px-4 pt-8 pb-4 sm:px-6 lg:px-8">
        <h1 className="font-display text-4xl text-tp-ink">Contributions</h1>
        <p className="mt-2 max-w-3xl text-tp-slate">
          Candidate thesis and research tracks extend OpenBinding’s language, engines and evidence
          model without introducing speculative platform dependencies.
        </p>
        {tracks.length === 0 ? (
          <div className="mt-10">
            <PendingReview what="contributions" />
          </div>
        ) : (
          <ul className="mt-10 grid grid-cols-1 justify-items-center gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {tracks.map(contribution => (
              <li key={contribution.title} className="flex w-full justify-center">
                <ContributionCard
                  onClick={() => setSelectedContribution(contribution)}
                  contribution={contribution}
                />
              </li>
            ))}
          </ul>
        )}
        <a
          href="https://github.com/isa-group/OpenBinding/issues"
          target="_blank"
          rel="noreferrer"
          className="mt-10 inline-flex cursor-pointer items-center gap-1 text-sm font-medium text-tp-accent hover:underline"
        >
          Discuss an idea <MdNorthEast aria-hidden="true" />
        </a>
      </div>

      <ContributionDetailsModal
        selectedContribution={selectedContribution}
        handleClose={() => setSelectedContribution(null)}
      />
    </>
  );
}
