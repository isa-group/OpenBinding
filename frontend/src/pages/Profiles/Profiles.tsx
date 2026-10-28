import { useState } from 'react';
import { Archive } from 'lucide-react';
import { Link } from 'react-router-dom';
import { apiClient, bimResourceKey, HttpError, type BimDialect, type BimProfile, type RegisteredResource } from '../../api/client';
import { Button } from '../../components/ui/Button';
import { Chip } from '../../components/ui/Chip';
import { DataTable } from '../../components/ui/DataTable';
import { EmptyState } from '../../components/ui/EmptyState';
import { Notice } from '../../components/ui/Notice';
import { LanguageNav } from '../../components/ui/SectionNav';
import { Skeleton } from '../../components/ui/Skeleton';
import { useCopy } from '../../components/ui/useCopy';
import { useAuth } from '../../contexts/auth';
import { shortDigest } from '../../utils/digest';
import { useResource } from '../../utils/useResource';
import { schemaPath, schemaPathFor } from '../Schemas/schemaKinds';
import './Profiles.css';

/** `bpmn-workflow` at version 1.4.0 is addressed as `bpmn-workflow/v1`, the way Profiles name the Dialects they accept. */
function majorId(name: string, version: string): string {
  return `${name}/v${version.split('.')[0] || '1'}`;
}

function cardinality(minimum: number, maximum?: number): string {
  if (minimum === 1 && maximum === 1) return 'exactly 1';
  if (minimum === 0 && maximum === 1) return '0 or 1';
  if (minimum === 0 && maximum === undefined) return '0 or more';
  if (minimum === 1 && maximum === undefined) return '1 or more';
  return maximum === undefined ? `${minimum} or more` : `${minimum}–${maximum}`;
}

/** A kind name as a chip: a link to its field reference when the reference has that kind. */
function KindChip({ kind }: { kind: string }) {
  const to = schemaPathFor(kind);
  return to ? <Link className="profiles-kind" to={to}>{kind}</Link> : <span className="profiles-kind">{kind}</span>;
}

function fileExtension(mediaType: string): string {
  if (mediaType.includes('xml')) return '.xml';
  if (mediaType.includes('json')) return '.json';
  return '';
}

