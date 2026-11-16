// Pattern only, after SPHERE frontend/src/modules/organization/pages/public-organizations-list/index.tsx (revision 73779a8a), https://github.com/SCORELabUS/SPHERE.
// Copyright (c) 2024 Alejandro García Fernández. MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Drawn with SPHERE's page opening (an uppercase eyebrow, a display headline, a slate lede, actions to the right).

import type { ReactNode } from 'react';

interface PageHeaderProps {
  eyebrow: string;
  title: string;
  lede?: ReactNode;
  /** Buttons aligned with the title, on wide screens to its right. */
  actions?: ReactNode;
}

/** Eyebrow, display headline and lede that open every public screen. */
export function PageHeader({ eyebrow, title, lede, actions }: PageHeaderProps) {
  return (
    <header className="ui-page-header mb-8 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
      <div className="ui-page-header-copy flex max-w-3xl flex-col gap-2">
        <span className="ui-page-header-eyebrow text-[11px] font-semibold tracking-[0.2em] text-tp-accent uppercase">
          {eyebrow}
        </span>
        <h1 className="font-display text-4xl leading-tight text-tp-ink md:text-5xl">{title}</h1>
        {lede && <p className="text-base text-tp-slate">{lede}</p>}
      </div>
      {actions && (
        <div className="ui-page-header-actions flex flex-wrap items-center gap-2">{actions}</div>
      )}
    </header>
  );
}
