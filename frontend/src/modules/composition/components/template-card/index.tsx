// Adapted from SPHERE frontend/src/modules/pricing/components/collection-card/index.tsx (revision fc776b4d),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: a composition template of the catalog instead of a collection: its title and summary, the kind chip, its tasks,
// whether it reads SPHERE (and has an offering, so margins), and one action that starts a composition from it. A template
// this installation cannot start (SPHERE turned off) stays listed, disabled, with the reason.

import type { CompositionTemplateSummary } from '../../../core/api/types';
import { kindLabel } from '../../../core/utils/composition/kinds';

const REASONS: Record<NonNullable<CompositionTemplateSummary['unavailableReason']>, string> = {
  sphere_disabled: 'It reads SPHERE, which this installation has turned off.',
};

interface Props {
  template: CompositionTemplateSummary;
  onUse: () => void;
}

export default function TemplateCard({ template, onUse }: Props) {
  const reason = template.unavailableReason ? REASONS[template.unavailableReason] : null;
  return (
    <article
      aria-label={`Template ${template.title}`}
      className={`flex flex-col gap-3 rounded-xl border border-tp-hairline bg-tp-canvas p-4 transition-colors ${template.available ? 'hover:border-tp-hairline-strong hover:shadow-elevation-2' : 'opacity-70'}`}
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm font-medium text-tp-ink">{template.title}</h3>
        <span className="shrink-0 rounded-full bg-tp-surface px-2 py-0.5 text-[10px] font-semibold text-tp-steel">
          {kindLabel(template.kind)}
        </span>
      </div>
      <p className="text-xs text-tp-slate">{template.summary}</p>
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-tp-steel">
        {template.tasks.map(task => (
          <span key={task} className="rounded bg-tp-surface px-1.5 py-0.5 font-mono">
            {task}
          </span>
        ))}
        {template.hasOffering && (
          <span className="rounded bg-tp-primary/10 px-1.5 py-0.5 font-medium text-tp-accent">
            Uses SPHERE · has an offering
          </span>
        )}
      </div>
      <div className="mt-auto flex flex-wrap items-center justify-between gap-2">
        {reason ? <span className="text-[11px] text-tp-steel">{reason}</span> : <span />}
        <button
          type="button"
          onClick={onUse}
          disabled={!template.available}
          className="flex h-8 cursor-pointer items-center rounded-lg border border-tp-input-border bg-tp-input-bg px-3 text-xs font-medium text-tp-ink transition-colors hover:bg-tp-surface disabled:cursor-not-allowed disabled:opacity-50"
        >
          Use this template
        </button>
      </div>
    </article>
  );
}
