import type { ReactNode } from 'react';
import './DataTable.css';

interface DataTableProps {
  /** Names the table for assistive technology. */
  label: string;
  children: ReactNode;
  /** The width below which the table scrolls sideways instead of squeezing, in px. */
  minWidth?: number;
}

/** A bordered table inside a horizontal scroller. Give it `<thead>` and `<tbody>`; headers should be `scope="col"`. */
export function DataTable({ label, children, minWidth = 640 }: DataTableProps) {
  return (
    <div className="ui-table-wrap" tabIndex={0} role="region" aria-label={label}>
      <table className="ui-table" style={{ minWidth }}>{children}</table>
    </div>
  );
}