function ChainDiagram({ profile, dialects }: { profile: string; dialects: BimDialect[] }) {
  const extra = [...new Set(dialects.flatMap((dialect) => dialect.spec.resourceTypes.map((type) => type.kind)))]
    .filter((kind) => kind !== 'Application' && kind !== 'CandidateCatalog' && kind !== 'ConstraintSet' && kind !== 'Optimization');
  const steps = [
    { kind: 'Package', title: 'Instance', note: 'Selects one Profile', to: schemaPath('Instance') },
    { kind: 'Profile', title: profile, note: 'Roles and cardinalities', to: '/language' },
    { kind: 'Roles', title: 'Application, catalogs…', note: 'Filled by resources', to: schemaPath('Application') },
    { kind: 'Dialects', title: 'Resource types', note: extra.length ? extra.slice(0, 3).join(', ') : 'Installed on this host', to: schemaPath('Dialect') },
    { kind: 'IR', title: 'BindingProblem', note: 'One problem, one digest', to: schemaPath('BindingProblem') },
    { kind: 'Engine', title: 'Exact revision', note: 'Mode and options', to: '/engines' },
  ];
  return (
    <section className="profiles-chain" aria-label="How the pieces connect">
      <ol>
        {steps.map((step, index) => (
          <li key={step.kind}>
            <Link to={step.to}>
              <span>{step.kind}</span>
              <strong>{step.title}</strong>
              <small>{step.note}</small>
            </Link>
            {index < steps.length - 1 && <span className="profiles-arrow" aria-hidden="true">→</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}

function ProfileContract({ profile }: { profile: BimProfile }) {
  const roles = Object.entries(profile.spec.roles);
  const dimensions = Object.entries(profile.spec.capabilityVocabulary.dimensions);
  return (
    <article className="profiles-contract" aria-label={`Contract of ${profile.id}`}>
      <header>
        <h3 className="is-mono">{profile.id}</h3>
        <span>{profile.metadata.description}</span>
      </header>
      <div className="profiles-contract-grid">
        <section aria-label="Roles and cardinalities">
          <h4>Roles and cardinalities</h4>
          <ul>
            {roles.map(([id, role]) => (
              <li key={id}>
                <strong className="is-mono">{id}</strong>
                <span className="profiles-types">
                  {role.resourceTypes.map((type) => (
                    <span key={`${type.apiVersion}/${type.kind}`}><KindChip kind={type.kind} /> {cardinality(type.minimum, type.maximum)}</span>
                  ))}
                </span>
                {role.extensionTypes === 'installed' && <small>Installed dialects may add other resource types.</small>}
              </li>
            ))}
          </ul>
        </section>
        <section aria-label="Compilation output">
          <h4>Compilation output</h4>
          <dl>
            <dt>IR</dt><dd className="is-mono">{profile.spec.output.apiVersion} · {profile.spec.output.kind}</dd>
            <dt>Protocol</dt><dd className="is-mono">{profile.spec.output.engineProtocol}</dd>
            <dt>Semantics</dt><dd>{profile.spec.deterministic === false ? 'Non-deterministic' : 'Deterministic'}</dd>
            <dt>Adapter</dt><dd className="is-mono">{profile.spec.adapter.id}@{profile.spec.adapter.version}</dd>
          </dl>
        </section>
        <section aria-label="Vocabularies">
          <h4>Capability vocabulary</h4>
          <span className="profiles-vocab">
            {dimensions.map(([name, dimension]) => <Chip key={name} mono tone={dimension.openValues ? 'accent' : 'plain'}>{name} · {dimension.openValues ? 'open' : 'closed'}</Chip>)}
          </span>
          <h4>Limit vocabulary</h4>
          <span className="profiles-vocab">
            {profile.spec.limitVocabulary.map((limit) => <Chip key={limit} mono>{limit}</Chip>)}
          </span>
        </section>
      </div>
    </article>
  );
}

/** `embedded`: shown inside the language hub, which draws the section navigation itself. */
export function Profiles({ embedded = false }: { embedded?: boolean } = {}) {
  const { user } = useAuth();
  const { copy, status: copyStatus } = useCopy();
  const profiles = useResource('profiles', () => apiClient.getProfiles());
  const dialects = useResource('dialects', () => apiClient.getDialects());
  const resources = useResource('registered-resources', () => apiClient.getRegisteredResources());
  const [profileChoice, setProfileChoice] = useState('all');
  const [download, setDownload] = useState<{ key: string; error: unknown } | null>(null);

  const catalogStatus = profiles.status === 'error' || dialects.status === 'error'
    ? 'error'
    : profiles.status === 'loading' || dialects.status === 'loading' ? 'loading' : 'ready';
  const catalogFailure = profiles.error ?? dialects.error;
  const profileList = profiles.data ?? [];
  const profileId = profileList.some((item) => item.id === profileChoice) ? profileChoice : 'all';
  const shownProfiles = profileId === 'all' ? profileList : profileList.filter((item) => item.id === profileId);
  const shownDialects = (dialects.data ?? []).filter((item) => profileId === 'all' || item.spec.compatibleProfiles.includes(profileId));
  const headline = shownProfiles[0]?.id ?? profileList[0]?.id ?? 'qos-binding/v1';

  const retryCatalog = () => {
    profiles.reload();
    dialects.reload();
  };

  const downloadResource = async (resource: RegisteredResource) => {
    const key = bimResourceKey(resource);
    setDownload(null);
    try {
      const bytes = await apiClient.getRegisteredResourceContent(resource);
      const url = URL.createObjectURL(new Blob([bytes], { type: resource.mediaType }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${resource.name}-${resource.version}${fileExtension(resource.mediaType)}`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setDownload({ key, error });
    }
  };

  return (
    <div className="profiles-page">
      <div className="profiles-head">
        {!embedded && <LanguageNav current="profiles" />}
        <h1>The BIM language</h1>
        <p>
          An instance selects a Profile. The Profile says which roles must be filled and how many times; installed dialects add resource
          types and IR features. Everything compiles to one BindingProblem that engines solve.
        </p>
      </div>

      <ChainDiagram profile={headline} dialects={dialects.data ?? []} />

      <div className="profiles-controls">
        <label>
          Profile
          <select value={profileId} onChange={(event) => setProfileChoice(event.target.value)}>
            <option value="all">All profiles</option>
            {profileList.map((item) => <option key={item.id} value={item.id}>{item.id}</option>)}
          </select>
        </label>
        {user && <Link className="profiles-submit" to="/language/extensions">Submit a dialect or resource</Link>}
      </div>

      <div className="profiles-data" aria-live="polite" aria-busy={catalogStatus === 'loading'}>
        {catalogStatus === 'loading' && (
          <>
            <Skeleton variant="panel" />
            <Skeleton variant="panel" />
          </>
        )}
        {catalogStatus === 'error' && (
          <Notice tone="error" action={<Button size="sm" variant="secondary" onClick={retryCatalog}>Retry</Button>}>
            The language catalog couldn’t be loaded{catalogFailure instanceof HttpError ? ` (HTTP ${catalogFailure.status})` : ''}. The diagram above still works.
          </Notice>
        )}

        {catalogStatus === 'ready' && (
          <>
            <section aria-labelledby="profiles-title" className="profiles-section">
              <h2 id="profiles-title">Profiles</h2>
              <DataTable label="Installed profiles" minWidth={760}>
                <thead><tr><th scope="col">Profile</th><th scope="col">Roles</th><th scope="col">Capability vocabulary</th><th scope="col">Adapter</th></tr></thead>
                <tbody>
                  {shownProfiles.map((profile) => (
                    <tr key={profile.id}>
                      <td className="is-mono"><strong>{profile.id}</strong></td>
                      <td>
                        <span className="profiles-chips">
                          {Object.entries(profile.spec.roles).map(([id, role]) => {
                            const kind = role.resourceTypes.map((type) => schemaPathFor(type.kind) ? type.kind : null).find(Boolean);
                            return kind ? <Link key={id} className="profiles-role" to={schemaPath(kind)}>{id}</Link> : <span key={id} className="profiles-role">{id}</span>;
                          })}
                        </span>
                      </td>
                      <td>
                        <span className="profiles-chips">
                          {Object.keys(profile.spec.capabilityVocabulary.dimensions).map((name) => <Chip key={name} mono>{name}</Chip>)}
                        </span>
                      </td>
                      <td className="is-mono">{profile.spec.adapter.id}@{profile.spec.adapter.version}</td>
                    </tr>
                  ))}
                  {shownProfiles.length === 0 && <tr><td colSpan={4} className="profiles-none">No profile is installed on this host.</td></tr>}
                </tbody>
              </DataTable>
              <div className="profiles-contracts">
                {shownProfiles.map((profile) => <ProfileContract key={profile.id} profile={profile} />)}
              </div>
            </section>

            <section aria-labelledby="dialects-title" className="profiles-section">
              <h2 id="dialects-title">Dialects</h2>
              <DataTable label="Installed dialects" minWidth={760}>
                <thead>
                  <tr><th scope="col">Dialect</th><th scope="col">Resource types</th><th scope="col">IR features</th><th scope="col">Compatible with</th></tr>
                </thead>
                <tbody>
                  {shownDialects.map((dialect) => (
                    <tr key={`${dialect.metadata.namespace}/${dialect.metadata.name}@${dialect.metadata.version}`}>
                      <td>
                        <strong className="is-mono">{majorId(dialect.metadata.name, dialect.metadata.version)}</strong>
                        <small className="profiles-sub">{dialect.metadata.namespace} · adapter {dialect.spec.adapter.id}@{dialect.spec.adapter.version}</small>
                      </td>
                      <td>
                        <span className="profiles-chips">
                          {dialect.spec.resourceTypes.map((type) => <KindChip key={`${type.apiVersion}/${type.kind}`} kind={type.kind} />)}
                        </span>
                        <small className="profiles-sub">
                          {dialect.spec.resourceTypes.map((type) => `${type.kind} → ${type.roles.join(', ')} (${type.mediaType})`).join(' · ')}
                          {dialect.spec.extensionPoints.length > 0 ? ` · ${dialect.spec.extensionPoints.length} inline extension point${dialect.spec.extensionPoints.length === 1 ? '' : 's'}` : ''}
                        </small>
                      </td>
                      <td className="is-mono">
                        {dialect.spec.irFeatures.length
                          ? dialect.spec.irFeatures.map((feature) => <span key={`${feature.dimension}/${feature.value}`} className="profiles-feature">{feature.dimension}={feature.value}</span>)
                          : <span className="profiles-muted">None declared</span>}
                      </td>
                      <td className="is-mono">{dialect.spec.compatibleProfiles.join(', ')}</td>
                    </tr>
                  ))}
                  {shownDialects.length === 0 && <tr><td colSpan={4} className="profiles-none">No dialect is installed for {profileId === 'all' ? 'this host' : profileId}.</td></tr>}
                </tbody>
              </DataTable>
            </section>
          </>
        )}

        <section aria-labelledby="resources-title" className="profiles-section">
          <h2 id="resources-title">Registered resources</h2>
          {resources.status === 'loading' && <Skeleton variant="tile" />}
          {resources.status === 'error' && (
            <Notice tone="error" action={<Button size="sm" variant="secondary" onClick={resources.reload}>Retry</Button>}>
              The registered resources couldn’t be loaded{resources.error instanceof HttpError ? ` (HTTP ${resources.error.status})` : ''}.
            </Notice>
          )}
          {download && (
            <Notice tone="error" title={download.error instanceof HttpError && download.error.status === 404 ? 'Resource not found (404).' : 'The resource couldn’t be downloaded.'}>
              {download.error instanceof HttpError && download.error.status === 404
                ? 'A registered resource is fetched by all four fields: namespace, name, version and digest. One of them doesn’t match a published resource.'
                : download.error instanceof Error ? download.error.message : 'Try again in a moment.'}
            </Notice>
          )}
          {resources.status === 'ready' && resources.data && resources.data.length === 0 && (
            <EmptyState
              icon={<Archive />}
              title="No published registered resources yet"
              action={<Link to={schemaPath('Application')}>Read the authoring reference</Link>}
            >
              Registered resources are immutable, reviewed building blocks anyone can reference. Until some are published, author resources directly in your packages.
            </EmptyState>
          )}
          {resources.data && resources.data.length > 0 && (
            <DataTable label="Published resources" minWidth={820}>
              <thead>
                <tr><th scope="col">Reference</th><th scope="col">Kind · role</th><th scope="col">Dialect</th><th scope="col">Status</th><th scope="col">Actions</th></tr>
              </thead>
              <tbody>
                {resources.data.map((resource) => {
                  const key = bimResourceKey(resource);
                  const reference = `${resource.namespace}/${resource.name}@${resource.version}`;
                  return (
                    <tr key={key}>
                      <td>
                        <span className="is-mono">{reference}</span>
                        <small className="profiles-sub is-mono" title={resource.digest}>{shortDigest(resource.digest)}</small>
                      </td>
                      <td>{resource.kind} · {resource.role}</td>
                      <td className="is-mono">{resource.dialect || '—'}</td>
                      <td><Chip tone="success">Published</Chip></td>
                      <td>
                        <span className="profiles-actions">
                          <button type="button" onClick={() => void copy(key, key)} aria-label={`Copy reference of ${reference}`}>
                            {copyStatus(key) === 'copied' ? 'Copied' : 'Copy reference'}
                          </button>
                          <button type="button" onClick={() => void downloadResource(resource)} aria-label={`Download ${reference}`}>Download</button>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </DataTable>
          )}
        </section>
      </div>
    </div>
  );
}
