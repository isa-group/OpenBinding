// Adapted from SPHERE frontend/src/modules/presentation/pages/changelog/components/release-content.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: a card instead of a table cell; the description is the release's title, set as its heading; the two columns stack
// below `md` instead of squeezing ten grid columns on a phone.

import type { ReactNode } from 'react';

interface ReleaseContentProps {
  description: string;
  children?: ReactNode;
}

export default function ReleaseContent({ description, children }: ReleaseContentProps) {
  return (
    <div className="min-w-0 rounded-xl border border-tp-hairline bg-tp-canvas p-6">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-10">
        <div className="md:col-span-3 md:pr-8">
          <h2 className="text-lg leading-8 font-normal text-tp-ink-tint">{description}</h2>
        </div>
        <div className="max-h-[420px] space-y-8 overflow-y-auto md:col-span-7">{children}</div>
      </div>
    </div>
  );
}
