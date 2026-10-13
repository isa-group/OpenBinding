/**
 * Up to two capital letters for a person's avatar. The name is split into tokens on whitespace, '-', '_' and '.',
 * and an email contributes only its local part: 'lab-owner' → 'LO', 'Ada Lovelace' → 'AL', 'ada' → 'AD'.
 */
export function personInitials(name: string | null | undefined): string {
  const text = (name ?? '').trim();
  const local = text.includes('@') ? text.slice(0, text.indexOf('@')) : text;
  const tokens = local.split(/[\s\-_.]+/u).filter(Boolean);
  if (tokens.length >= 2) return `${Array.from(tokens[0])[0]}${Array.from(tokens[1])[0]}`.toUpperCase();
  return Array.from(tokens[0] ?? '').slice(0, 2).join('').toUpperCase();
}
