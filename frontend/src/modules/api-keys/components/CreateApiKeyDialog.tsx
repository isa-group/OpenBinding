// Adapted from SPHERE frontend/src/modules/api-keys/components/CreateApiKeyDialog.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's key: a name and an expiry, its permissions (with presets and the admin-only ones locked), the
// engines it may reach, and its boundary (organizations from OrganizationSearchInput, the access level of ScopeSelector,
// and optional resource kinds and slugs), with the field rules and refusals of OpenBinding's former five-step wizard, now in
// one form; drawn in OpenBinding's accessible Modal instead of SPHERE's motion overlay.

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { FiLock } from 'react-icons/fi';
import { bimResourceKey } from '../../../api/client';
import { useAuth } from '../../auth/hooks/useAuth';
import { classifyAuthError } from '../../core/api/errors';
import BlockAlert from '../../core/components/block-alert';
import { FormField } from '../../core/components/form-field';
import { Modal } from '../../core/components/modal';
import { fallbackMessage } from '../../core/utils/account-errors';
import {
  useApiKeysApi,
  type ApiKeyPermission,
  type CreateApiKeyRequest,
  type CreatedApiKey,
  type EngineCatalogEntry,
} from '../api/apiKeysApi';
import { methodsOf, type AccessLevel } from '../utils/accessLevel';
import {
  ADMIN_ONLY,
  EXPIRY_PRESETS,
  PERMISSION_GROUPS,
  PRESETS,
  expiryFor,
  needsEngines,
  type ExpiryId,
} from '../utils/keysModel';
import OrganizationSearchInput, { type OrgSearchResult } from './organization-search-input';
import ScopeSelector from './scope-selector';

const ENGINE_MESSAGE = 'The permissions you chose need all engines or at least one exact engine.';

const SUBTLE_BUTTON =
  'cursor-pointer rounded-md border border-tp-hairline-strong bg-tp-canvas px-2.5 py-1 text-xs font-medium text-tp-ink transition-colors hover:bg-tp-surface';

/** `runs, studies` → `['runs', 'studies']`. */
const listOf = (text: string) => [
  ...new Set(
    text
      .split(',')
      .map(item => item.trim())
      .filter(Boolean)
  ),
];

interface CreateApiKeyDialogProps {
  onClose: () => void;
  /** The gateway made the key: its one answer with the secret. */
  onCreated: (created: CreatedApiKey) => void;
}

