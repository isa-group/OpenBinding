// Adapted from SPHERE frontend/src/modules/pricing/components/pricing-card/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: an engine revision instead of a pricing: the header is its namespace with a Published or Private pill, the title
// its namespace/name, and the chips its version and modes, then what the gateway says about its registration and
// conformance. The name is a real link stretched over the card (SPHERE navigated on click, which loses middle-click and the
// keyboard); there is no kebab menu, since a revision is changed from its registration.

import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { BUILTIN_NAMESPACE, glyphOf, type EngineRow } from '../../api/enginesModel';

export default function EngineCard({ row }: { row: EngineRow }) {
  const { engine } = row;
  const builtin = engine.namespace === BUILTIN_NAMESPACE;
  const published = row.visibility === 'public';
  const extras = row.chips.filter(chip => !/^(Public|Private)/.test(chip));
  return (
    <motion.article
      whileHover={{ y: -2 }}
      transition={{ duration: 0.15 }}
      aria-label={`${engine.namespace}/${engine.name} ${engine.version}`}
      className="group relative h-full rounded-xl border border-tp-hairline bg-tp-canvas p-4 transition-colors focus-within:border-tp-hairline-strong hover:border-tp-hairline-strong hover:shadow-elevation-2"
    >
      <div className="mb-3 min-w-0">
        <div className="mb-1 flex items-center gap-2">
          <span
            aria-hidden="true"
            className={`flex h-5 w-5 shrink-0 items-center justify-center rounded text-[9px] font-semibold ${
              builtin ? 'bg-tp-primary/10 text-tp-accent' : 'bg-tp-surface text-tp-slate'
            }`}
          >
            {glyphOf(engine.name)}
          </span>
          <span className="truncate font-mono text-[11px] text-tp-steel">{engine.namespace}</span>
          <span
            className={`rounded-full px-1.5 py-px text-[10px] font-semibold ${
              published ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-800'
            }`}
          >
            {published ? 'Published' : row.yours ? 'Private · yours' : 'Private'}
          </span>
        </div>
        <h3 className="min-w-0 text-sm font-medium text-tp-ink group-hover:text-tp-accent">
          <Link
            to={row.href}
            className="block cursor-pointer truncate py-1 outline-none after:absolute after:inset-0 after:rounded-xl after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-tp-primary"
          >
            {engine.namespace}/{engine.name}
          </Link>
        </h3>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-[11px] text-tp-steel">
        <span className="inline-flex items-center rounded bg-tp-primary/10 px-1.5 py-0.5 font-mono text-tp-ink">
          v{engine.version}
        </span>
        {engine.modes.length === 0 && (
          <span className="rounded bg-tp-surface px-1.5 py-0.5">no modes advertised</span>
        )}
        {engine.modes.map(mode => (
          <span key={mode.id} className="rounded bg-tp-surface px-1.5 py-0.5">
            mode · {mode.id}
          </span>
        ))}
      </div>
      {extras.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] text-tp-steel">
          {extras.map(chip => (
            <span key={chip} className="rounded-full border border-tp-hairline px-1.5 py-px">
              {chip}
            </span>
          ))}
        </div>
      )}
    </motion.article>
  );
}
