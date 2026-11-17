// Adapted from SPHERE frontend/src/modules/pricing/components/yaml-source-panel/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the toggle says whether it is open; the text is drawn by OpenBinding's SourceView (copyable, and the one place a
// source may be shown verbatim) inside SPHERE's panel; the heading names Composition2Yaml.

import { useState } from 'react';
import { SourceView } from '../../../run/components/rendering/SourceView';

interface YamlSourcePanelProps {
  yamlText: string;
  title?: string;
}

export default function YamlSourcePanel({ yamlText, title = 'YAML source' }: YamlSourcePanelProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-xl border border-tp-hairline bg-tp-canvas p-4">
      <button
        type="button"
        onClick={() => setExpanded(p => !p)}
        aria-expanded={expanded}
        className="flex w-full cursor-pointer items-center justify-between"
      >
        <h3 className="text-xs font-medium text-tp-ink">{title}</h3>
        <svg
          className={`h-4 w-4 shrink-0 text-tp-steel transition-transform md:hidden ${expanded ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
        </svg>
      </button>
      <div className={`${expanded ? 'block' : 'hidden'} mt-3 md:block`}>
        <SourceView source={yamlText} label={title} language="yaml" maxHeight="31rem" />
      </div>
    </div>
  );
}
