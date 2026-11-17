// Adapted from SPHERE frontend/src/modules/pricing/components/visibility-options/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the gateway's values (`public`, `private`) with SPHERE's labels; a legend; can be disabled; theme tokens instead
// of Tailwind's slate.

export type Visibility = 'public' | 'private';

interface VisibilityOptionsProps {
  value: Visibility;
  onChange: (value: Visibility) => void;
  disabled?: boolean;
  name?: string;
}

export default function VisibilityOptions({
  value,
  onChange,
  disabled = false,
  name = 'visibility',
}: VisibilityOptionsProps) {
  return (
    <fieldset className="flex flex-col gap-2" disabled={disabled}>
      <legend className="sr-only">Visibility</legend>
      {(['public', 'private'] as const).map(option => (
        <label
          key={option}
          className="flex cursor-pointer items-center gap-2 text-sm text-tp-slate has-disabled:cursor-default has-disabled:opacity-60"
        >
          <input
            type="radio"
            name={name}
            value={option}
            checked={value === option}
            onChange={() => onChange(option)}
            className="h-4 w-4 cursor-pointer accent-tp-primary"
          />
          {option === 'public' ? 'Public' : 'Private'}
        </label>
      ))}
    </fieldset>
  );
}
