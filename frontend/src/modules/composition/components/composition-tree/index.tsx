// Adapted from SPHERE frontend/src/modules/pricing/components/pricing-tree/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: a composition's analytics (its tasks, providers, upstream pricings and workflow structure, as the gateway stored
// them at seal) instead of a pricing's plans, features, limits and add-ons; the sections say whether they are open; the
// rows and sections are components of the module, not redefined on each render.

import { useState, type ReactNode } from 'react';

/** What the gateway stores of a version at seal (`analytics`). */
export interface CompositionAnalytics {
  tasks?: number;
  boundTasks?: number;
  localTasks?: number;
  providers?: number;
  upstreamPricings?: number;
  workflow?: { depth?: number; xor?: number; and?: number; loop?: number };
  hasOffering?: boolean;
}

const count = (value: number | undefined) => value ?? 0;

function Row({ label, value, indent = 1 }: { label: string; value: ReactNode; indent?: number }) {
  return (
    <div className="flex items-center gap-2 py-1 text-xs" style={{ paddingLeft: indent * 16 }}>
      <span className="flex-1 text-tp-slate">{label}</span>
      <span className="text-tp-steel">{value}</span>
    </div>
  );
}

function Section({
  label,
  value,
  open,
  onToggle,
  children,
}: {
  label: string;
  value: ReactNode;
  open: boolean;
  onToggle: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="border-b border-tp-hairline last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-2 py-1.5 text-xs font-medium text-tp-ink hover:text-tp-accent"
      >
        <svg
          className={`h-3 w-3 shrink-0 text-tp-steel transition-transform ${open ? 'rotate-90' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
        </svg>
        <span className="flex-1 text-left">{label}</span>
        <span className="text-[11px] font-normal text-tp-steel">{value}</span>
      </button>
      {open && children && <div className="pb-1">{children}</div>}
    </div>
  );
}

export default function CompositionTree({ analytics: a }: { analytics: CompositionAnalytics }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const toggle = (key: string) => () =>
    setOpen(previous => ({ ...previous, [key]: !previous[key] }));
  const workflow = a.workflow ?? {};

  return (
    <div className="rounded-xl border border-tp-hairline bg-tp-canvas p-4">
      <h3 className="mb-2 text-xs font-medium text-tp-ink">Composition</h3>
      <Section
        label="Tasks"
        value={`${count(a.tasks)} tasks`}
        open={!!open.tasks}
        onToggle={toggle('tasks')}
      >
        <Row label="Bound to a candidate" value={count(a.boundTasks)} />
        <Row label="Done in house" value={count(a.localTasks)} />
      </Section>
      <Section
        label="Providers"
        value={`${count(a.providers)} providers`}
        open={!!open.providers}
        onToggle={toggle('providers')}
      >
        <Row label="SPHERE pricings upstream" value={count(a.upstreamPricings)} />
        <Row label="Own offering" value={a.hasOffering ? 'Yes' : 'No'} />
      </Section>
      <Section
        label="Structure"
        value={`depth ${count(workflow.depth)}`}
        open={!!open.workflow}
        onToggle={toggle('workflow')}
      >
        <Row label="Exclusive choices (xor)" value={count(workflow.xor)} />
        <Row label="Parallel blocks (and)" value={count(workflow.and)} />
        <Row label="Loops" value={count(workflow.loop)} />
      </Section>
    </div>
  );
}
