// Adapted from SPHERE frontend/src/modules/presentation/pages/home/components/island-button.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: a link (middle-click works) instead of a button; the theme's ink instead of SPHERE's hex navy.

import { Link } from 'react-router-dom';

export default function IslandButton({
  label,
  to,
  outlined = false,
}: {
  label: string;
  to: string;
  outlined?: boolean;
}) {
  return (
    <Link
      to={to}
      className={`group inline-flex cursor-pointer items-center gap-3 rounded-full border px-6 py-3 text-sm font-medium transition-all duration-700 ease-[cubic-bezier(0.32,0.72,0,1)] active:scale-[0.98] ${
        outlined
          ? 'border-tp-ink bg-transparent text-tp-ink hover:bg-tp-ink/5'
          : 'border-black/10 bg-tp-ink text-white hover:bg-tp-ink/90'
      }`}
    >
      <span>{label}</span>
      <span
        aria-hidden="true"
        className={`flex h-8 w-8 items-center justify-center rounded-full text-[13px] transition-all duration-700 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:translate-x-1 group-hover:-translate-y-[1px] group-hover:scale-105 ${
          outlined ? 'bg-tp-ink/10 text-tp-ink' : 'bg-white/15 text-white'
        }`}
      >
        ↗
      </span>
    </Link>
  );
}
