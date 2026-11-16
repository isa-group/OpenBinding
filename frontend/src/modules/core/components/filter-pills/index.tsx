// Pattern only, after SPHERE frontend/src/modules/core/components/filter-bar/index.tsx (revision 73779a8a), https://github.com/SCORELabUS/SPHERE.
// Copyright (c) 2024 Alejandro García Fernández. MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Drawn with SPHERE's filter pills (rounded-full chips; the pressed one tinted with the primary colour).

export interface FilterPillOption {
  id: string;
  label: string;
}

interface FilterPillsProps {
  options: readonly FilterPillOption[];
  value: string;
  onChange: (id: string) => void;
  ariaLabel: string;
}

/** A row of toggle buttons that narrow a list to one group; exactly one is pressed. */
export function FilterPills({ options, value, onChange, ariaLabel }: FilterPillsProps) {
  return (
    <div className="ui-pills flex flex-wrap gap-1.5" role="group" aria-label={ariaLabel}>
      {options.map(option => {
        const pressed = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={pressed}
            onClick={() => onChange(option.id)}
            className={`cursor-pointer rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
              pressed
                ? 'border-tp-primary/30 bg-tp-primary/10 text-tp-accent'
                : 'border-tp-hairline bg-tp-canvas text-tp-slate hover:border-tp-stone hover:text-tp-ink'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
