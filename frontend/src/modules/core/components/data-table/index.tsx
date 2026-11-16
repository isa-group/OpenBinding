// Pattern only, after SPHERE frontend/src/modules/organization/pages/organization-detail/components/MembersTab.tsx (revision 73779a8a), https://github.com/SCORELabUS/SPHERE.
// Copyright (c) 2024 Alejandro García Fernández. MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Drawn with SPHERE's list card (a rounded-xl hairline card; small uppercase column heads; hairline rows that tint on hover);
// the scroller is positioned so visually hidden text in a cell stays inside it instead of widening the page.

import type { ReactNode } from 'react';

interface DataTableProps {
  /** Names the table for assistive technology. */
  label: string;
  children: ReactNode;
  /** The width below which the table scrolls sideways instead of squeezing, in px. */
  minWidth?: number;
  /** The table's own `<caption>`, read before its rows. */
  caption?: ReactNode;
}

/** A bordered table inside a horizontal scroller. Give it `<thead>` and `<tbody>`; headers should be `scope="col"`. */
export function DataTable({ label, children, minWidth = 640, caption }: DataTableProps) {
  return (
    <div
      className="ui-table-wrap relative w-full overflow-x-auto rounded-xl border border-tp-hairline bg-tp-canvas focus-visible:outline-2 focus-visible:outline-tp-primary"
      tabIndex={0}
      role="region"
      aria-label={label}
    >
      <table
        className="ui-table w-full border-collapse text-left text-sm text-tp-ink [&_tbody_tr]:border-t [&_tbody_tr]:border-tp-hairline-soft [&_tbody_tr:hover]:bg-tp-surface [&_td]:px-4 [&_td]:py-3 [&_td]:align-top [&_th]:px-4 [&_th]:py-2.5 [&_th]:text-[11px] [&_th]:font-semibold [&_th]:tracking-wide [&_th]:text-tp-steel [&_th]:uppercase [&_thead]:bg-tp-surface"
        style={{ minWidth }}
      >
        {caption !== undefined && (
          <caption className="ui-table-caption px-4 py-2 text-left text-xs text-tp-steel">
            {caption}
          </caption>
        )}
        {children}
      </table>
    </div>
  );
}
