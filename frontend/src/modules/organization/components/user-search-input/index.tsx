// Adapted from SPHERE frontend/src/modules/organization/components/user-search-input/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's user search (`GET /v1/users?q=`, usernames only, never an email) through the organizations API;
// the list opens below the field instead of in a portal, so it stays inside a dialog's focus trap; a combobox with its
// listbox for assistive technology; a failed search says so instead of logging to the console; people already chosen,
// or already members, are left out.

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import Iconify from '../../../core/components/iconify';
import UserAvatar from '../../../core/components/user-avatar';
import { useOrganizationsApi, type UserRef } from '../../api/organizationsApi';

export type UserSearchResult = UserRef;

interface UserSearchInputProps {
  selectedUsers: UserSearchResult[];
  onUsersChange: (users: UserSearchResult[]) => void;
  placeholder?: string;
  maxUsers?: number;
  /** People who may not be chosen (the organization's members). */
  excludedIds?: ReadonlySet<string>;
  label?: string;
}

const DEBOUNCE_MS = 500;
const MIN_CHARS = 4;

export default function UserSearchInput({
  selectedUsers,
  onUsersChange,
  placeholder = 'Search people by username...',
  maxUsers = 20,
  excludedIds,
  label = 'People',
}: UserSearchInputProps) {
  const { searchUsers } = useOrganizationsApi();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<UserSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [failed, setFailed] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputId = useId();
  const listId = useId();

  useEffect(() => {
    if (query.length < MIN_CHARS) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- SPHERE's reset of a query too short to search
      setResults([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setIsSearching(true);
      setFailed(false);
      searchUsers(query, controller.signal)
        .then(found => {
          setResults(
            found.filter(
              user =>
                !selectedUsers.some(chosen => chosen.id === user.id) && !excludedIds?.has(user.id)
            )
          );
          setHighlightedIndex(0);
        })
        .catch(() => {
          if (!controller.signal.aborted) setFailed(true);
        })
        .finally(() => {
          if (!controller.signal.aborted) setIsSearching(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, searchUsers, selectedUsers, excludedIds]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSelect = (user: UserSearchResult) => {
    if (!selectedUsers.some(u => u.id === user.id)) onUsersChange([...selectedUsers, user]);
    setQuery('');
    setResults([]);
    setIsOpen(false);
    setHighlightedIndex(0);
    inputRef.current?.focus();
  };

  const handleRemove = (userId: string) => {
    onUsersChange(selectedUsers.filter(u => u.id !== userId));
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!isOpen && results.length > 0) setIsOpen(true);
      setHighlightedIndex(prev => Math.min(prev + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex(prev => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (results.length > 0) handleSelect(results[Math.max(highlightedIndex, 0)]);
    } else if (e.key === 'Backspace' && query === '' && selectedUsers.length > 0) {
      handleRemove(selectedUsers[selectedUsers.length - 1].id);
    }
  };

  const showList = isOpen && query.length >= MIN_CHARS && !isSearching;

  return (
    <div ref={containerRef} className="relative">
      <label
        htmlFor={inputId}
        className="mb-1.5 block text-xs font-medium tracking-wide text-tp-steel uppercase"
      >
        {label}
      </label>
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-tp-hairline bg-tp-canvas px-3 py-2 focus-within:border-tp-primary focus-within:ring-1 focus-within:ring-tp-primary/20">
        {selectedUsers.map(user => (
          <span
            key={user.id}
            className="flex items-center gap-1 rounded-full bg-tp-surface px-2 py-0.5 text-xs font-medium text-tp-ink"
          >
            {user.username}
            <button
              type="button"
              onClick={() => handleRemove(user.id)}
              aria-label={`Remove ${user.username}`}
              className="cursor-pointer text-tp-steel hover:text-tp-ink"
            >
              <Iconify icon="mdi:close" width={12} />
            </button>
          </span>
        ))}

        <input
          id={inputId}
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={showList && results.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          autoComplete="off"
          value={query}
          onChange={e => {
            setQuery(e.target.value);
            setIsOpen(true);
          }}
          onFocus={() => {
            if (results.length > 0) setIsOpen(true);
          }}
          onKeyDown={handleKeyDown}
          placeholder={selectedUsers.length === 0 ? placeholder : ''}
          disabled={selectedUsers.length >= maxUsers}
          className="min-w-32 flex-1 bg-transparent text-sm text-tp-ink outline-none placeholder:text-tp-muted"
        />

        {isSearching && (
          <div
            role="status"
            aria-label="Searching"
            className="h-4 w-4 animate-spin rounded-full border-2 border-tp-primary border-t-transparent"
          />
        )}
      </div>
      <p className="mt-1 text-xs text-tp-steel">Type at least {MIN_CHARS} letters of a username.</p>

      {showList && results.length > 0 && (
        <ul
          id={listId}
          role="listbox"
          aria-label="People found"
          className="absolute right-0 left-0 z-50 mt-1 max-h-60 overflow-y-auto rounded-lg border border-tp-hairline bg-tp-canvas py-1 shadow-elevation-4"
        >
          {results.map((user, index) => (
            <li
              key={user.id}
              role="option"
              aria-selected={index === highlightedIndex}
              onClick={() => handleSelect(user)}
              onMouseEnter={() => setHighlightedIndex(index)}
              className={`flex w-full cursor-pointer items-center gap-3 px-3 py-2 text-left transition-colors ${
                index === highlightedIndex ? 'bg-tp-surface' : ''
              }`}
            >
              <UserAvatar
                username={user.username}
                displayName={user.display_name}
                avatar={user.avatar}
                size={32}
              />
              <div className="min-w-0">
                {user.display_name && (
                  <p className="truncate text-sm font-medium text-tp-ink">{user.display_name}</p>
                )}
                <p
                  className={
                    user.display_name ? 'text-xs text-tp-steel' : 'text-sm font-medium text-tp-ink'
                  }
                >
                  @{user.username}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
      {showList && results.length === 0 && (
        <p className="mt-1 rounded-lg border border-tp-hairline bg-tp-canvas py-3 text-center text-sm text-tp-steel">
          {failed ? 'The search failed. Try again.' : 'No people found'}
        </p>
      )}
    </div>
  );
}
