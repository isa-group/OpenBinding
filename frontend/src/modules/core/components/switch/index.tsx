// Pattern only, after SPHERE frontend/src/modules/settings/components/beta-features-section.tsx (revision 73779a8a), https://github.com/SCORELabUS/SPHERE.
// Copyright (c) 2024 Alejandro García Fernández. MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Drawn with SPHERE's settings toggle (a rounded track in the primary colour with a white knob).

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
      className={`ui-switch relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
        checked ? 'bg-tp-primary' : 'bg-tp-hairline'
      }`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span
        aria-hidden="true"
        className={`inline-block h-5 w-5 rounded-full bg-white shadow-elevation-1 transition-transform ${checked ? 'translate-x-5.5' : 'translate-x-0.5'}`}
      />
    </button>
  );
}
