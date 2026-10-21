import './Switch.css';

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** What the switch controls, for assistive technology: “Email me about contract changes”. */
  label: string;
  disabled?: boolean;
}

/** An on/off switch. It reports its state with `role="switch"`, so a screen reader says “on” and “off”. */
export function Switch({ checked, onChange, label, disabled }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="ui-switch"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span aria-hidden="true" />
    </button>
  );
}
