// Adapted from SPHERE frontend/src/modules/presentation/pages/changelog/components/release-changes.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the changes are strings (OpenBinding's changelog has no ids); the disclosure may start open; the count is in the
// steel token, which reaches 4.5:1 (SPHERE's `tp-muted` does not).

import { useState } from 'react';

import Iconify from '../../../../core/components/iconify';

interface ReleaseChangesProps {
  name: string;
  changes: readonly string[];
  defaultOpen?: boolean;
}

export default function ReleaseChanges({
  name,
  changes,
  defaultOpen = false,
}: ReleaseChangesProps) {
  const [isExpanded, setIsExpanded] = useState(defaultOpen);

  return (
    <details
      className="rounded-xl border border-tp-hairline bg-tp-canvas p-4"
      open={isExpanded}
      onToggle={event => setIsExpanded(event.currentTarget.open)}
    >
      <summary className="flex cursor-pointer items-center gap-1 text-lg font-normal text-tp-ink marker:content-none [&::-webkit-details-marker]:hidden">
        <span className="text-tp-ink-tint">{name}</span>{' '}
        <span className="text-tp-steel">({changes.length})</span>
        <Iconify icon={isExpanded ? 'mdi:chevron-down' : 'mdi:chevron-right'} width={14} />
      </summary>

      <ul className="mt-4 list-disc space-y-3 overflow-hidden pl-5 marker:text-tp-primary">
        {changes.map(change => (
          <li key={change} className="text-base leading-7 text-tp-steel">
            {change}
          </li>
        ))}
      </ul>
    </details>
  );
}
