import React, { useState } from 'react';
import {
  ShieldCheck,
  Copy,
  Check,
  X,
  Fingerprint,
  Share2,
  FileCode,
  BookOpen,
  Info,
} from 'lucide-react';
import { platformApi, type VerifierStatus, type VerifierVerdict } from '../../api/platform';
import { computeCanonicalDigest } from '../../utils/canonicalDigest';
import './DigestBadge.css';

export interface DigestBadgeProps {
  digest: string;
  kind?: string;
  label?: string;
  document?: unknown;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

/** What the verifier's answer means for the person reading it. Only `verified` says the fingerprint is on record. */
const VERDICT_TITLES: Record<VerifierStatus, string> = {
  verified: 'Authoritative Integrity Verified',
  computed: 'Computed, not on record',
  mismatch: 'Digest does not match',
  not_found: 'Nothing found',
};

export const DigestBadge: React.FC<DigestBadgeProps> = ({
  digest,
  kind,
  label,
  document,
  size = 'md',
  className = '',
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [verification, setVerification] = useState<VerifierVerdict | null>(null);
  const [failed, setFailed] = useState(false);
  const [clientDigest, setClientDigest] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const truncatedHash = digest.length > 20
    ? `${digest.slice(0, 14)}…${digest.slice(-6)}`
    : digest;

  const handleOpen = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsOpen(true);
    setLoading(true);
    setFailed(false);
    setVerification(null);

    try {
      // 1. Client-side canonical computation if document is available
      if (document) {
        try {
          const clientComputed = await computeCanonicalDigest(document);
          setClientDigest(clientComputed);
        } catch {
          // ignore client computation failure
        }
      }

      // 2. Server-side authoritative verification
      setVerification(await platformApi.verifierCheck({ digest, kind, document }));
    } catch {
      // A check that did not happen verifies nothing: say so, never "verified".
      setFailed(true);
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = (text: string, key: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const match = verification?.entities?.[0];
  const citation = verification?.status === 'verified' ? verification.citation : null;

  return (
    <>
      <button
        type="button"
        className={`digest-badge-btn size-${size} is-verified ${className}`}
        onClick={handleOpen}
        title={`Digest: ${digest} (Click to check it with the verifier)`}
      >
        <ShieldCheck size={size === 'sm' ? 12 : size === 'lg' ? 16 : 14} className="digest-badge-icon" />
        {label && <span className="digest-badge-label">{label}:</span>}
        <span className="digest-badge-hash">{truncatedHash}</span>
      </button>

      {isOpen && (
        <div
          className="digest-modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setIsOpen(false);
          }}
        >
          <div className="digest-modal-container" role="dialog" aria-modal="true">
            <header className="digest-modal-header">
              <h3>
                <Fingerprint className="digest-modal-title-icon" />
                Cryptographic Provenance & Replication
              </h3>
              <button
                type="button"
                className="digest-modal-close"
                onClick={() => setIsOpen(false)}
                aria-label="Close modal"
              >
                <X size={18} />
              </button>
            </header>

            <div className="digest-modal-body">
              {/* Status Banner */}
              <div className={`digest-status-banner ${verification?.status === 'verified' ? 'is-valid' : 'is-warning'}`} role="status">
                <ShieldCheck size={20} style={{ flexShrink: 0 }} />
                <div>
                  <strong>
                    {loading
                      ? 'Verifying…'
                      : verification
                        ? VERDICT_TITLES[verification.status]
                        : 'Could not verify'}
                  </strong>
                  <div style={{ fontSize: '0.8rem', opacity: 0.9, marginTop: '2px' }}>
                    {failed
                      ? 'The verifier did not answer, so nothing was checked. This says nothing about the digest. Try again in a moment.'
                      : verification?.detail}
                  </div>
                </div>
              </div>

              {/* Canonical Digest */}
              <div className="digest-field">
                <label>Canonical Digest (RFC 8785 SHA-256)</label>
                <div className="digest-value-box">
                  <code>{digest}</code>
                  <button
                    type="button"
                    className="digest-copy-btn"
                    onClick={() => copyToClipboard(digest, 'digest')}
                  >
                    {copiedKey === 'digest' ? <Check size={12} /> : <Copy size={12} />}
                    {copiedKey === 'digest' ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>

              {/* Client Validation if available */}
              {clientDigest && (
                <div className="digest-field">
                  <label>Client-side In-Browser Verification</label>
                  <div className="digest-value-box">
                    <code>{clientDigest}</code>
                    <span style={{ fontSize: '0.75rem', color: clientDigest === digest ? '#86efac' : '#f87171' }}>
                      {clientDigest === digest ? '✓ Matches' : '≠ Mismatch'}
                    </span>
                  </div>
                </div>
              )}

              {/* Entity Info if matched */}
              {match && (
                <div className="digest-field">
                  <label>Registered Platform Entity</label>
                  <div style={{ fontSize: '0.85rem', color: 'var(--color-text-secondary, #d4d4d8)' }}>
                    Kind: <strong>{match.entity_type}</strong> · Identity: <code>{match.id}</code>
                    {match.title_or_name && <span> · Name: <strong>{match.title_or_name}</strong></span>}
                  </div>
                </div>
              )}

              {/* Replication Citations */}
              {citation && (
                <div className="digest-citation-tabs">
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem', fontWeight: 600 }}>
                    <Share2 size={14} /> Open Science & Research Citations
                  </label>

                  {/* DOI & URI */}
                  <div className="digest-citation-card">
                    <div className="digest-citation-header">
                      <span><BookOpen size={12} style={{ verticalAlign: 'middle', marginRight: '4px' }} /> Persistent DOI Reference</span>
                      <button
                        type="button"
                        className="digest-copy-btn"
                        onClick={() => copyToClipboard(citation.uri || '', 'uri')}
                      >
                        {copiedKey === 'uri' ? <Check size={12} /> : <Copy size={12} />}
                        {copiedKey === 'uri' ? 'Copied' : 'Copy URL'}
                      </button>
                    </div>
                    <pre className="digest-citation-pre">{citation.uri}</pre>
                  </div>

                  {/* BibTeX */}
                  <div className="digest-citation-card">
                    <div className="digest-citation-header">
                      <span><FileCode size={12} style={{ verticalAlign: 'middle', marginRight: '4px' }} /> BibTeX Entry</span>
                      <button
                        type="button"
                        className="digest-copy-btn"
                        onClick={() => copyToClipboard(citation.bibtex || '', 'bibtex')}
                      >
                        {copiedKey === 'bibtex' ? <Check size={12} /> : <Copy size={12} />}
                        {copiedKey === 'bibtex' ? 'Copied' : 'Copy BibTeX'}
                      </button>
                    </div>
                    <pre className="digest-citation-pre">{citation.bibtex}</pre>
                  </div>

                  {/* Markdown Badge */}
                  <div className="digest-citation-card">
                    <div className="digest-citation-header">
                      <span><Info size={12} style={{ verticalAlign: 'middle', marginRight: '4px' }} /> Markdown Badge (for GitHub README)</span>
                      <button
                        type="button"
                        className="digest-copy-btn"
                        onClick={() => copyToClipboard(citation.markdown_badge, 'badge')}
                      >
                        {copiedKey === 'badge' ? <Check size={12} /> : <Copy size={12} />}
                        {copiedKey === 'badge' ? 'Copied' : 'Copy Markdown'}
                      </button>
                    </div>
                    <pre className="digest-citation-pre">{citation.markdown_badge}</pre>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
};
