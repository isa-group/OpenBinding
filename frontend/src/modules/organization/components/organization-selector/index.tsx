// Adapted from SPHERE frontend/src/modules/pricing/components/organization-selector/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the account's organizations come from the OrganizationContext instead of a second request, and may be limited to
// a minimum role; preselected by slug (`?org=`, `?parent=`) instead of a fetch by id; a labelled button and a listbox; the
// theme's tokens; Spanish comments translated.

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import OrgAvatar from '../../../core/components/org-avatar';
import { avatarProps, type Organization, type OrgRole } from '../../api/organizationsApi';
import { useOrganization } from '../../hooks/useOrganization';

const RANK: Record<OrgRole, number> = { VIEWER: 1, MEMBER: 2, ADMIN: 3, OWNER: 4 };

interface OrganizationSelectorProps {
  value: Organization | null;
  onChange: (org: Organization | null) => void;
  /** The slug to preselect once the organizations are known. */
  initialSlug?: string | null;
  /** Only organizations where the account holds at least this role. */
  minRole?: OrgRole;
  label?: string;
  placeholder?: string;
}

export default function OrganizationSelector({
  value,
  onChange,
  initialSlug,
  minRole,
  label = 'Organization',
  placeholder = 'Select an organization',
}: OrganizationSelectorProps) {
  const { organizations: all, isLoading } = useOrganization();
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const labelId = useId();
  const listId = useId();

  const organizations = all.filter(
    org => !minRole || (org.effective_role ? RANK[org.effective_role] >= RANK[minRole] : false)
  );

  // The address names an organization: choose it once it is known. If it is not one of the account's, the person chooses.
  const preselect = organizations.find(org => org.slug === initialSlug) ?? null;
  const preselected = useRef(false);
  useEffect(() => {
    if (preselected.current || value || !preselect) return;
    preselected.current = true;
    onChange(preselect);
  }, [preselect, value, onChange]);

  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent | TouchEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setSearch('');
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
        setSearch('');
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('touchstart', handleClickOutside);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen]);

  const query = search.toLowerCase();
  const filtered = organizations.filter(
    org => org.name.toLowerCase().includes(query) || org.slug.toLowerCase().includes(query)
  );

  const handleSelect = useCallback(
    (org: Organization) => {
      onChange(org);
      setIsOpen(false);
      setSearch('');
    },
    [onChange]
  );

  const handleClear = useCallback(() => {
    onChange(null);
    setSearch('');
  }, [onChange]);

  return (
    <div ref={containerRef} className="relative">
      <span id={labelId} className="mb-1 block text-sm font-medium text-tp-ink">
        {label}
      </span>
      <div className="flex items-stretch gap-1">
        <button
          type="button"
          aria-labelledby={labelId}
          aria-haspopup="listbox"
          aria-expanded={isOpen}
          aria-controls={isOpen ? listId : undefined}
          onClick={() => {
            setIsOpen(!isOpen);
            setTimeout(() => inputRef.current?.focus(), 0);
          }}
          className="flex min-h-11 w-full cursor-pointer items-center justify-between rounded-md border border-tp-input-border bg-tp-input-bg px-3 py-2 text-left text-sm transition-colors hover:border-tp-hairline-strong"
        >
          <span className="flex min-w-0 items-center gap-2">
            {value && <OrgAvatar name={value.name} {...avatarProps(value.avatar)} size={20} />}
            <span className={`block truncate ${value ? 'text-tp-ink' : 'text-tp-steel'}`}>
              {value ? value.name : placeholder}
            </span>
          </span>
          <svg
            className={`h-4 w-4 shrink-0 text-tp-steel transition-transform ${isOpen ? 'rotate-180' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {value && (
          <button
            type="button"
            onClick={handleClear}
            aria-label={`Clear ${label.toLowerCase()}`}
            className="flex w-11 shrink-0 cursor-pointer items-center justify-center rounded-md border border-tp-input-border text-tp-steel hover:text-tp-ink"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      {isOpen && (
        <div className="absolute z-50 mt-1 w-full rounded-md border border-tp-hairline bg-tp-canvas shadow-elevation-3">
          <div className="border-b border-tp-hairline-soft p-2">
            <input
              ref={inputRef}
              type="text"
              aria-label="Search organizations"
              placeholder="Search organizations..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full rounded-md border border-tp-hairline px-3 py-1.5 text-sm outline-none focus:border-tp-primary"
            />
          </div>
          <div
            id={listId}
            role="listbox"
            aria-labelledby={labelId}
            className="max-h-50 overflow-y-auto"
          >
            {isLoading ? (
              <div className="px-3 py-4 text-center text-sm text-tp-steel">Loading...</div>
            ) : filtered.length === 0 ? (
              <div className="px-3 py-4 text-center text-sm text-tp-steel">
                {search ? 'No organizations found' : 'No organizations available'}
              </div>
            ) : (
              filtered.map(org => (
                <button
                  key={org.id}
                  type="button"
                  role="option"
                  aria-selected={value?.id === org.id}
                  onClick={() => handleSelect(org)}
                  className={`flex w-full cursor-pointer items-center gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-tp-surface ${
                    value?.id === org.id ? 'bg-tp-primary/5 text-tp-accent' : 'text-tp-ink'
                  }`}
                >
                  <OrgAvatar name={org.name} {...avatarProps(org.avatar)} size={24} />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-medium">{org.name}</span>
                    <span className="truncate text-xs text-tp-steel">@{org.slug}</span>
                  </span>
                  {value?.id === org.id && (
                    <svg
                      className="ml-auto h-4 w-4 text-tp-accent"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                      aria-hidden="true"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
