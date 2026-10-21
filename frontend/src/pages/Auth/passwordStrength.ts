export const MIN_PASSWORD_LENGTH = 10;

export interface PasswordStrength {
  level: 0 | 1 | 2 | 3;
  label: string;
}

/** Length first; variety only separates "good" from "strong". It never blocks a submission. */
export function passwordStrength(value: string): PasswordStrength {
  const variety = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((rule) => rule.test(value)).length;
  if (!value) return { level: 0, label: 'Not set' };
  if (value.length < MIN_PASSWORD_LENGTH) return { level: 1, label: 'Too short' };
  return value.length >= 14 && variety >= 3 ? { level: 3, label: 'Strong' } : { level: 2, label: 'Good' };
}
