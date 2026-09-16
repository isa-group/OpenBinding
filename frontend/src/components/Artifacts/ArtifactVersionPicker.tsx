import { useEffect, useState } from 'react';
import { libraryApi, type Artifact, type ArtifactVersion } from '../../api/library';

export function ArtifactVersionPicker({ org, kind, artifactId, versionId, onSelect }: {
  org: string; kind?: string; artifactId?: string; versionId?: string; onSelect: (artifact: Artifact, version: ArtifactVersion) => void;
}) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [identity, setIdentity] = useState(artifactId || '');
  const [versions, setVersions] = useState<ArtifactVersion[]>([]);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setIdentity(artifactId || ''); setError('');
    libraryApi.list(org, true).then(items => { if (active) setArtifacts(items.filter(item => (!kind || item.kind === kind) && (!artifactId || item.id === artifactId))); }).catch(err => { if (active) setError(String(err)); });
    return () => { active = false; };
  }, [org, kind, artifactId]);
  useEffect(() => {
    let active = true;
    setVersions([]); setSelected(versionId || '');
    if (identity) libraryApi.versions(identity).then(items => { if (active) setVersions(items.filter(item => !item.withdrawn)); }).catch(err => { if (active) setError(String(err)); });
    return () => { active = false; };
  }, [identity, versionId]);
  return <fieldset><legend>Select a sealed artifact version</legend>
    {error && <p role="alert">{error}</p>}
    <label>Artifact<select value={identity} onChange={event => setIdentity(event.target.value)}><option value="">Choose an artifact</option>{artifacts.map(item => <option key={item.id} value={item.id}>{item.display_name} · {item.kind}</option>)}</select></label>
    <label>Version<select value={selected} disabled={!identity} onChange={event => {
      setSelected(event.target.value);
      const artifact = artifacts.find(item => item.id === identity);
      const version = versions.find(item => item.id === event.target.value);
      if (artifact && version) onSelect(artifact, version);
    }}><option value="">Choose an exact version</option>{versions.map(item => <option key={item.id} value={item.id}>{item.ref.version} · {item.public ? 'public' : 'organization'} · {item.contentDigest.slice(0, 19)}</option>)}</select></label>
  </fieldset>;
}
