// Copied verbatim from SPHERE frontend/src/modules/beta/components/beta-badge/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.

interface Props {
  className?: string;
}

/** Small "Beta" label to mark a tab, button or section as unfinished. */
export default function BetaBadge({ className = '' }: Props) {
  return (
    <span
      className={`inline-flex items-center rounded-full bg-tp-primary/10 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-tp-primary uppercase ${className}`}
    >
      Beta
    </span>
  );
}
