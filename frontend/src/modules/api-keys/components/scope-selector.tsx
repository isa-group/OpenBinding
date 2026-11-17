// Adapted from SPHERE frontend/src/modules/core/components/scope-selector.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: moved into the api-keys module; an OpenBinding key has one boundary, so one access level for the whole key (the
// HTTP methods it may use, utils/accessLevel.ts) instead of one per organization; a labelled radio group; react-icons.

import type { IconType } from 'react-icons';
import { FiEye, FiShield, FiShieldOff } from 'react-icons/fi';
import { ACCESS_LEVELS, type AccessLevel } from '../utils/accessLevel';

const ICONS: Record<AccessLevel, IconType> = {
  VIEW: FiEye,
  MANAGEMENT: FiShield,
  ALL: FiShieldOff,
};

interface ScopeSelectorProps {
  value: AccessLevel;
  onChange: (level: AccessLevel) => void;
  /** Where the level applies: the organizations chosen, or every one. */
  organizations: string[];
}

export default function ScopeSelector({ value, onChange, organizations }: ScopeSelectorProps) {
  const current = ACCESS_LEVELS.find(option => option.value === value);
  return (
    <div className="space-y-2">
      <p id="api-key-access-level" className="text-sm font-medium text-tp-ink">
        Access level
      </p>
      <div className="rounded-lg border border-tp-hairline bg-tp-surface p-3">
        <p className="mb-2 text-xs text-tp-steel">
          Applies to every request of the key
          {organizations.length > 0 ? `, which only reaches ${organizations.join(', ')}` : ''}.
        </p>
        <div
          role="radiogroup"
          aria-labelledby="api-key-access-level"
          className="flex flex-wrap gap-1.5"
        >
          {ACCESS_LEVELS.map(option => {
            const Icon = ICONS[option.value];
            const selected = value === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => onChange(option.value)}
                className={`flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                  selected
                    ? 'bg-tp-accent text-tp-on-primary'
                    : 'bg-tp-canvas text-tp-slate hover:bg-tp-hairline-soft'
                }`}
                title={option.description}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                {option.label}
              </button>
            );
          })}
        </div>
        {current && <p className="mt-2 text-xs text-tp-steel">{current.description}.</p>}
      </div>
    </div>
  );
}
