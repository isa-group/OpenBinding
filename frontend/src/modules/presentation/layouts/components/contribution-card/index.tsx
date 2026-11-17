// Adapted from SPHERE frontend/src/modules/presentation/layouts/components/contribution-card/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: fed by OpenBinding's contribution tracks (`content/platform.ts`), whose description is markdown rendered with
// react-markdown and remark-gfm; the level and tags are Chips instead of hex-coloured pills; the supervisor line only when
// the track names one; the card is a button that says it opens a dialog (SPHERE's was a clickable div), with the hover ring
// in the primary token instead of a hand-written shadow, and SPHERE's undefined `sphere-grey` classes fixed.

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ContributionTrack } from '../../../../../content/platform';
import { Chip } from '../../../../core/components/chip';

export default function ContributionCard({
  contribution,
  onClick,
}: {
  contribution: ContributionTrack;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-haspopup="dialog"
      className="relative flex h-full w-full max-w-[400px] cursor-pointer flex-col overflow-hidden rounded-xl border border-tp-hairline bg-tp-canvas p-4 text-left shadow-elevation-2 transition-shadow duration-300 hover:shadow-elevation-3 hover:ring-2 hover:ring-tp-primary/40"
    >
      <span className="flex min-h-[65px] items-center justify-center">
        <strong className="mt-1 text-center text-xl font-bold text-tp-ink">
          {contribution.title}
        </strong>
      </span>
      <span className="relative mt-1 block max-h-[200px] overflow-hidden">
        <span className="block min-h-[120px] text-sm text-tp-slate">
          {/* Inside a button, so every block of the markdown is drawn as a span. */}
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{ p: ({ children }) => <span className="mt-1 block">{children}</span> }}
          >
            {contribution.description}
          </ReactMarkdown>
        </span>
        <span
          aria-hidden="true"
          className="absolute right-0 bottom-0 left-0 h-10 bg-linear-to-b from-transparent to-tp-canvas"
        />
      </span>
      <span className="mt-3 flex flex-wrap justify-center gap-1.5">
        <Chip tone="accent">{contribution.level}</Chip>
        {contribution.tags.map(tag => (
          <Chip key={tag} tone="accent">
            {tag}
          </Chip>
        ))}
      </span>
      {contribution.supervisor && (
        <span className="mt-2 block text-xs text-tp-steel">
          <span className="font-bold">Supervisor/s:</span>{' '}
          {contribution.supervisor.length > 40
            ? `${contribution.supervisor.slice(0, 37)}...`
            : contribution.supervisor}
        </span>
      )}
    </button>
  );
}
