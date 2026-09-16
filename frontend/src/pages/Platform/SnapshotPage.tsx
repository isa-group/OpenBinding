import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { platformApi, type Snapshot } from '../../api/platform';
import { ZipViewer } from '../../components/Inspection/ZipViewer';
import { Archive, ShieldCheck, Download, Code, ArrowLeft } from 'lucide-react';
import '../../components/Inspection/VisualEffects.css';

export function SnapshotPage() {
  const { org = '', project = '', snapshotId = '' } = useParams<{ org: string; project: string; snapshotId: string }>();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [archiveBlob, setArchiveBlob] = useState<Blob | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function load() {
      if (!snapshotId) return;
      setLoading(true);
      setError(null);
      try {
        const snap = await platformApi.snapshot(snapshotId);
        if (!active) return;
        setSnapshot(snap);

        // Fetch archive
        try {
          const buffer = await platformApi.snapshotArchive(snapshotId);
          if (active) setArchiveBlob(new Blob([buffer]));
        } catch (archiveErr) {
          console.warn('Failed to fetch snapshot archive bytes', archiveErr);
        }
      } catch (err: unknown) {
        if (active) setError(err instanceof Error ? err.message : 'Failed to load snapshot.');
      } finally {
        if (active) setLoading(false);
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, [snapshotId]);

  const downloadArchive = () => {
    if (!archiveBlob || !snapshot) return;
    const url = URL.createObjectURL(archiveBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `snapshot-${snapshot.id}.bim.zip`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ padding: '2rem', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <Link
            to={`/app/${org}/${project}/cases`}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', color: '#38bdf8', textDecoration: 'none', fontSize: '0.85rem', marginBottom: '0.5rem' }}
          >
            <ArrowLeft size={14} /> Back to Binding Cases
          </Link>
          <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <Archive size={24} color="#f59e0b" />
            Source Snapshot Inspection
          </h2>
          <small style={{ color: 'var(--text-muted, #94a3b8)' }}>
            Cryptographically sealed source archive and compiled Intermediate Representation
          </small>
        </div>

        {archiveBlob && (
          <button
            type="button"
            onClick={downloadArchive}
            className="hash-badge"
            style={{ cursor: 'pointer', padding: '8px 16px', background: '#0284c7', color: '#fff', border: 'none' }}
          >
            <Download size={14} />
            Download .bim.zip Archive
          </button>
        )}
      </div>

      {loading && (
        <div className="glass-panel" style={{ padding: '3rem', textAlign: 'center', color: '#94a3b8' }}>
          Loading snapshot integrity seals…
        </div>
      )}

      {error && (
        <div className="glass-panel glow-failed" style={{ padding: '1.5rem', color: '#f87171' }}>
          {error}
        </div>
      )}

      {snapshot && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          {/* Integrity Ribbon */}
          <div className="glass-panel" style={{ padding: '1.25rem', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '1rem' }}>
            <div>
              <div style={{ fontSize: '0.72rem', color: '#94a3b8', textTransform: 'uppercase' }}>
                <ShieldCheck size={12} style={{ display: 'inline', marginRight: 4 }} /> INSTANCE DIGEST
              </div>
              <div className="hash-badge" style={{ marginTop: '4px', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {snapshot.instanceDigest}
              </div>
            </div>

            <div>
              <div style={{ fontSize: '0.72rem', color: '#94a3b8', textTransform: 'uppercase' }}>
                PACKAGE DIGEST
              </div>
              <div className="hash-badge" style={{ marginTop: '4px', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {snapshot.packageDigest}
              </div>
            </div>

            <div>
              <div style={{ fontSize: '0.72rem', color: '#94a3b8', textTransform: 'uppercase' }}>
                ARCHIVE SIZE
              </div>
              <div style={{ fontWeight: 600, fontSize: '0.9rem', marginTop: '4px' }}>
                {(snapshot.archiveSize / 1024).toFixed(1)} KB (.bim.zip)
              </div>
            </div>

            <div>
              <div style={{ fontSize: '0.72rem', color: '#94a3b8', textTransform: 'uppercase' }}>
                CREATED AT
              </div>
              <div style={{ fontWeight: 600, fontSize: '0.85rem', marginTop: '4px' }}>
                {snapshot.createdAt ? new Date(snapshot.createdAt).toLocaleString() : 'Sealed'}
              </div>
            </div>
          </div>

          {/* 2-Column Explorer: Left = Decompressed ZIP, Right = Persisted IR */}
          <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 0.9fr', gap: '1.5rem' }}>
            {/* Left: Decompressed ZIP Explorer */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <h3 style={{ margin: 0, fontSize: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Archive size={16} color="#38bdf8" />
                Decompressed Archive Explorer (.bim.zip)
              </h3>
              {archiveBlob ? (
                <ZipViewer
                  blob={archiveBlob}
                  filename={`snapshot-${snapshot.id.slice(0, 8)}.bim.zip`}
                />
              ) : (
                <div className="glass-panel" style={{ padding: '2rem', textAlign: 'center', color: '#94a3b8' }}>
                  No binary archive attached to this snapshot.
                </div>
              )}
            </div>

            {/* Right: Compiled Intermediate Representation */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ margin: 0, fontSize: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <Code size={16} color="#10b981" />
                  Persisted Intermediate Representation (IR)
                </h3>
                {snapshot.ir && (
                  <span className="hash-badge" style={{ fontSize: '0.7rem' }}>
                    v{snapshot.ir.compilerVersion}
                  </span>
                )}
              </div>

              {snapshot.ir ? (
                <div className="glass-panel" style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  <div style={{ fontSize: '0.75rem', color: '#94a3b8' }}>
                    IR Digest: <span className="hash-badge">{snapshot.ir.digest}</span>
                  </div>
                  <pre className="terminal-viewer" style={{ maxHeight: '465px', overflowY: 'auto' }}>
                    <code>{JSON.stringify(snapshot.ir.document, null, 2)}</code>
                  </pre>
                </div>
              ) : (
                <div className="glass-panel" style={{ padding: '2rem', textAlign: 'center', color: '#94a3b8' }}>
                  No compiled IR snapshot found.
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
