// Pattern only, after SPHERE frontend/src/modules/organization/pages/organizations-list/index.tsx (revision 73779a8a), https://github.com/SCORELabUS/SPHERE.
// Copyright (c) 2024 Alejandro García Fernández. MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Drawn with SPHERE's empty box (rounded-xl, dashed hairline, centred icon, title and hint).

import type { ReactNode } from 'react';

interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  /** A link or button under the explanation. */
  action?: ReactNode;
  /** A dashed border for "nothing here yet", a solid one for "nothing matches". */
  dashed?: boolean;
}

/** The centred box that says why a list or panel is empty and what to do about it. */
export function EmptyState({ icon, title, children, action, dashed = false }: EmptyStateProps) {
  return (
    <div
      className={`ui-empty${dashed ? ' is-dashed border-dashed' : ''} flex flex-col items-center gap-2 rounded-xl border border-tp-hairline bg-tp-canvas px-6 py-10 text-center`}
    >
      <span
        className="ui-empty-icon flex h-10 w-10 items-center justify-center rounded-full bg-tp-surface text-tp-steel [&_svg]:h-5 [&_svg]:w-5"
        aria-hidden="true"
      >
        {icon}
      </span>
      <strong className="text-sm font-semibold text-tp-ink">{title}</strong>
      {children && (
        <span className="ui-empty-text max-w-[28rem] text-sm text-tp-slate">{children}</span>
      )}
      {action}
    </div>
  );
}
