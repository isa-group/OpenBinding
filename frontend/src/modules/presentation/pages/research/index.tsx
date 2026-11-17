// Adapted from SPHERE frontend/src/modules/presentation/pages/research/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the timeline holds the papers of OpenBinding's executable corpus (`content/platform.ts`), under a heading, a lede
// and the corpus in numbers; a Funding section follows, with the funding entities and what each related project
// contributes (OpenBinding's old About tabs); the page scrolls with the window instead of in its own box.

import { Helmet } from 'react-helmet-async';
import { IoNewspaperOutline } from 'react-icons/io5';
import { GrWorkshop } from 'react-icons/gr';
import { MdAccountBalance, MdNorthEast } from 'react-icons/md';
import {
  fundingEntities,
  relatedProjects,
  researchCorpus,
  researchFacts,
  type FundingEntity,
  type RelatedProject,
  type ResearchPaper,
} from '../../../../content/platform';
import PendingReview from '../../components/pending-review';
import Timeline, { type TimelineItem } from './components/timeline';

/** The reviewed data behind the page. Tests hand the page their own to reach the empty states. */
export interface ResearchData {
  research: readonly ResearchPaper[];
  facts: ReadonlyArray<{ value: string; label: string }>;
  funding: readonly FundingEntity[];
  related: readonly RelatedProject[];
}

const REVIEWED: ResearchData = {
  research: researchCorpus,
  facts: researchFacts,
  funding: fundingEntities,
  related: relatedProjects,
};

const toTimelineItem = (paper: ResearchPaper): TimelineItem => ({
  variant: paper.kind,
  title: paper.title,
  subtitle: paper.authors,
  text: [paper.venue, `Corpus · ${paper.corpus}`, `DOI ${paper.doi}`],
  date: String(paper.year),
  icon:
    paper.kind === 'journal' ? (
      <IoNewspaperOutline aria-hidden="true" />
    ) : (
      <GrWorkshop aria-hidden="true" className="[&_path]:stroke-current" />
    ),
  href: `https://doi.org/${paper.doi}`,
});

function Funding({ funding, related }: Pick<ResearchData, 'funding' | 'related'>) {
  return (
    <section id="funding" aria-labelledby="funding-title" className="mt-20 scroll-mt-24">
      <h2 id="funding-title" className="font-display text-3xl text-tp-ink">
        Funding
      </h2>
      {funding.length === 0 && related.length === 0 ? (
        <div className="mt-6">
          <PendingReview what="funding" />
        </div>
      ) : (
        <>
          <p className="mt-2 max-w-3xl text-sm text-tp-slate">
            These entities are retained from the related SPHERE research ecosystem. Listing records
            provenance and context; it does not imply that every entity funds every OpenBinding
            release.
          </p>
          <ul className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {funding.map(entity => (
              <li key={entity.name}>
                <a
                  href={entity.url}
                  target="_blank"
                  rel="noreferrer"
                  className="group flex h-full cursor-pointer flex-col gap-2 rounded-xl border border-tp-hairline bg-tp-canvas p-4 transition-colors hover:border-tp-primary/40"
                >
                  <span className="flex h-12 items-center">
                    {entity.logo ? (
                      <img src={entity.logo} alt={entity.name} className="h-11 w-auto max-w-full" />
                    ) : (
                      <MdAccountBalance className="h-7 w-7 text-tp-steel" aria-hidden="true" />
                    )}
                  </span>
                  <strong className="text-sm text-tp-ink">{entity.name}</strong>
                  <span className="text-xs text-tp-slate">{entity.scope}</span>
                  <MdNorthEast
                    className="mt-auto h-4 w-4 text-tp-steel group-hover:text-tp-accent"
                    aria-hidden="true"
                  />
                </a>
              </li>
            ))}
          </ul>
          {related.length > 0 && (
            <section aria-labelledby="projects-title" className="mt-10">
              <p className="text-[11px] tracking-[0.2em] text-tp-steel uppercase">
                Projects and infrastructure
              </p>
              <h3 id="projects-title" className="mt-1 text-xl font-semibold text-tp-ink">
                What each project contributes
              </h3>
              <ul className="mt-4 divide-y divide-tp-hairline-soft rounded-xl border border-tp-hairline bg-tp-canvas">
                {related.map(project => (
                  <li key={project.name}>
                    <a
                      href={project.url}
                      target="_blank"
                      rel="noreferrer"
                      className="group grid cursor-pointer grid-cols-1 gap-1 px-4 py-3 transition-colors hover:bg-tp-surface sm:grid-cols-[12rem_1fr_auto_auto] sm:items-center sm:gap-4"
                    >
                      <strong className="text-sm text-tp-ink">
                        {project.name}{' '}
                        <small className="font-normal text-tp-steel">{project.kind}</small>
                      </strong>
                      <span className="text-sm text-tp-slate">{project.role}</span>
                      <time className="text-xs text-tp-steel">{project.period}</time>
                      <MdNorthEast
                        className="hidden h-4 w-4 text-tp-steel group-hover:text-tp-accent sm:block"
                        aria-hidden="true"
                      />
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </section>
  );
}

export default function ResearchPage({ data = REVIEWED }: { data?: ResearchData }) {
  return (
    <>
      <Helmet>
        <title>OpenBinding - Research</title>
      </Helmet>
      {/* The timeline's cards slide in from the side: clipped, so they never widen the page before they arrive. */}
      <div className="w-full overflow-x-clip bg-tp-surface px-4 pt-8 pb-16 md:px-8">
        <div className="mx-auto max-w-5xl">
          <h1 className="font-display text-4xl text-tp-ink">Research</h1>
          <p className="mt-2 max-w-3xl text-tp-slate">
            OpenBinding’s ICWS corpus derives workflows from published service-composition examples.
            Where a paper does not provide QoS numbers, the platform labels its illustrative values
            explicitly.
          </p>
          {data.research.length === 0 ? (
            <div className="mt-10">
              <PendingReview what="research" />
            </div>
          ) : (
            <>
              <ul
                className="mt-8 grid grid-cols-2 gap-3 md:grid-cols-4"
                aria-label="The executable corpus in numbers"
              >
                {data.facts.map(fact => (
                  <li
                    key={fact.label}
                    className="flex flex-col rounded-xl border border-tp-hairline bg-tp-canvas p-4"
                  >
                    <strong className="font-display text-3xl text-tp-ink">{fact.value}</strong>
                    <span className="text-xs text-tp-slate">{fact.label}</span>
                  </li>
                ))}
              </ul>
              <section aria-labelledby="sources-title" className="mt-12">
                <h2 id="sources-title" className="font-display text-3xl text-tp-ink">
                  Sources represented in the executable corpus.
                </h2>
                <p className="mt-2 mb-10 max-w-3xl text-sm text-tp-slate">
                  Authors retain authorship of the original work; OpenBinding records only the
                  provenance of the test problems derived from it and labels every illustrative
                  value.
                </p>
                <Timeline items={data.research.map(toTimelineItem)} label="Source papers" />
              </section>
            </>
          )}
          <Funding funding={data.funding} related={data.related} />
        </div>
      </div>
    </>
  );
}
