import { useEffect, useState } from 'react';
import { libraryApi, type Artifact, type ArtifactVersion } from '../../api/library';

export function ArtifactVersionPicker({ org, kind, artifactId, versionId, onSelect }: {
  org: string; kind?: string; artifactId?: string; versionId?: string; onSelect: (artifact: Artifact, version: ArtifactVersion) => void;
}) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [identity, setIdentity] = useState(artifactId || '');
  const [loaded, setLoaded] = useState<{ identity: string; items: ArtifactVersion[] }>({ identity: '', items: [] });
  const [selected, setSelected] = useState(versionId || '');
  const [error, setError] = useState('');
  // What the parent asks for resets the choices made here. It is adjusted while rendering, not from an effect.
  const askedArtifact = `${org}|${kind ?? ''}|${artifactId ?? ''}`;
  const [seenArtifact, setSeenArtifact] = useState(askedArtifact);
  if (seenArtifact !== askedArtifact) { setSeenArtifact(askedArtifact); setIdentity(artifactId || ''); setError(''); }
  const askedVersion = `${identity}|${versionId ?? ''}`;
  const [seenVersion, setSeenVersion] = useState(askedVersion);
  if (seenVersion !== askedVersion) { setSeenVersion(askedVersion); setSelected(versionId || ''); }
  // Versions read for another artifact are not this artifact's versions.
  const versions = loaded.identity === identity ? loaded.items : [];
  useEffect(() => {
    let active = true;
    libraryApi.list(org, true).then(items => { if (active) setArtifacts(items.filter(item => (!kind || item.kind === kind) && (!artifactId || item.id === artifactId))); }).catch(err => { if (active) setError(String(err)); });
    return () => { active = false; };
  }, [org, kind, artifactId]);
  useEffect(() => {
    let active = true;
    if (identity) libraryApi.versions(identity).then(items => { if (active) setLoaded({ identity, items: items.filter(item => !item.withdrawn) }); }).catch(err => { if (active) setError(String(err)); });
    return () => { active = false; };
  }, [identity]);
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
