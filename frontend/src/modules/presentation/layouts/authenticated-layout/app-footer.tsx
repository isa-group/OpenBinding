// Adapted from SPHERE frontend/src/modules/presentation/layouts/authenticated-layout/app-footer.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's statement and columns (from its old site footer), as links instead of buttons; the institutional
// links open in a new tab; small text at full opacity of the cream foreground, so it reaches 4.5:1; a labelled navigation.

import { Link } from 'react-router-dom';
import { InstitutionMark } from '../../../../components/InstitutionMark';

const FOOTER_COLUMNS = [
  {
    title: 'Platform',
    links: [
      { label: 'Compositions', to: '/compositions' },
      { label: 'Language', to: '/language' },
      { label: 'Engines', to: '/engines' },
      { label: 'Pricing', to: '/pricing' },
      { label: 'Problem editor', to: '/problem-editor' },
    ],
  },
  {
    title: 'About',
    links: [
      { label: 'Team', to: '/about?tab=team' },
      { label: 'Research', to: '/about?tab=research' },
      { label: 'Funding', to: '/about?tab=funding' },
      { label: 'Changelog', to: '/about?tab=changelog' },
    ],
  },
];

const INSTITUTIONAL_LINKS = [
  { label: 'SCORE Lab', to: 'https://score.us.es' },
  { label: 'ISA Group', to: 'https://www.isa.us.es/3.0/' },
  { label: 'Universidad de Sevilla', to: 'https://www.us.es' },
  { label: 'GitHub Source', to: 'https://github.com/isa-group/OpenBinding' },
];

export default function AppFooter() {
  return (
    <footer className="site-footer bg-tp-footer-cream">
      <div className="mx-auto w-full max-w-[1280px] px-6 py-10 md:px-10 md:py-12">
        <div className="grid grid-cols-1 gap-8 md:grid-cols-12">
          {/* Brand column */}
          <div className="md:col-span-5">
            <p className="text-[11px] tracking-[0.22em] text-tp-on-cream uppercase">OpenBinding</p>
            <p className="mt-3 font-display text-3xl leading-[0.95] text-tp-on-cream md:text-4xl">
              Compositions you can define, evaluate and compare
            </p>
            <p className="mt-4 max-w-[28rem] text-sm leading-relaxed text-tp-on-cream">
              Define, version, evaluate, render and compare compositions; problems, written in BIM,
              say what was possible.
            </p>
          </div>

          {/* Link columns */}
          <nav className="md:col-span-7 md:pl-8" aria-label="Footer navigation">
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
              {FOOTER_COLUMNS.map(column => (
                <div key={column.title}>
                  <p className="text-[11px] tracking-[0.2em] text-tp-on-cream uppercase">
                    {column.title}
                  </p>
                  <div className="mt-3 flex flex-col gap-2 text-sm text-tp-on-cream">
                    {column.links.map(link => (
                      <Link
                        key={link.label}
                        to={link.to}
                        className="cursor-pointer text-left transition-all duration-700 ease-[cubic-bezier(0.32,0.72,0,1)] hover:text-tp-accent"
                      >
                        {link.label}
                      </Link>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </nav>
        </div>

        {/* Bottom bar */}
        <div className="mt-10 flex flex-col gap-3 border-t border-tp-on-cream/15 pt-6 text-xs text-tp-on-cream md:flex-row md:items-center md:justify-between">
          <p>© {new Date().getFullYear()} OpenBinding</p>
          <div className="flex flex-wrap items-center gap-3">
            {INSTITUTIONAL_LINKS.map(link => (
              <a
                key={link.label}
                href={link.to}
                target="_blank"
                rel="noreferrer"
                className="cursor-pointer rounded-full border border-tp-on-cream/15 bg-tp-on-cream/5 px-3 py-1 transition-all duration-700 ease-[cubic-bezier(0.32,0.72,0,1)] hover:text-tp-accent"
              >
                {link.label}
              </a>
            ))}
            <InstitutionMark variant="wide" />
          </div>
        </div>
      </div>
    </footer>
  );
}
