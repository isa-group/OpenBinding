import { passwordStrength } from '../../utils/passwordStrength';

/** OpenBinding's password strength meter: three bars and a word. It informs, and never blocks a submission. */
export default function PasswordStrengthMeter({ value }: { value: string }) {
  const strength = passwordStrength(value);
  return (
    <div className="mt-2 flex items-center gap-3">
      <span className="flex flex-1 gap-1" aria-hidden="true">
        {[1, 2, 3].map(level => (
          <i
            key={level}
            className={`h-1 flex-1 rounded-full transition-colors duration-200 ${
              strength.level >= level ? 'bg-tp-primary' : 'bg-tp-hairline-soft'
            }`}
          />
        ))}
      </span>
      <span className="shrink-0 text-xs text-tp-steel">Strength: {strength.label}</span>
    </div>
  );
}
