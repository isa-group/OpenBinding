import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ArrowRight, Check, CloudCog, Fingerprint, GitCompareArrows, Search, Server, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  apiClient,
  bimResourceKey,
  HttpError,
  type CapabilitySelector,
  type EngineCatalogEntry,
  type EngineMode,
  type EngineRegistrationRevision,
  type EngineRegistrationState,
} from '../../api/client';
import { useAuth } from '../../contexts/auth';
import { Alert } from '../../components/ui/Alert';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import './Engines.css';

function shortDigest(digest: string): string {
  return digest.length > 22 ? `${digest.slice(0, 14)}…${digest.slice(-6)}` : digest;
}

function selectorTitle(selector: CapabilitySelector): string {
  if (selector.selector === 'none') return 'none';
  if (selector.selector === 'all') return 'all declared values';
  return selector.values?.join(', ') || 'invalid empty selector';
}

function modeKey(engine: EngineCatalogEntry, mode: EngineMode): string {
  return `${bimResourceKey(engine.ref)}::${mode.id}`;
}

function deploymentErrorMessage(reason: unknown): string {
  if (reason instanceof HttpError) {
    const diagnostic = reason.diagnostics?.find(
      (item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
    );
    const diagnosticMessage = diagnostic?.message;
    if (typeof diagnosticMessage === 'string' && diagnosticMessage) {
      return `${reason.message} ${diagnosticMessage}`;
    }
  }
  return reason instanceof Error ? reason.message : 'The deployment change was refused.';
}

const deploymentStates: Record<EngineRegistrationState, {
  label: string;
  hint: string;
  badge: 'default' | 'success' | 'warning' | 'error' | 'info';
}> = {
  private: { label: 'Private', hint: 'Visible only to your account; administrators cannot discover it.', badge: 'info' },
  pending_review: { label: 'In review', hint: 'Visible to administrators because you requested publication.', badge: 'warning' },
  published: { label: 'Published', hint: 'Available to every authenticated compatible account.', badge: 'success' },
  rejected: { label: 'Rejected', hint: 'Not published; it remains private to your account.', badge: 'error' },
};

export function Engines() {
  const { user } = useAuth();
  const [engines, setEngines] = useState<EngineCatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selectedEngineKey, setSelectedEngineKey] = useState('');
  const [selectedModeId, setSelectedModeId] = useState('');
  const [deployments, setDeployments] = useState<EngineRegistrationRevision[]>([]);
  const [deploymentsLoading, setDeploymentsLoading] = useState(false);
  const [deploymentError, setDeploymentError] = useState<string | null>(null);
  const [deploymentNotice, setDeploymentNotice] = useState<string | null>(null);
  const [busyDeployment, setBusyDeployment] = useState('');
  const [credentialEditor, setCredentialEditor] = useState('');
  const [credentialValue, setCredentialValue] = useState('');
  const modeTabsId = useId();
  const modeTabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const username = user?.username;

  const loadDeployments = useCallback(async () => {
    if (!username) {
      setDeployments([]);
      setDeploymentsLoading(false);
      setDeploymentError(null);
      setDeploymentNotice(null);
      return;
    }
    setDeploymentsLoading(true);
    setDeploymentError(null);
    try {
      const registrations = await apiClient.listEngineRegistrations();
      setDeployments(registrations.filter((registration) => registration.namespace === username));
    } catch (reason: unknown) {
      setDeploymentError(reason instanceof Error ? reason.message : 'Your deployments could not be loaded.');
    } finally {
      setDeploymentsLoading(false);
    }
  }, [username]);

  const loadEngines = () => {
    setLoading(true);
    setError(null);
    void apiClient.getEngines()
      .then((data) => {
        setEngines(data);
        const first = data[0];
        if (first) {
          setSelectedEngineKey((current) => data.some((engine) => bimResourceKey(engine.ref) === current) ? current : bimResourceKey(first.ref));
          setSelectedModeId((current) => first.modes.some((mode) => mode.id === current) ? current : first.modes[0]?.id || '');
        }
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'The Engine catalogue could not be loaded.'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    let cancelled = false;
    void apiClient.getEngines()
      .then((data) => {
        if (cancelled) return;
        setEngines(data);
        const first = data[0];
        if (first) {
          setSelectedEngineKey(bimResourceKey(first.ref));
          setSelectedModeId(first.modes[0]?.id || '');
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'The Engine catalogue could not be loaded.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    void loadDeployments();
  }, [loadDeployments]);

  const filtered = useMemo(() => engines.filter((engine) => {
    const text = `${engine.namespace}/${engine.name} ${engine.version} ${engine.modes.map((mode) => `${mode.id} ${mode.algorithm} ${mode.profile}`).join(' ')}`;
    return text.toLowerCase().includes(query.trim().toLowerCase());
  }), [engines, query]);
  const selectedEngine = filtered.find((engine) => bimResourceKey(engine.ref) === selectedEngineKey) ?? filtered[0];
  const selectedMode = selectedEngine?.modes.find((mode) => mode.id === selectedModeId) ?? selectedEngine?.modes[0];
  const selectedModeIndex = selectedEngine && selectedMode
    ? selectedEngine.modes.findIndex((mode) => mode.id === selectedMode.id)
    : -1;
  const capabilityEntries = selectedMode ? Object.entries(selectedMode.capabilities) as Array<[string, CapabilitySelector]> : [];

  const selectEngine = (engine: EngineCatalogEntry) => {
    setSelectedEngineKey(bimResourceKey(engine.ref));
    setSelectedModeId(engine.modes[0]?.id || '');
  };

  const selectMode = (index: number) => {
    const mode = selectedEngine?.modes[index];
    if (!mode || !selectedEngine) return;
    setSelectedEngineKey(bimResourceKey(selectedEngine.ref));
    setSelectedModeId(mode.id);
    modeTabRefs.current[index]?.focus();
  };

  const moveModeTab = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    const modes = selectedEngine?.modes || [];
    if (!modes.length || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? modes.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + modes.length) % modes.length;
    selectMode(nextIndex);
  };

  const changeDeployment = async (
    registration: EngineRegistrationRevision,
    action: (ref: EngineRegistrationRevision) => Promise<EngineRegistrationRevision>,
    notice: string,
  ) => {
    const key = bimResourceKey(registration);
    setBusyDeployment(key);
    setDeploymentError(null);
    setDeploymentNotice(null);
    try {
      const updated = await action(registration);
      setDeployments((current) => current.map((item) => bimResourceKey(item) === key ? updated : item));
      setDeploymentNotice(notice);
      return true;
    } catch (reason: unknown) {
      setDeploymentError(deploymentErrorMessage(reason));
      return false;
    } finally {
      setBusyDeployment('');
    }
  };

  const replaceCredential = async (registration: EngineRegistrationRevision) => {
    if (!credentialValue) {
      setDeploymentError('A non-empty bearer token or Basic username:password credential is required.');
      return;
    }
    const changed = await changeDeployment(
      registration,
      (ref) => apiClient.setEngineRegistrationCredential(ref, credentialValue),
      `${registration.name} has a new encrypted credential and is private and inactive until it is verified again.`,
    );
    if (changed) {
      setCredentialEditor('');
      setCredentialValue('');
    }
  };

  return (
    <div className="engines-page page-shell">
      <header className="page-intro engines-intro">
        <div>
          <span className="kicker">Execution ecosystem</span>
          <h1 className="page-title">Engines publish exactly what they can solve.</h1>
        </div>
        <div>
          <p className="page-lede">
            BIM Engine revisions are portable, immutable declarations. Each mode targets one Profile and IR,
            selects supported feature values, sets ceilings and states guarantees independently of its algorithm name.
          </p>
          <div className="engine-intro-actions"><Link to="/engines/new" viewTransition>Register an Engine <ArrowRight aria-hidden="true" /></Link><Link to="/playground" viewTransition>Analyze a package</Link></div>
        </div>
      </header>

      <section className="federation-section" aria-labelledby="federation-title">
        <header className="engine-section-header">
          <div><span className="section-label">Multi-vendor catalogue &amp; federation</span><h2 id="federation-title">Portable capability. Private deployment. Verified result.</h2></div>
          <p>Different publishers can contribute Engine revisions and different operators can register deployments. The gateway keeps identity, compatibility and evaluation at one trust boundary.</p>
        </header>
        <div className="federation-route">
          <article>
            <Fingerprint aria-hidden="true" />
            <span>01 · Portable resource</span><h3>Engine</h3>
            <p>Immutable modes, algorithms, Profile/IR support, selectors, option schema, limits and guarantees.</p>
            <code>namespace/name@version#digest</code>
          </article>
          <ArrowRight aria-hidden="true" />
          <article>
            <CloudCog aria-hidden="true" />
            <span>02 · Private deployment resource</span><h3>EngineRegistration</h3>
            <p>Pins one exact Engine, HTTPS endpoint, protocol digest, paths and auth scheme. Credentials stay in the secret store.</p>
            <code>Engine ref + bim-engine/v1</code>
          </article>
          <ArrowRight aria-hidden="true" />
          <article>
            <Server aria-hidden="true" />
            <span>03 · Local or remote execution</span><h3>Compiled IR only</h3>
            <p>The selected deployment receives the Profile-declared BindingProblem. It never fetches source resources or Dialect schemas.</p>
            <code>no source package crosses</code>
          </article>
          <ArrowRight aria-hidden="true" />
          <article className="federation-verify">
            <ShieldCheck aria-hidden="true" />
            <span>04 · Gateway authority</span><h3>Reevaluation</h3>
            <p>Every decision is recomputed against the canonical problem before termination and provenance are exposed.</p>
            <code>OPTIMAL · FEASIBLE · INFEASIBLE · UNKNOWN</code>
          </article>
        </div>
        <p className="federation-note"><Check aria-hidden="true" /> Federation changes where a compatible mode runs. It does not weaken immutable pins, expose source packages, or make a remote engine authoritative.</p>
      </section>

      {user && <section className="deployment-section" aria-labelledby="deployment-title">
        <header className="engine-section-header deployment-heading">
          <div><span className="section-label">Federated execution</span><h2 id="deployment-title">My deployments</h2></div>
          <div className="deployment-heading-copy">
            <p>You control private activation independently from publication. A deployment reaches administrators only after you submit it for review.</p>
            <Link to="/engines/new" viewTransition>Register deployment <ArrowRight aria-hidden="true" /></Link>
          </div>
        </header>

        {deploymentError && <Alert type="error" title="Deployment change unavailable">{deploymentError} <button type="button" className="inline-retry" onClick={() => void loadDeployments()}>Retry</button></Alert>}
        {deploymentNotice && <Alert type="success">{deploymentNotice}</Alert>}
        {deploymentsLoading ? <div className="loading-state">Reading your EngineRegistration revisions…</div> : deploymentError && deployments.length === 0 ? null : deployments.length === 0 ? (
          <div className="deployment-empty">
            <CloudCog aria-hidden="true" />
            <div><h3>No deployments in {username} yet.</h3><p>Register an engine endpoint to keep it private while the gateway verifies it. Production requires HTTPS.</p></div>
            <Link to="/engines/new" viewTransition>Register deployment <ArrowRight aria-hidden="true" /></Link>
          </div>
        ) : <ul className="deployment-list" aria-label="My federated deployments">
          {deployments.map((registration) => {
            const state = deploymentStates[registration.status];
            const busy = busyDeployment === bimResourceKey(registration);
            return <li key={bimResourceKey(registration)} data-state={registration.status}>
              <div className="deployment-identity">
                <div>
                  <Badge variant={state.badge}>{state.label}</Badge>
                  <Badge variant={registration.active ? 'success' : 'default'}>{registration.active ? 'active for you' : 'inactive for you'}</Badge>
                  <span>{state.hint}</span>
                </div>
                <h3>{registration.name}</h3>
                <p><code>{registration.namespace}/{registration.name}</code> · <code>{registration.version}</code></p>
              </div>
              <code className="deployment-digest" title={registration.digest}>{shortDigest(registration.digest)}</code>
              <div className="deployment-actions">
                {!registration.active && <Button size="sm" disabled={busy} aria-label={`Activate ${registration.name}`} onClick={() => void changeDeployment(registration, (ref) => apiClient.activateEngineRegistration(ref), `${registration.name} is verified and active for your account.`)}>Activate</Button>}
                {registration.active && <Button size="sm" variant="secondary" disabled={busy} aria-label={`Deactivate ${registration.name}`} onClick={() => {
                  if (window.confirm(`Deactivate ${registration.name} for your account? Its publication state will not change.`)) {
                    void changeDeployment(registration, (ref) => apiClient.deactivateEngineRegistration(ref), `${registration.name} is inactive for your account.`);
                  }
                }}>Deactivate</Button>}
                {registration.active && (registration.status === 'private' || registration.status === 'rejected') && <Button size="sm" variant="ghost" disabled={busy} aria-label={`Request publication for ${registration.name}`} onClick={() => {
                  if (window.confirm(`Submit ${registration.name} for publication? Administrators will then be able to discover and review this exact revision.`)) {
                    void changeDeployment(registration, (ref) => apiClient.requestEngineRegistrationPublication(ref), `${registration.name} was submitted for publication review.`);
                  }
                }}>Request publication</Button>}
                {registration.status !== 'published' && <Button size="sm" variant="ghost" disabled={busy} aria-label={`Replace credential for ${registration.name}`} onClick={() => {
                  const key = bimResourceKey(registration);
                  setCredentialEditor((current) => current === key ? '' : key);
                  setCredentialValue('');
                }}>Credential</Button>}
              </div>
              {credentialEditor === bimResourceKey(registration) && <form className="credential-editor" onSubmit={(event) => {
                event.preventDefault();
                void replaceCredential(registration);
              }}>
                <label htmlFor={`credential-${registration.digest}`}>
                  <span>New deployment credential</span>
                  <input
                    id={`credential-${registration.digest}`}
                    type="password"
                    autoComplete="off"
                    value={credentialValue}
                    onChange={(event) => setCredentialValue(event.target.value)}
                    placeholder="Bearer token or username:password"
                  />
                </label>
                <p>Use the token alone for bearer auth or <code>username:password</code> for Basic. Replacing it makes the deployment private and inactive, so activation and publication review must be repeated.</p>
                <div>
                  <Button type="submit" size="sm" disabled={busy}>Store encrypted credential</Button>
                  <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => {
                    setCredentialEditor('');
                    setCredentialValue('');
                  }}>Cancel</Button>
                </div>
              </form>}
            </li>;
          })}
        </ul>}
      </section>}

      <section className="engine-catalogue" aria-labelledby="engine-catalogue-title">
        <header className="engine-section-header catalogue-heading">
          <div><span className="section-label">Runtime catalogue</span><h2 id="engine-catalogue-title">Inspect compatibility mode by mode.</h2></div>
          <label className="engine-search"><Search aria-hidden="true" /><span className="sr-only">Search engine revisions</span><input type="search" name="engine-search" autoComplete="off" spellCheck={false} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search engine, mode or algorithm…" /></label>
        </header>

        {loading ? <div className="loading-state">Reading immutable Engine revisions…</div> : error ? (
          <Alert type="error" title="Runtime catalogue unavailable">{error} <button type="button" className="inline-retry" onClick={loadEngines}>Retry</button></Alert>
        ) : engines.length === 0 ? (
          <Alert type="info" title="No Engine revisions advertised">The host returned an empty <code>/v1/engines</code> catalogue.</Alert>
        ) : (
          <div className="engine-workbench">
            <div className="engine-roster" aria-label="Engine revisions">
              <div className="engine-roster-heading"><span>{filtered.length} revision{filtered.length === 1 ? '' : 's'}</span><small>Select to inspect</small></div>
              {filtered.map((engine) => {
                const key = bimResourceKey(engine.ref);
                return <button key={key} type="button" className={selectedEngine?.ref && bimResourceKey(selectedEngine.ref) === key ? 'is-active' : ''} onClick={() => selectEngine(engine)}>
                  <span>{engine.namespace}</span>
                  <strong>{engine.name}</strong>
                  <small>v{engine.version} · {engine.modes.length} mode{engine.modes.length === 1 ? '' : 's'}</small>
                  <code title={engine.digest}>{shortDigest(engine.digest)}</code>
                </button>;
              })}
              {filtered.length === 0 && <p className="engine-roster-empty">No revision matches “{query}”.</p>}
            </div>

            {selectedEngine && selectedMode && <div className="engine-detail">
              <header className="engine-detail-header">
                <div><span className="micro-label">{selectedEngine.namespace}</span><h2>{selectedEngine.name}</h2><p>Immutable revision <code>{selectedEngine.version}</code> · <code title={selectedEngine.digest}>{shortDigest(selectedEngine.digest)}</code></p></div>
                <Link to="/playground" viewTransition>Test with a package <ArrowRight aria-hidden="true" /></Link>
              </header>

              <div className="mode-tabs" role="tablist" aria-label="Engine modes">
                {selectedEngine.modes.map((mode, index) => <button
                  key={modeKey(selectedEngine, mode)}
                  ref={(node) => { modeTabRefs.current[index] = node; }}
                  id={`${modeTabsId}-tab-${index}`}
                  type="button"
                  role="tab"
                  aria-selected={selectedMode.id === mode.id}
                  aria-controls={`${modeTabsId}-panel`}
                  tabIndex={selectedMode.id === mode.id ? 0 : -1}
                  className={selectedMode.id === mode.id ? 'is-active' : ''}
                  onClick={() => selectMode(index)}
                  onKeyDown={(event) => moveModeTab(event, index)}
                ><span>{mode.guarantees.exact ? 'Exact' : 'Heuristic'}</span><strong>{mode.id}</strong><small>{mode.algorithm}</small></button>)}
              </div>

              <div
                id={`${modeTabsId}-panel`}
                className="mode-contract"
                role="tabpanel"
                aria-labelledby={`${modeTabsId}-tab-${selectedModeIndex}`}
                key={selectedMode.id}
              >
                <div className="mode-identity">
                  <article><span className="micro-label">Profile</span><strong>{selectedMode.profile}</strong><small>must match exactly</small></article>
                  <article><span className="micro-label">Output IR</span><strong>{selectedMode.ir.apiVersion} · {selectedMode.ir.kind}</strong><small>must match exactly</small></article>
                  <article><span className="micro-label">Algorithm</span><strong>{selectedMode.algorithm}</strong><small>does not imply a guarantee</small></article>
                  <article className={selectedMode.guarantees.exact ? 'is-exact' : ''}><span className="micro-label">Truthful guarantee</span><strong>{selectedMode.guarantees.exact ? 'Exact mode' : 'Heuristic mode'}</strong><small>{selectedMode.guarantees.termination.join(' · ')}</small></article>
                </div>

                <div className="mode-detail-grid">
                  <section className="capability-matrix">
                    <header><GitCompareArrows aria-hidden="true" /><div><span className="micro-label">Feature selectors</span><h3>Actual IR features must fit every row</h3></div></header>
                    <div>{capabilityEntries.map(([name, selector]) => <article key={name} className={name === 'irExtensions' ? 'is-extension' : ''}><code>{name}</code><span className={`selector selector-${selector.selector}`}>{selector.selector}</span><p title={selectorTitle(selector)}>{selectorTitle(selector)}</p></article>)}</div>
                    <footer><strong><code>none</code></strong> rejects the dimension. <strong><code>only</code></strong> names exact values. <strong><code>all</code></strong> is valid only when the Profile closes the vocabulary.</footer>
                  </section>

                  <aside className="mode-limits">
                    <section>
                      <span className="micro-label">Declared ceilings</span>
                      <h3>Limits</h3>
                      <dl>{Object.entries(selectedMode.limits).map(([name, value]) => <div key={name}><dt><code>{name}</code></dt><dd>{value.toLocaleString()}</dd></div>)}</dl>
                    </section>
                    <section>
                      <span className="micro-label">Closed caller options</span>
                      <h3>Options</h3>
                      {Object.keys(selectedMode.optionsSchema.properties).length ? <ul>{Object.keys(selectedMode.optionsSchema.properties).map((name) => <li key={name}><code>{name}</code>{selectedMode.optionsSchema.required?.includes(name) && <span>required</span>}</li>)}</ul> : <p>No caller options.</p>}
                    </section>
                  </aside>
                </div>
              </div>
            </div>}
          </div>
        )}
      </section>

      <section className="engine-next">
        <span className="section-label">Compatibility in practice</span>
        <h2>Analysis compiles the package first, then returns exact Engine + Registration + mode triples.</h2>
        <Link to="/examples" viewTransition>Choose a package to analyze <ArrowRight aria-hidden="true" /></Link>
      </section>
    </div>
  );
}
