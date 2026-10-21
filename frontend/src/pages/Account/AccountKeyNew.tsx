import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Check, Lock, Plus } from 'lucide-react';
import { apiClient, bimResourceKey } from '../../api/client';
import type { ApiKeyPermission, CreateApiKeyRequest, CreatedApiKey } from '../../api/auth';
import type { EngineCatalogEntry } from '../../api/client';
import { platformApi } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { FormField } from '../../components/ui/FormField';
import { Notice } from '../../components/ui/Notice';
import { useAuth } from '../../contexts/auth';
import { shortDigest } from '../../utils/digest';
import { useResource } from '../../utils/useResource';
import { classifyAuthError, fallbackMessage } from './accountErrors';
import { AccountLayout } from './AccountLayout';
import {
  ADMIN_ONLY, EXPIRY_PRESETS, PERMISSION_GROUPS, PRESETS, describeDescription, expiryFor, needsEngines,
  type ExpiryId,
} from './keysModel';
import { SecretDialog } from './SecretDialog';
import './AccountKeyNew.css';

const STEPS = ['Name', 'Permissions', 'Engines', 'Limits', 'Review'] as const;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
const KIND_SUGGESTIONS = ['jobs', 'studies', 'reports', 'cases', 'artifacts'];

type BoundaryKey = 'methods' | 'organizations' | 'projects' | 'resource_kinds' | 'slugs';
type BoundaryState = Record<BoundaryKey, string[]>;

const NO_BOUNDARY: BoundaryState = { methods: [], organizations: [], projects: [], resource_kinds: [], slugs: [] };

const ENGINE_MESSAGE = 'The permissions you chose need all engines or at least one exact engine.';

/** One restriction of the key: pick from what exists, or add an exact identifier that isn't listed. */
function BoundaryPicker({ label, options, selected, onChange, hint, freeText = true }: {
  label: string;
  options: readonly string[];
  selected: string[];
  onChange: (next: string[]) => void;
  hint?: string;
  freeText?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const shown = [...options, ...selected.filter((value) => !options.includes(value))];
  const toggle = (value: string) => onChange(selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value]);
  const add = () => {
    const values = draft.split(',').map((item) => item.trim()).filter(Boolean);
    if (values.length) onChange([...new Set([...selected, ...values])]);
    setDraft('');
  };
  return (
    <div className="keynew-bound" role="group" aria-label={label}>
      <span className="keynew-bound-label">{label}</span>
      <span className="keynew-pills">
        {shown.map((value) => (
          <button key={value} type="button" aria-pressed={selected.includes(value)} onClick={() => toggle(value)}>{value}</button>
        ))}
        {shown.length === 0 && <span className="acct-muted">{hint ?? 'None to pick from.'}</span>}
      </span>
      {freeText && (
        <span className="keynew-add">
          <input
            aria-label={`Add ${label.toLowerCase()}`}
            value={draft}
            placeholder="Add another, comma-separated"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); add(); } }}
          />
          <Action variant="secondary" size="sm" onClick={add} disabled={!draft.trim()}><Plus aria-hidden="true" />Add</Action>
        </span>
      )}
    </div>
  );
}