export default function CreateApiKeyDialog({ onClose, onCreated }: CreateApiKeyDialogProps) {
  const { user } = useAuth();
  const api = useApiKeysApi();
  const adminLocked = user?.role !== 'admin';

  const [name, setName] = useState('');
  const [touched, setTouched] = useState(false);
  const [expiry, setExpiry] = useState<ExpiryId>('90');
  const [permissions, setPermissions] = useState<ApiKeyPermission[]>([]);
  const [allEngines, setAllEngines] = useState(true);
  const [engineKeys, setEngineKeys] = useState<string[]>([]);
  const [engines, setEngines] = useState<EngineCatalogEntry[] | null>(null);
  const [selectedOrgs, setSelectedOrgs] = useState<OrgSearchResult[]>([]);
  const [level, setLevel] = useState<AccessLevel>('ALL');
  const [kinds, setKinds] = useState('');
  const [slugs, setSlugs] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  // Only the engines this account can see can be chosen; a failed read leaves the list empty.
  useEffect(() => {
    let current = true;
    api
      .listEngines()
      .then(list => current && setEngines(list))
      .catch(() => current && setEngines([]));
    return () => {
      current = false;
    };
  }, [api]);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  const catalog = engines ?? [];
  const selectedEngines = catalog.filter(engine => engineKeys.includes(bimResourceKey(engine.ref)));
  const needsEngine = needsEngines(permissions);
  const nameError = touched && !name.trim() ? 'Give the key a name.' : undefined;

  const togglePermission = (permission: ApiKeyPermission) => {
    setError(null);
    setPermissions(current =>
      current.includes(permission)
        ? current.filter(item => item !== permission)
        : [...current, permission]
    );
  };

  const request = (): CreateApiKeyRequest => {
    const methods = methodsOf(level);
    const boundary = {
      ...(methods ? { methods } : {}),
      ...(selectedOrgs.length ? { organizations: selectedOrgs.map(org => org.slug) } : {}),
      ...(listOf(kinds).length ? { resource_kinds: listOf(kinds) } : {}),
      ...(listOf(slugs).length ? { slugs: listOf(slugs) } : {}),
    };
    const expires = expiryFor(expiry, Date.now());
    return {
      name: name.trim(),
      permissions,
      engine_access: {
        all: allEngines,
        engines: allEngines ? [] : selectedEngines.map(engine => engine.ref),
      },
      ...(Object.keys(boundary).length > 0 ? { boundary } : {}),
      ...(expires ? { expires_at: expires } : {}),
    };
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!name.trim()) {
      nameRef.current?.focus();
      return;
    }
    if (permissions.length === 0) {
      setError('Choose at least one permission.');
      return;
    }
    if (needsEngine && !allEngines && selectedEngines.length === 0) {
      setError(`422 · ${ENGINE_MESSAGE}`);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      onCreated(await api.createApiKey(request()));
    } catch (caught) {
      const failure = classifyAuthError(caught);
      if (failure.kind === 'quota')
        setError(
          '402 · You’ve reached your plan’s API key limit. Revoke a key or ask for an agreement with more keys.'
        );
      else if (failure.status === 403 && failure.code === 'api_key_escalation')
        setError(
          `403 · api_key_escalation: ${failure.message || 'a key can only create keys with a subset of its own authority.'}`
        );
      else if (failure.status === 403 && failure.code === 'permission_not_grantable')
        setError(
          '403 · permission_not_grantable: admin permissions can only be granted by a global administrator.'
        );
      else if (failure.kind === 'invalid')
        setError(
          `422 · ${/engine/i.test(failure.message ?? '') ? ENGINE_MESSAGE : failure.message || 'The gateway refused this combination.'}`
        );
      else setError(fallbackMessage(failure, 'created'));
      setLoading(false);
    }
  };

  return (
    <Modal title="Create new API key" size="lg" onClose={() => !loading && onClose()}>
      <p className="mb-4 text-sm text-tp-steel">
        Give the key only what it needs. It can never exceed your own account, and its authority
        can’t be edited after creation.
      </p>

      <div aria-live="assertive">
        {error && (
          <div ref={errorRef} tabIndex={-1} className="mb-4 focus:outline-none">
            <BlockAlert variant="error" message={error} />
          </div>
        )}
      </div>

      <form onSubmit={handleSubmit} noValidate className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            label="Name"
            value={name}
            onChange={event => setName(event.target.value)}
            onBlur={() => setTouched(true)}
            placeholder="Example: CI/CD Pipeline"
            maxLength={128}
            autoComplete="off"
            error={nameError}
            inputRef={nameRef}
          />
          <div className="flex min-w-0 flex-col gap-1.5">
            <label htmlFor="api-key-expiry" className="text-sm font-medium text-tp-ink">
              Expires
            </label>
            <select
              id="api-key-expiry"
              value={expiry}
              onChange={event => setExpiry(event.target.value as ExpiryId)}
              aria-describedby="api-key-expiry-note"
              className="h-11 w-full cursor-pointer rounded-md border border-tp-input-border bg-tp-input-bg px-3 text-sm text-tp-ink outline-none focus:border-tp-primary focus:ring-2 focus:ring-tp-primary/20"
            >
              {EXPIRY_PRESETS.map(item => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
            <span id="api-key-expiry-note" className="text-xs text-tp-steel">
              An expired key stops working; rotate it or create another.
            </span>
          </div>
        </div>

        <div role="group" aria-labelledby="api-key-permissions" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p id="api-key-permissions" className="text-sm font-medium text-tp-ink">
              Permissions
            </p>
            <span className="flex flex-wrap gap-1.5">
              <button
                type="button"
                className={SUBTLE_BUTTON}
                onClick={() => {
                  setPermissions(PRESETS.read);
                  setError(null);
                }}
              >
                Preset: read results
              </button>
              <button
                type="button"
                className={SUBTLE_BUTTON}
                onClick={() => {
                  setPermissions(PRESETS.run);
                  setError(null);
                }}
              >
                Preset: run an engine
              </button>
              <button type="button" className={SUBTLE_BUTTON} onClick={() => setPermissions([])}>
                Clear
              </button>
            </span>
          </div>
          {PERMISSION_GROUPS.map(group => (
            <div
              key={group.name}
              role="group"
              aria-label={group.name}
              className="rounded-lg border border-tp-hairline p-3"
            >
              <p className="mb-2 text-xs font-semibold tracking-wide text-tp-steel uppercase">
                {group.name}
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                {group.permissions.map(permission => {
                  const locked = ADMIN_ONLY.has(permission.id) && adminLocked;
                  return (
                    <label
                      key={permission.id}
                      className={`flex items-start gap-2 text-sm ${locked ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 cursor-pointer accent-tp-accent disabled:cursor-not-allowed"
                        checked={permissions.includes(permission.id)}
                        disabled={locked}
                        onChange={() => togglePermission(permission.id)}
                      />
                      <span className="min-w-0">
                        <code className="text-xs text-tp-ink">{permission.id}</code>
                        {ADMIN_ONLY.has(permission.id) && (
                          <span className="ml-1.5 rounded bg-tp-surface px-1 text-[10px] font-semibold text-tp-steel">
                            ADMIN
                          </span>
                        )}
                        <span className="block text-xs text-tp-steel">
                          {locked && <FiLock className="mr-1 inline h-3 w-3" aria-hidden="true" />}
                          {locked
                            ? 'Only global administrators can grant this.'
                            : permission.description}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-tp-ink">Engine access</legend>
          <p className="text-xs text-tp-steel">
            Permissions that run or read engine work (<code>engines:*</code>, <code>jobs:read</code>
            , <code>studies:*</code>) need all engines or at least one exact engine.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <label
              className={`flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm ${allEngines ? 'border-tp-primary bg-tp-primary/5' : 'border-tp-hairline'}`}
            >
              <input
                type="radio"
                name="engine-access"
                className="mt-0.5 cursor-pointer accent-tp-accent"
                checked={allEngines}
                onChange={() => {
                  setAllEngines(true);
                  setError(null);
                }}
              />
              <span>
                <strong className="block text-tp-ink">All engines</strong>
                <span className="text-xs text-tp-steel">
                  Includes engines added later, so the key can register new ones.
                </span>
              </span>
            </label>
            <label
              className={`flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm ${!allEngines ? 'border-tp-primary bg-tp-primary/5' : 'border-tp-hairline'}`}
            >
              <input
                type="radio"
                name="engine-access"
                className="mt-0.5 cursor-pointer accent-tp-accent"
                checked={!allEngines}
                onChange={() => setAllEngines(false)}
              />
              <span>
                <strong className="block text-tp-ink">Only these engines</strong>
                <span className="text-xs text-tp-steel">
                  Exact revisions. Others answer 404 to this key.
                </span>
              </span>
            </label>
          </div>
          {!allEngines && (
            <div
              role="group"
              aria-label="Engines"
              className="max-h-48 space-y-1.5 overflow-y-auto rounded-lg border border-tp-hairline p-3"
            >
              {engines === null && <p className="text-xs text-tp-steel">Loading engines…</p>}
              {engines !== null && catalog.length === 0 && (
                <p className="text-xs text-tp-steel">No visible engines are available to select.</p>
              )}
              {catalog.map(engine => {
                const key = bimResourceKey(engine.ref);
                return (
                  <label key={key} className="flex cursor-pointer items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="cursor-pointer accent-tp-accent"
                      checked={engineKeys.includes(key)}
                      onChange={() => {
                        setError(null);
                        setEngineKeys(current =>
                          current.includes(key)
                            ? current.filter(item => item !== key)
                            : [...current, key]
                        );
                      }}
                    />
                    <code className="text-xs break-all text-tp-ink">
                      {engine.namespace}/{engine.name}@{engine.version}
                    </code>
                  </label>
                );
              })}
            </div>
          )}
        </fieldset>

        <div className="space-y-2">
          <p className="text-sm font-medium text-tp-ink">
            Organizations <span className="font-normal text-tp-steel">(optional)</span>
          </p>
          <OrganizationSearchInput
            selectedOrgs={selectedOrgs}
            onOrgsChange={setSelectedOrgs}
            placeholder="Every organization you belong to"
          />
          <p className="text-xs text-tp-steel">
            With organizations chosen, the key answers 403 api_key_boundary everywhere else.
          </p>
        </div>

        <ScopeSelector
          value={level}
          onChange={setLevel}
          organizations={selectedOrgs.map(org => org.slug)}
        />

        <details className="rounded-lg border border-tp-hairline px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium text-tp-ink">More limits</summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <FormField
              label="Resource kinds"
              value={kinds}
              onChange={event => setKinds(event.target.value)}
              placeholder="runs, studies, problems"
              hint="Comma-separated."
              autoComplete="off"
            />
            <FormField
              label="Slugs"
              value={slugs}
              onChange={event => setSlugs(event.target.value)}
              placeholder="latency-study"
              hint="Exact resource slugs, comma-separated."
              autoComplete="off"
            />
          </div>
        </details>

        <div className="flex justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="cursor-pointer rounded-lg border border-tp-hairline px-4 py-2 text-sm text-tp-slate transition-colors hover:bg-tp-surface disabled:cursor-not-allowed disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={loading}
            aria-busy={loading || undefined}
            className="cursor-pointer rounded-lg bg-tp-accent px-4 py-2 text-sm font-medium text-tp-on-primary transition-colors hover:bg-tp-primary-deep disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? 'Creating…' : 'Create key'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
