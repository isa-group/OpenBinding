// Adapted from SPHERE frontend/src/modules/presentation/layouts/components/contribution-details/index.tsx (revision
// 73779a8a), https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: drawn in OpenBinding's accessible Modal (focus kept inside, Escape and the × close it, focus returns to the card)
// instead of a fixed div; the markdown description, then how to start a proposal, the level and tags, the supervisor when the
// track names one, and a link to discuss it on GitHub; links in the markdown open in a new tab in the link token.

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MdNorthEast } from 'react-icons/md';
import type { ContributionTrack } from '../../../../../content/platform';
import { Chip } from '../../../../core/components/chip';
import { Modal } from '../../../../core/components/modal';

/** What every proposal brings before implementation starts. */
const HOW_TO_START = `### Start from a reproducible question

Proposals should identify a BIM invariant, an executable corpus and acceptance evidence before implementation begins.`;

const ISSUES = 'https://github.com/isa-group/OpenBinding/issues';

function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children }) => (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="cursor-pointer text-tp-link underline"
          >
            {children}
          </a>
        ),
        h3: ({ children }) => <h3 className="mt-5 font-bold text-tp-ink">{children}</h3>,
        p: ({ children }) => <p className="mt-2">{children}</p>,
        ul: ({ children }) => <ul className="list-disc pl-6">{children}</ul>,
        li: ({ children }) => <li className="mb-2">{children}</li>,
      }}
    >
      {children}
    </ReactMarkdown>
  );
}

export default function ContributionDetailsModal({
  selectedContribution,
  handleClose,
}: Readonly<{
  selectedContribution: ContributionTrack | null;
  handleClose: () => void;
}>) {
  if (!selectedContribution) return null;
  return (
    <Modal title={selectedContribution.title} onClose={handleClose} size="lg">
      <div className="flex flex-col gap-4">
        <div>
          <Markdown>{selectedContribution.description}</Markdown>
          <Markdown>{HOW_TO_START}</Markdown>
        </div>
        <div className="flex flex-col gap-2 border-t border-tp-hairline-soft pt-3">
          <p className="font-bold text-tp-ink">Tags:</p>
          <div className="flex flex-wrap gap-1">
            <Chip tone="accent">{selectedContribution.level}</Chip>
            {selectedContribution.tags.map(tag => (
              <Chip key={tag} tone="accent">
                {tag}
              </Chip>
            ))}
          </div>
          {selectedContribution.supervisor && (
            <>
              <p className="mt-2 font-bold text-tp-ink">Supervisor/s:</p>
              <p className="text-sm text-tp-steel">{selectedContribution.supervisor}</p>
            </>
          )}
          <a
            href={ISSUES}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-flex cursor-pointer items-center gap-1 self-start text-sm font-medium text-tp-accent hover:underline"
          >
            Discuss this on GitHub <MdNorthEast aria-hidden="true" />
          </a>
        </div>
      </div>
    </Modal>
  );
}
