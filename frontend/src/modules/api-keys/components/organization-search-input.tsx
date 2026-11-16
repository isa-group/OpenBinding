// Adapted from SPHERE frontend/src/modules/core/components/organization-search-input.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: moved into the api-keys module because it reads the organization API; OpenBinding's organizations (named by slug,
// the tree flattened by `flattenOrganizations`); the input is a combobox with its listbox and active option announced; the
// list is drawn below the field in place, inside the dialog, instead of portaled to the body; a failed read is said;
// react-icons instead of iconify.

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { FiX } from 'react-icons/fi';
import { readApiError } from '../../core/api/errors';
import { flattenOrganizations, useOrganizationsApi } from '../../organization/api/organizationsApi';

export interface OrgSearchResult {
  id: string;
  slug: string;
  name: string;
}

interface OrganizationSearchInputProps {
  selectedOrgs: OrgSearchResult[];
  onOrgsChange: (orgs: OrgSearchResult[]) => void;
  placeholder?: string;
}

export default function OrganizationSearchInput({
  selectedOrgs,
  onOrgsChange,
  placeholder = 'Search organizations...',
}: OrganizationSearchInputProps) {
  const listId = useId();
  const [query, setQuery] = useState('');
  const [allOrgs, setAllOrgs] = useState<OrgSearchResult[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { getMyOrganizations } = useOrganizationsApi();

  useEffect(() => {
    let current = true;
    getMyOrganizations()
      .then(tree => {
        if (!current) return;
        setAllOrgs(
          flattenOrganizations(tree).map(org => ({ id: org.id, slug: org.slug, name: org.name }))
        );
      })
      .catch((caught: unknown) => {
        if (current)
          setLoadError(
            `Your organizations couldn’t be loaded${readApiError(caught).status ? ` (${readApiError(caught).status})` : ''}.`
          );
      })
      .finally(() => {
        if (current) setIsLoading(false);
      });
    return () => {
      current = false;
    };
  }, [getMyOrganizations]);

  useEffect(() => {
    if (!isOpen) return;
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allOrgs.filter(
      org =>
        !selectedOrgs.some(selected => selected.id === org.id) &&
        (org.slug.toLowerCase().includes(q) || org.name.toLowerCase().includes(q))
    );
  }, [allOrgs, query, selectedOrgs]);

  const active = Math.min(highlightedIndex, Math.max(results.length - 1, 0));

  const handleSelect = (org: OrgSearchResult) => {
    if (!selectedOrgs.some(selected => selected.id === org.id)) {
      onOrgsChange([...selectedOrgs, org]);
    }
    setQuery('');
    setIsOpen(false);
    setHighlightedIndex(0);
  };

  const handleRemove = (orgId: string) => {
    onOrgsChange(selectedOrgs.filter(org => org.id !== orgId));
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!isOpen) setIsOpen(true);
      setHighlightedIndex(Math.min(active + 1, results.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlightedIndex(Math.max(active - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (isOpen && results.length > 0) handleSelect(results[active]);
    } else if (event.key === 'Escape' && isOpen) {
      // Close the list, not the dialog around it.
      event.stopPropagation();
      setIsOpen(false);
    } else if (event.key === 'Backspace' && query === '' && selectedOrgs.length > 0) {
      handleRemove(selectedOrgs[selectedOrgs.length - 1].id);
    }
  };

  const showList = isOpen && results.length > 0;
  const showEmpty = isOpen && !isLoading && results.length === 0 && allOrgs.length > 0;

  return (
    <div ref={containerRef} className="relative">
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-tp-input-border bg-tp-input-bg px-3 py-2 focus-within:border-tp-primary focus-within:ring-1 focus-within:ring-tp-primary/20">
        {selectedOrgs.map(org => (
          <span
            key={org.id}
            className="flex items-center gap-1 rounded-full bg-tp-surface px-2 py-0.5 text-xs font-medium text-tp-ink"
          >
            {org.name}
            <button
              type="button"
              aria-label={`Remove ${org.name}`}
              onClick={() => handleRemove(org.id)}
              className="cursor-pointer text-tp-steel hover:text-tp-ink"
            >
              <FiX className="h-3 w-3" aria-hidden="true" />
            </button>
          </span>
        ))}

        <input
          type="text"
          role="combobox"
          aria-label="Search organizations"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList ? `${listId}-${active}` : undefined}
          value={query}
          onChange={event => {
            setQuery(event.target.value);
            setHighlightedIndex(0);
            setIsOpen(true);
          }}
          onFocus={() => setIsOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={selectedOrgs.length === 0 ? placeholder : ''}
          className="min-w-[120px] flex-1 bg-transparent text-sm text-tp-ink outline-none placeholder:text-tp-muted"
        />

        {isLoading && (
          <div
            className="h-4 w-4 animate-spin rounded-full border-2 border-tp-primary border-t-transparent"
            aria-hidden="true"
          />
        )}
      </div>

      {loadError && <p className="mt-1 text-xs text-tp-error-strong">{loadError}</p>}
      {!isLoading && !loadError && allOrgs.length === 0 && (
        <p className="mt-1 text-xs text-tp-steel">You don’t belong to an organization yet.</p>
      )}

      {showList && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Organizations"
          className="absolute right-0 left-0 z-10 mt-1 max-h-60 overflow-y-auto rounded-lg border border-tp-hairline bg-tp-canvas py-1 shadow-elevation-4"
        >
          {results.map((org, index) => (
            <li
              key={org.id}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              onMouseDown={event => event.preventDefault()}
              onClick={() => handleSelect(org)}
              onMouseEnter={() => setHighlightedIndex(index)}
              className={`flex w-full cursor-pointer items-center gap-3 px-3 py-2 text-left transition-colors ${
                index === active ? 'bg-tp-surface' : ''
              }`}
            >
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-tp-primary/10 text-xs font-medium text-tp-accent">
                {org.name.charAt(0).toUpperCase()}
              </div>
              <div>
                <p className="text-sm font-medium text-tp-ink">{org.name}</p>
                <p className="text-xs text-tp-steel">@{org.slug}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
      {showEmpty && (
        <div className="absolute right-0 left-0 z-10 mt-1 rounded-lg border border-tp-hairline bg-tp-canvas py-4 text-center shadow-elevation-4">
          <p className="text-sm text-tp-steel">No organizations found</p>
        </div>
      )}
    </div>
  );
}
