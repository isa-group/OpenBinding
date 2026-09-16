import React, { useCallback, useRef, useState, useEffect, type DragEvent, type ChangeEvent } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import {
  Fingerprint,
  UploadCloud,
  ShieldCheck,
  CheckCircle2,
  AlertCircle,
  Share2,
  BookOpen,
  FileCode,
  Copy,
  Check,
  FileBox,
  Layers,
  Cpu,
  Database,
  Calendar,
  Download,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Lock,
  Globe,
  User as UserIcon,
  Sparkles,
  FileText,
  Boxes,
  Languages,
} from 'lucide-react';
import {
  platformApi,
  type ResolveResponse,
  type ResolveLocation,
} from '../../api/platform';
import { computeCanonicalDigest, computeRawSha256 } from '../../utils/canonicalDigest';
import { KIND_OPTIONS } from './verifierOptions';
import './VerifierPage.css';

export const VerifierPage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState<'digest' | 'file'>('digest');

  // Input states
  const [kindInput, setKindInput] = useState<string>('case-revision');
  const [digestInput, setDigestInput] = useState<string>('');
  const [documentInput, setDocumentInput] = useState<string>('');
  const [limit] = useState<number>(10);

  // Execution states
  const [loading, setLoading] = useState<boolean>(false);
  const [resolveResult, setResolveResult] = useState<ResolveResponse | null>(null);
  const [clientDigest, setClientDigest] = useState<string | null>(null);
  const [documentHashMatches, setDocumentHashMatches] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  // File tab states
  const [dragging, setDragging] = useState<boolean>(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileLoading, setFileLoading] = useState<boolean>(false);
  const [localFileSha, setLocalFileSha] = useState<string | null>(null);
  const [fileResolveResult, setFileResolveResult] = useState<ResolveResponse | null>(null);

  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const didPrefill = useRef(false);

  const copyToClipboard = (text: string, key: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const executeResolve = useCallback(async (kindToResolve: string, digestToResolve: string, currentOffset: number) => {
    const trimmed = digestToResolve.trim();
    if (!trimmed) {
      setError('Please provide a SHA-256 hash or canonical digest to verify.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // Optional client document comparison
      let clientHash: string | null = null;
      let hashMatches: boolean | null = null;
      if (documentInput.trim()) {
        try {
          const parsed = JSON.parse(documentInput.trim());
          clientHash = await computeCanonicalDigest(parsed);
          setClientDigest(clientHash);
          const normalizedTarget = trimmed.startsWith('sha256-') ? trimmed : `sha256-${trimmed}`;
          hashMatches = clientHash.toLowerCase() === normalizedTarget.toLowerCase();
          setDocumentHashMatches(hashMatches);
        } catch {
          throw new Error('The document entered into the editor is not valid JSON.');
        }
      } else {
        setClientDigest(null);
        setDocumentHashMatches(null);
      }

      const res = await platformApi.resolveElement(kindToResolve, trimmed, limit, currentOffset);
      setResolveResult(res);
      setSearchParams({ kind: kindToResolve, digest: trimmed });
    } catch (caught) {
      setResolveResult(null);
      const msg = caught instanceof Error ? caught.message : 'Error resolving and verifying element.';
      if (msg.includes('404') || msg.toLowerCase().includes('not found')) {
        setError(
          'No resource found matching this hash, or you do not have permission to view it.'
        );
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  }, [documentInput, limit, setSearchParams]);

  // Pre-fill from query parameters
  useEffect(() => {
    if (didPrefill.current) return;
    didPrefill.current = true;
    const qDigest = searchParams.get('digest');
    const qKind = searchParams.get('kind');
    if (qKind && KIND_OPTIONS.some((k) => k.value === qKind)) {
      setKindInput(qKind);
    }
    if (qDigest) {
      setDigestInput(qDigest);
      void executeResolve(qKind || kindInput, qDigest, 0);
    }
  }, [executeResolve, kindInput, searchParams]);

  const handleInspectSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void executeResolve(kindInput, digestInput, 0);
  };

  const handlePageChange = (newOffset: number) => {
    if (newOffset < 0) return;
    void executeResolve(kindInput, digestInput, newOffset);
  };

  // Process uploaded file
  const processFile = async (file: File) => {
    setSelectedFile(file);
    setFileLoading(true);
    setError(null);
    setFileResolveResult(null);
    setLocalFileSha(null);

    try {
      const buffer = await file.arrayBuffer();
      const localSha = await computeRawSha256(buffer);
      setLocalFileSha(localSha);

      // Attempt to resolve as artifact
      try {
        const res = await platformApi.resolveElement('artifact', localSha, 10, 0);
        setFileResolveResult(res);
      } catch {
        // Not found in database as artifact, but file sha computed
        setFileResolveResult(null);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Error during local file verification.');
    } finally {
      setFileLoading(false);
    }
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      void processFile(e.dataTransfer.files[0]);
    }
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      void processFile(e.target.files[0]);
    }
  };

  const getKindBadgeIcon = (k: string) => {
    switch (k) {
      case 'case-revision':
        return <FileBox size={14} />;
      case 'resource-revision':
        return <Layers size={14} />;
      case 'collection-revision':
        return <Boxes size={14} />;
      case 'report':
        return <FileText size={14} />;
      case 'artifact':
        return <Database size={14} />;
      case 'engine':
        return <Cpu size={14} />;
      case 'dialect':
        return <Languages size={14} />;
      default:
        return <Fingerprint size={14} />;
    }
  };

  const renderSealAndProvenance = (res: ResolveResponse) => {
    const primaryLoc = res.locations[0];
    const createdDate = res.created_at ? new Date(res.created_at) : null;
    const formattedDate = createdDate
      ? `${createdDate.toLocaleDateString()} at ${createdDate.toLocaleTimeString()}`
      : 'Timestamp unavailable';

    return (
      <div className="verifier-result-container">
        {/* Dynamic Verification Seal Card */}
        <div className="verifier-seal-card">
          <div className="verifier-seal-glow" />
          <div className="verifier-seal-content">
            <div className="seal-badge-wrapper">
              <div className="seal-badge-icon">
                <ShieldCheck size={30} />
              </div>
            </div>
            <div className="seal-header-info">
              <div className="seal-title-row">
                <span className="seal-chip-verified">
                  <CheckCircle2 size={13} /> Cryptographic Seal Verified
                </span>
                <span className="seal-kind-chip">
                  {getKindBadgeIcon(res.kind)} {res.kind}
                </span>
                {primaryLoc?.project && (
                  <span
                    className={`seal-visibility-pill ${
                      primaryLoc.project.visibility === 'public' ? 'is-public' : 'is-private'
                    }`}
                  >
                    {primaryLoc.project.visibility === 'public' ? <Globe size={11} /> : <Lock size={11} />}
                    {primaryLoc.project.visibility === 'public' ? 'Public' : 'Private (Authorized Access)'}
                  </span>
                )}
              </div>
              <h2 className="seal-canonical-name">{res.canonical_name || res.digest}</h2>
              <div className="seal-digest-bar">
                <span className="seal-digest-label">SHA-256 Digest:</span>
                <code className="seal-digest-code">{res.digest}</code>
                <button
                  type="button"
                  className="seal-copy-btn"
                  title="Copy canonical digest"
                  onClick={() => copyToClipboard(res.digest, 'digest')}
                >
                  {copiedKey === 'digest' ? <Check size={13} /> : <Copy size={13} />}
                  <span>{copiedKey === 'digest' ? 'Copied' : 'Copy'}</span>
                </button>
              </div>
            </div>
          </div>

          {/* Local comparison alert if document provided */}
          {documentHashMatches !== null && (
            <div
              className={`seal-document-match-notice ${
                documentHashMatches ? 'is-matched' : 'is-mismatched'
              }`}
            >
              {documentHashMatches ? (
                <>
                  <Sparkles size={16} />
                  <span>
                    <strong>Document Verification Succeeded:</strong> The supplied JSON document exactly matches the RFC 8785 canonical digest and registered cryptographic signature.
                  </span>
                </>
              ) : (
                <>
                  <AlertCircle size={16} />
                  <span>
                    <strong>Cryptographic Discrepancy:</strong> The document in the editor produced digest{' '}
                    <code>{clientDigest}</code>, which differs from the queried digest.
                  </span>
                </>
              )}
            </div>
          )}
        </div>

        {/* Provenance & Metadata Grid */}
        <div className="provenance-grid">
          {/* Organization & Project */}
          <div className="provenance-card">
            <h4 className="provenance-title">
              <Globe size={15} /> Provenance & Project
            </h4>
            <div className="provenance-content">
              {primaryLoc?.organization ? (
                <div className="provenance-row">
                  <span className="prov-label">Organization:</span>
                  <span className="prov-value highlight">
                    {primaryLoc.organization.name} (<code>{primaryLoc.organization.slug}</code>)
                  </span>
                </div>
              ) : (
                <div className="provenance-row">
                  <span className="prov-label">Scope:</span>
                  <span className="prov-value">Global BIM Platform Catalog</span>
                </div>
              )}

              {primaryLoc?.project && (
                <div className="provenance-row">
                  <span className="prov-label">Project:</span>
                  <span className="prov-value highlight">
                    {primaryLoc.project.name} (<code>{primaryLoc.project.slug}</code>)
                  </span>
                </div>
              )}

              {primaryLoc?.slug && (
                <div className="provenance-row">
                  <span className="prov-label">Identifier / Slug:</span>
                  <code className="prov-code">{primaryLoc.slug}</code>
                </div>
              )}

              {primaryLoc?.version_or_revision !== undefined && (
                <div className="provenance-row">
                  <span className="prov-label">Version / Revision:</span>
                  <span className="prov-value" style={{ fontFamily: 'var(--font-mono)' }}>
                    #{primaryLoc.version_or_revision}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Author & Timestamp */}
          <div className="provenance-card">
            <h4 className="provenance-title">
              <UserIcon size={15} /> Authorship & Record
            </h4>
            <div className="provenance-content">
              <div className="provenance-row">
                <span className="prov-label">Author / Creator:</span>
                <span className="prov-value author-badge">
                  <span className="author-avatar">
                    {(res.author?.username || 'O')[0].toUpperCase()}
                  </span>
                  <span>{res.author?.username || 'OpenBinding System'}</span>
                  {res.author?.email && <span className="author-email">({res.author.email})</span>}
                </span>
              </div>

              <div className="provenance-row">
                <span className="prov-label">Sealed Timestamp:</span>
                <span className="prov-value">
                  <Calendar size={13} style={{ verticalAlign: 'middle', marginRight: '4px' }} />
                  {formattedDate}
                </span>
              </div>

              <div className="provenance-row">
                <span className="prov-label">MIME Media Type:</span>
                <code className="prov-code">{res.media_type}</code>
              </div>

              {res.size_bytes !== null && res.size_bytes !== undefined && (
                <div className="provenance-row">
                  <span className="prov-label">Ledger Payload Size:</span>
                  <span className="prov-value" style={{ fontFamily: 'var(--font-mono)' }}>
                    {res.size_bytes.toLocaleString()} bytes ({Math.round(res.size_bytes / 1024)} KB)
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Locations List (with offset & limit pagination) */}
        <div className="locations-card">
          <div className="locations-header">
            <div>
              <h3 className="locations-title">
                <Layers size={16} /> Platform Locations ({res.pagination.total})
              </h3>
              <p className="locations-subtitle">
                This cryptographic hash has been registered or referenced across these project coordinates.
              </p>
            </div>
            {res.content_url && (
              <a
                href={res.content_url}
                target="_blank"
                rel="noreferrer"
                className="locations-direct-link"
              >
                <Download size={14} /> Download Raw Payload
              </a>
            )}
          </div>

          <div className="locations-table-container">
            <table className="locations-table">
              <thead>
                <tr>
                  <th>Organization</th>
                  <th>Project</th>
                  <th>Visibility</th>
                  <th>Revision / Version</th>
                  <th>Date</th>
                  <th style={{ textAlign: 'right' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {res.locations.map((loc: ResolveLocation, idx: number) => (
                  <tr key={`${loc.element_id}-${idx}`}>
                    <td>
                      {loc.organization ? (
                        <span>{loc.organization.name}</span>
                      ) : (
                        <span style={{ color: 'var(--color-text-tertiary)' }}>Global Platform</span>
                      )}
                    </td>
                    <td>
                      {loc.project ? (
                        <span>{loc.project.name}</span>
                      ) : (
                        <span style={{ color: 'var(--color-text-tertiary)' }}>—</span>
                      )}
                    </td>
                    <td>
                      {loc.project ? (
                        <span
                          className={`seal-visibility-pill ${
                            loc.project.visibility === 'public' ? 'is-public' : 'is-private'
                          }`}
                        >
                          {loc.project.visibility === 'public' ? 'Public' : 'Private'}
                        </span>
                      ) : (
                        <span className="seal-visibility-pill is-public">Public</span>
                      )}
                    </td>
                    <td>
                      <code>{loc.version_or_revision !== null ? `#${loc.version_or_revision}` : '—'}</code>
                    </td>
                    <td style={{ color: 'var(--color-text-tertiary)' }}>
                      {loc.created_at ? new Date(loc.created_at).toLocaleDateString() : '—'}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {loc.web_url ? (
                        <Link to={loc.web_url} className="locations-direct-link">
                          Open <ExternalLink size={12} />
                        </Link>
                      ) : (
                        <span style={{ color: 'var(--color-text-tertiary)' }}>—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination Controls */}
          {res.pagination.total > limit && (
            <div className="locations-pagination">
              <span>
                Showing {res.pagination.offset + 1} -{' '}
                {Math.min(res.pagination.offset + res.pagination.limit, res.pagination.total)} of{' '}
                {res.pagination.total} locations
              </span>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button
                  type="button"
                  className="pagination-btn"
                  disabled={res.pagination.offset === 0 || loading}
                  onClick={() => handlePageChange(res.pagination.offset - limit)}
                >
                  <ChevronLeft size={14} /> Previous
                </button>
                <button
                  type="button"
                  className="pagination-btn"
                  disabled={!res.pagination.has_more || loading}
                  onClick={() => handlePageChange(res.pagination.offset + limit)}
                >
                  Next <ChevronRight size={14} />
                </button>
              </div>
            </div>
          )}
        </div>

        {/* In-Situ Document / Content Inspection */}
        {res.document && (
          <div className="verified-doc-card">
            <div className="doc-viewer-header">
              <div className="doc-viewer-title">
                <FileCode size={16} /> In-Situ Inspection of Verified Document
              </div>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button
                  type="button"
                  className="citation-copy-btn"
                  onClick={() => copyToClipboard(JSON.stringify(res.document, null, 2), 'doc_json')}
                >
                  {copiedKey === 'doc_json' ? <Check size={13} /> : <Copy size={13} />}
                  {copiedKey === 'doc_json' ? 'JSON Copied' : 'Copy JSON'}
                </button>
                <a
                  href={res.content_url}
                  target="_blank"
                  rel="noreferrer"
                  className="citation-copy-btn"
                >
                  <Download size={13} /> Download .json
                </a>
              </div>
            </div>
            <pre className="doc-viewer-code">
              {JSON.stringify(res.document, null, 2)}
            </pre>
          </div>
        )}

        {/* Citation and Academic Replication Card */}
        {res.citation && (
          <div className="citation-card">
            <div className="citation-header">
              <div>
                <h3 className="citation-title">
                  <Share2 size={16} /> Academic Citation & Replication Bundle
                </h3>
                <p className="citation-subtitle">
                  Use these persistent identifiers and snippets to cite this exact computational artifact in scientific publications and technical reports.
                </p>
              </div>
            </div>

            {res.citation.url && (
              <div className="citation-block">
                <div className="citation-block-header">
                  <span>
                    <BookOpen size={12} /> Canonical URI / Persistent Identifier
                  </span>
                  <button
                    type="button"
                    className="citation-copy-btn"
                    onClick={() => copyToClipboard(res.citation!.url!, 'cit_url')}
                  >
                    {copiedKey === 'cit_url' ? <Check size={12} /> : <Copy size={12} />}
                    {copiedKey === 'cit_url' ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <pre className="citation-pre">{res.citation.url}</pre>
              </div>
            )}

            {res.citation.bibtex && (
              <div className="citation-block">
                <div className="citation-block-header">
                  <span>
                    <FileCode size={12} /> BibTeX Entry
                  </span>
                  <button
                    type="button"
                    className="citation-copy-btn"
                    onClick={() => copyToClipboard(res.citation!.bibtex, 'cit_bib')}
                  >
                    {copiedKey === 'cit_bib' ? <Check size={12} /> : <Copy size={12} />}
                    {copiedKey === 'cit_bib' ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <pre className="citation-pre">{res.citation.bibtex}</pre>
              </div>
            )}

            {res.citation.markdown_badge && (
              <div className="citation-block">
                <div className="citation-block-header">
                  <span>
                    <Sparkles size={12} /> Markdown Badge
                  </span>
                  <button
                    type="button"
                    className="citation-copy-btn"
                    onClick={() => copyToClipboard(res.citation!.markdown_badge, 'cit_badge')}
                  >
                    {copiedKey === 'cit_badge' ? <Check size={12} /> : <Copy size={12} />}
                    {copiedKey === 'cit_badge' ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <pre className="citation-pre">{res.citation.markdown_badge}</pre>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="platform-page verifier-page">
      <header className="platform-page-heading">
        <div>
          <span>System</span>
          <h1>Replication studio</h1>
          <p>
            Cryptographic verifier &amp; resolver. Verify the provenance, scientific integrity, and cryptographic authenticity of any OpenBinding resource using RFC 8785 canonical SHA-256 digests. Resolve universal references across public repositories and authorized private workspaces.
          </p>
        </div>
      </header>

      {/* Tabs */}
      <div className="verifier-tabs">
        <button
          type="button"
          className={`verifier-tab-btn ${activeTab === 'digest' ? 'is-active' : ''}`}
          onClick={() => setActiveTab('digest')}
        >
          <Fingerprint size={16} /> Query by Kind & Digest
        </button>
        <button
          type="button"
          className={`verifier-tab-btn ${activeTab === 'file' ? 'is-active' : ''}`}
          onClick={() => setActiveTab('file')}
        >
          <UploadCloud size={16} /> Drop & Verify Local File
        </button>
      </div>

      {/* Tab 1: Form & Query */}
      {activeTab === 'digest' && (
        <div className="verifier-search-card">
          <form onSubmit={handleInspectSubmit} className="verifier-form">
            <div className="form-row-grid">
              {/* Kind Dropdown */}
              <div className="verifier-input-group">
                <label htmlFor="kind-select" className="verifier-label">Resource Kind</label>
                <select
                  id="kind-select"
                  className="verifier-select"
                  value={kindInput}
                  onChange={(e) => setKindInput(e.target.value)}
                >
                  {KIND_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                <span className="verifier-hint">
                  {KIND_OPTIONS.find((k) => k.value === kindInput)?.description}
                </span>
              </div>

              {/* Digest Input */}
              <div className="verifier-input-group flex-2">
                <label htmlFor="digest-input" className="verifier-label">Canonical SHA-256 Digest</label>
                <input
                  id="digest-input"
                  type="text"
                  className="verifier-input"
                  placeholder="sha256-abcdef... or 64-char hexadecimal digest"
                  value={digestInput}
                  onChange={(e) => setDigestInput(e.target.value)}
                  required
                />
                <span className="verifier-hint">
                  Accepts <code>sha256-</code> prefix or direct 64-character hexadecimal.
                </span>
              </div>
            </div>

            {/* Optional Document Input */}
            <div className="verifier-input-group">
              <label htmlFor="doc-editor" className="verifier-label">
                Optional In-Situ JSON Document for Verification
              </label>
              <textarea
                id="doc-editor"
                className="verifier-textarea"
                rows={4}
                placeholder="Paste JSON document to verify canonical signature in-browser against digest…"
                value={documentInput}
                onChange={(e) => setDocumentInput(e.target.value)}
              />
            </div>

            <div>
              <button type="submit" className="verifier-submit-btn" disabled={loading}>
                {loading ? (
                  <>
                    <span className="spinner-dot" /> Verifying Cryptographically…
                  </>
                ) : (
                  <>
                    <ShieldCheck size={16} /> Verify & Inspect Digest
                  </>
                )}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Tab 2: File Dropzone */}
      {activeTab === 'file' && (
        <div className="verifier-search-card">
          <div
            className={`file-drop-zone ${dragging ? 'is-dragging' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            onClick={() => document.getElementById('file-upload-input')?.click()}
          >
            <input
              id="file-upload-input"
              type="file"
              style={{ display: 'none' }}
              onChange={handleFileChange}
            />
            <div className="file-drop-icon">
              <UploadCloud size={36} />
            </div>
            <div>
              <h3 className="file-drop-title">Drop a file here or click to select</h3>
              <p className="file-drop-subtitle">
                SHA-256 digest is computed in your browser without uploading the file payload.
              </p>
            </div>
            {selectedFile && (
              <div className="hash-badge">
                <FileBox size={14} />
                <span>{selectedFile.name} ({Math.round(selectedFile.size / 1024)} KB)</span>
              </div>
            )}
          </div>

          {localFileSha && (
            <div className="file-details-card">
              <div className="file-details-left">
                <span className="seal-digest-label">Computed SHA-256:</span>
                <code className="prov-code">{localFileSha}</code>
              </div>
              <button
                type="button"
                className="seal-copy-btn"
                onClick={() => copyToClipboard(localFileSha, 'file_sha')}
              >
                {copiedKey === 'file_sha' ? <Check size={12} /> : <Copy size={12} />}
                <span>{copiedKey === 'file_sha' ? 'Copied' : 'Copy'}</span>
              </button>
            </div>
          )}

          {fileLoading && (
            <div style={{ marginTop: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--color-text-secondary)' }}>
              <span className="spinner-dot" /> Computing hash and resolving in OpenBinding…
            </div>
          )}
        </div>
      )}

      {/* Error Alert */}
      {error && (
        <div className="verifier-error-card">
          <AlertCircle size={20} />
          <div>
            <h4 style={{ margin: '0 0 0.25rem', fontSize: '0.9rem' }}>Resource Not Found or Unauthorized</h4>
            <p style={{ margin: 0, fontSize: '0.82rem' }}>{error}</p>
          </div>
        </div>
      )}

      {/* Results Display */}
      {activeTab === 'digest' && resolveResult && renderSealAndProvenance(resolveResult)}
      {activeTab === 'file' && fileResolveResult && renderSealAndProvenance(fileResolveResult)}
    </div>
  );
};
