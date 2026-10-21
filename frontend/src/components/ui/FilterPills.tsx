import './FilterPills.css';

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
    <div className="ui-pills" role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button key={option.id} type="button" aria-pressed={option.id === value} onClick={() => onChange(option.id)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}