/** New API key (`acct-key-new`, `/app/account/keys/new`): a five-step wizard. */
export function AccountKeyNew() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const isAdmin = user?.role === 'admin';

  const [step, setStep] = useState(1);
  const [name, setName] = useState('');
  const [touched, setTouched] = useState(false);
  const [expiry, setExpiry] = useState<ExpiryId>('90');
  const [permissions, setPermissions] = useState<ApiKeyPermission[]>([]);
  const [allEngines, setAllEngines] = useState(true);
  const [engineKeys, setEngineKeys] = useState<string[]>([]);
  const [boundary, setBoundary] = useState<BoundaryState>(NO_BOUNDARY);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  // What the key could be narrowed to comes from what the account can reach; each source may fail without blocking the rest.
  const engines = useResource('keynew-engines', () => apiClient.getEngines().catch(() => [] as EngineCatalogEntry[]));
  const organizations = useResource('keynew-orgs', () => platformApi.organizations().catch(() => []));
  const projects = useResource('keynew-projects', async () => {
    const orgs = await platformApi.organizations().catch(() => []);
    const lists = await Promise.all(orgs.map((org) => platformApi.projects(org.slug).catch(() => [])));
    return lists.flat();
  });

  const catalog = engines.data ?? [];
  const orgSlugs = (organizations.data ?? []).map((org) => org.slug);
  const projectSlugs = [...new Set((projects.data ?? []).map((project) => project.slug))];
  const needsEngine = needsEngines(permissions);
  const selectedEngines = catalog.filter((engine) => engineKeys.includes(bimResourceKey(engine.ref)));

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  const nameError = touched && !name.trim() ? 'Give the key a name.' : undefined;

  const togglePermission = (permission: ApiKeyPermission) => {
    setError(null);
    setPermissions((current) => (current.includes(permission) ? current.filter((item) => item !== permission) : [...current, permission]));
  };

  const setBoundaryValues = (key: BoundaryKey) => (next: string[]) => setBoundary((current) => ({ ...current, [key]: next }));

  const request = (): CreateApiKeyRequest => {
    const restrictions = Object.fromEntries(Object.entries(boundary).filter(([, values]) => values.length > 0));
    const expires = expiryFor(expiry, Date.now());
    return {
      name: name.trim(),
      permissions,
      engine_access: { all: allEngines, engines: allEngines ? [] : selectedEngines.map((engine) => engine.ref) },
      ...(Object.keys(restrictions).length > 0 ? { boundary: restrictions } : {}),
      ...(expires ? { expires_at: expires } : {}),
    };
  };

  /** The refusal for the step being left, or `null`. */
  const refusalFor = (current: number): string | null => {
    if (current === 2 && permissions.length === 0) return 'Choose at least one permission.';
    if (current === 3 && needsEngine && !allEngines && selectedEngines.length === 0) return `422 · ${ENGINE_MESSAGE}`;
    return null;
  };

  const next = () => {
    if (step === 1 && !name.trim()) {
      setTouched(true);
      nameRef.current?.focus();
      return;
    }
    const refusal = refusalFor(step);
    if (refusal) {
      setError(refusal);
      return;
    }
    setError(null);
    setStep(step + 1);
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      setCreated(await apiClient.createApiKey(request()));
    } catch (caught) {
      const failure = classifyAuthError(caught);
      if (failure.kind === 'quota') setError('402 · You’ve reached your plan’s API key limit. Revoke a key or ask for an agreement with more keys.');
      else if (failure.status === 403 && failure.code === 'api_key_escalation') setError(`403 · api_key_escalation: ${failure.message || 'a key can only create keys with a subset of its own authority.'}`);
      else if (failure.status === 403 && failure.code === 'permission_not_grantable') setError('403 · permission_not_grantable: admin permissions can only be granted by a global administrator.');
      else if (failure.kind === 'invalid') {
        // The engines rule is the one a wizard can still get wrong; anything else is the gateway's own sentence.
        setError(`422 · ${/engine/i.test(failure.message ?? '') ? ENGINE_MESSAGE : failure.message || 'The gateway refused this combination.'}`);
        if (/engine/i.test(failure.message ?? '')) setStep(3);
      } else setError(fallbackMessage(failure, 'created'));
    } finally {
      setBusy(false);
    }
  };

  const canList = permissions.length ? permissions.map((permission) => `${describeDescription(permission)} (${permission})`) : ['Nothing yet'];
  const boundSummary = Object.values(boundary).flat();
  const adminLocked = !isAdmin;
  const expiryLabel = EXPIRY_PRESETS.find((item) => item.id === expiry)?.label ?? '';

  return (
    <AccountLayout
      section="keys"
      title="New API key"
      lede="Give the key only what it needs. It can never exceed your own account."
      above={(
        <nav aria-label="Breadcrumb" className="keynew-crumbs">
          <Link to="/app/account" viewTransition>Account</Link><span aria-hidden="true">/</span>
          <Link to="/app/account/keys" viewTransition>API keys</Link><span aria-hidden="true">/</span>
          <span aria-current="page">New key</span>
        </nav>
      )}
    >
      <ol aria-label="Steps" className="keynew-steps">
        {STEPS.map((label, index) => {
          const number = index + 1;
          const current = number === step;
          const done = number < step;
          return (
            <li key={label}>
              <button
                type="button"
                aria-current={current ? 'step' : undefined}
                disabled={!done}
                className={current ? 'is-current' : done ? 'is-done' : undefined}
                onClick={() => { setStep(number); setError(null); }}
              >
                <span aria-hidden="true">{done ? <Check /> : number}</span>
                {label}
                {done && <span className="sr-only"> (completed, go back)</span>}
              </button>
            </li>
          );
        })}
      </ol>

      <div aria-live="assertive">
        {error && (
          <div ref={errorRef} tabIndex={-1} className="keynew-error" role="alert">{error}</div>
        )}
      </div>

      <section className="keynew-panel" aria-label={`Step ${step} of ${STEPS.length}`}>
        {step === 1 && (
          <>
            <h2>Name and expiry</h2>
            <div className="keynew-two">
              <FormField
                label="Name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. ci-nightly-results"
                maxLength={128}
                autoComplete="off"
                error={nameError}
                inputRef={nameRef}
              />
              <div className="ui-field">
                <label htmlFor="keynew-expiry">Expires</label>
                <select id="keynew-expiry" value={expiry} onChange={(event) => setExpiry(event.target.value as ExpiryId)} aria-describedby="keynew-expiry-note">
                  {EXPIRY_PRESETS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                </select>
                <span id="keynew-expiry-note" className="ui-field-note">An expired key stops working; you’d create or rotate a new one.</span>
              </div>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <div className="keynew-perm-head">
              <h2>Permissions</h2>
              <span className="keynew-presets">
                <Action variant="secondary" size="sm" onClick={() => { setPermissions(PRESETS.read); setError(null); }}>Preset: read results</Action>
                <Action variant="secondary" size="sm" onClick={() => { setPermissions(PRESETS.run); setError(null); }}>Preset: run an engine</Action>
                <Action variant="link" size="sm" onClick={() => setPermissions([])}>Clear</Action>
              </span>
            </div>
            {PERMISSION_GROUPS.map((group) => (
              <fieldset key={group.name} className="keynew-group">
                <legend>{group.name}</legend>
                <div className="keynew-perms">
                  {group.permissions.map((permission) => {
                    const locked = ADMIN_ONLY.has(permission.id) && adminLocked;
                    const noteId = `perm-${permission.id.replace(/:/g, '-')}-note`;
                    return (
                      <label key={permission.id} className={`keynew-perm${locked ? ' is-locked' : ''}`}>
                        <input
                          type="checkbox"
                          checked={permissions.includes(permission.id)}
                          disabled={locked}
                          aria-describedby={noteId}
                          onChange={() => togglePermission(permission.id)}
                        />
                        <span>
                          <span className="keynew-perm-id">
                            {permission.id}
                            {ADMIN_ONLY.has(permission.id) && <span className="keynew-admin-badge">ADMIN</span>}
                          </span>
                          <span id={noteId} className="keynew-perm-desc">
                            {locked && <Lock aria-hidden="true" />}
                            {locked ? 'Only global administrators can grant this.' : permission.description}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            ))}
            {adminLocked && (
              <p className="acct-muted">Permissions marked ADMIN are only granted to global administrators, and admin routes still require the admin role.</p>
            )}
          </>
        )}

        {step === 3 && (
          <>
            <h2>Engine access</h2>
            <p>Permissions that run or read engine work (engines:*, jobs:read, instances:validate, studies:*) need all engines or at least one exact engine.</p>
            <div role="radiogroup" aria-label="Engine access" className="keynew-radios">
              <label className={allEngines ? 'is-on' : undefined}>
                <input type="radio" name="engine-access" checked={allEngines} onChange={() => { setAllEngines(true); setError(null); }} />
                <span><strong>All engines</strong><small>Includes engines added later, so the key can register new ones.</small></span>
              </label>
              <label className={!allEngines ? 'is-on' : undefined}>
                <input type="radio" name="engine-access" checked={!allEngines} onChange={() => setAllEngines(false)} />
                <span><strong>Only these engines</strong><small>Exact revisions with digest. Others answer 404 to this key.</small></span>
              </label>
            </div>
            {!allEngines && (
              <div className="keynew-engines">
                {engines.status === 'loading' && <p className="acct-muted keynew-engines-note">Loading engines…</p>}
                {engines.status !== 'loading' && catalog.length === 0 && <p className="acct-muted keynew-engines-note">No visible engines are available to select.</p>}
                {catalog.map((engine) => {
                  const key = bimResourceKey(engine.ref);
                  return (
                    <label key={key}>
                      <input
                        type="checkbox"
                        checked={engineKeys.includes(key)}
                        onChange={() => { setError(null); setEngineKeys((current) => (current.includes(key) ? current.filter((item) => item !== key) : [...current, key])); }}
                      />
                      <span className="keynew-engine-ref">{engine.namespace}/{engine.name}@{engine.version}</span>
                      <span className="keynew-engine-digest">{shortDigest(engine.digest)}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </>
        )}

        {step === 4 && (
          <>
            <h2>Limits <span className="keynew-optional">optional</span></h2>
            <p>Narrow where the key works. Requests outside these limits get 403 api_key_boundary.</p>
            <BoundaryPicker label="HTTP methods" options={METHODS} selected={boundary.methods} onChange={setBoundaryValues('methods')} freeText={false} />
            <BoundaryPicker label="Organizations" options={orgSlugs} selected={boundary.organizations} onChange={setBoundaryValues('organizations')} hint="You don’t belong to an organization yet." />
            <BoundaryPicker label="Projects" options={projectSlugs} selected={boundary.projects} onChange={setBoundaryValues('projects')} hint="No projects to pick from." />
            <BoundaryPicker label="Resource kinds" options={KIND_SUGGESTIONS} selected={boundary.resource_kinds} onChange={setBoundaryValues('resource_kinds')} />
            <BoundaryPicker label="Slugs" options={[]} selected={boundary.slugs} onChange={setBoundaryValues('slugs')} hint="Exact resource slugs, such as a case or study." />
          </>
        )}

        {step === 5 && (
          <>
            <h2>Review</h2>
            <dl className="keynew-review">
              <dt>Name</dt><dd><strong>{name.trim()}</strong></dd>
              <dt>Expires</dt><dd>{expiryLabel}</dd>
              <dt>Can</dt><dd><ul>{canList.map((item) => <li key={item}>{item}</li>)}</ul></dd>
              <dt>Engines</dt><dd>{allEngines ? 'All engines, including future ones' : selectedEngines.length ? selectedEngines.map((engine) => `${engine.namespace}/${engine.name}@${engine.version}`).join(', ') : 'None'}</dd>
              <dt>Limited to</dt><dd>{boundSummary.length ? boundSummary.join(' · ') : 'No extra limits'}</dd>
            </dl>
            <Notice tone="info">
              After creation the key’s authority can’t be edited. Rotating keeps it; to change it, create a new key and revoke this one.
              Even with these permissions, your account’s role and plan still apply to every request.
            </Notice>
          </>
        )}

        <div className="keynew-nav">
          {step > 1 ? <Action variant="secondary" onClick={() => { setStep(step - 1); setError(null); }}>Back</Action> : <Action to="/app/account/keys" variant="secondary">Cancel</Action>}
          {step < STEPS.length
            ? <Action variant="primary" onClick={next}>Continue</Action>
            : <Action variant="primary" onClick={() => void create()} busy={busy}>{busy ? 'Creating…' : 'Create key'}</Action>}
        </div>
      </section>

      {created && (
        <SecretDialog
          title={`“${created.name}” is ready. Copy its secret now`}
          secret={created.secret}
          doneLabel="Go to my keys"
          onDone={() => navigate('/app/account/keys')}
        >
          <p>This is the only time the secret is shown. Use it as <code>X-API-Key</code> or <code>Authorization: Bearer</code>.</p>
        </SecretDialog>
      )}
    </AccountLayout>
  );
}
