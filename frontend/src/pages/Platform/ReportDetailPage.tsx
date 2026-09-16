import { useState, useEffect, useCallback } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { platformApi, type Report, type Publication } from '../../api/platform';
import { CodeEditor } from '../../components/CodeEditor/CodeEditor';
import {
  ArrowLeft,
  Lock,
  Globe2,
  Trash2,
  Edit3,
  Copy,
  FileText,
  ShieldCheck,
  Sparkles,
  ExternalLink,
  BookOpen,
} from 'lucide-react';
import { DigestBadge } from '../../components/Inspection/DigestBadge';
import { SavedDecision } from './AnalysisPage';
import '../../components/Inspection/VisualEffects.css';

export function ReportDetailPage() {
  const { org = '', project: projectSlug = '', reportSlug = '' } = useParams<{ org: string; project: string; reportSlug: string }>();
  const navigate = useNavigate();

  const [report, setReport] = useState<Report | null>(null);
  const [publication, setPublication] = useState<Publication | null>(null);
  const [activeTab, setActiveTab] = useState<'editorial' | 'provenance' | 'json' | 'edit'>('editorial');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Edit state (for draft reports)
  const [editTitle, setEditTitle] = useState('');
  const [editDocJson, setEditDocJson] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Publish modal state
  const [showPublishModal, setShowPublishModal] = useState(false);
  const [pubSlug, setPubSlug] = useState('');
  const [pubAuthors, setPubAuthors] = useState('');
  const [pubVenue, setPubVenue] = useState('');
  const [pubDoi, setPubDoi] = useState('');
  const [publishing, setPublishing] = useState(false);

  // Delete modal state
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const loadReportData = useCallback(async () => {
    if (!org || !projectSlug || !reportSlug) return;
    setLoading(true);
    setError(null);
    try {
      const [repData, pubsData] = await Promise.all([
        platformApi.report(org, projectSlug, reportSlug),
        platformApi.publications(org, projectSlug).catch(() => []),
      ]);
      setReport(repData);
      setEditTitle(repData.title);
      setEditDocJson(JSON.stringify(repData.document, null, 2));

      const matchingPub = pubsData.find((p) => repData.state === 'frozen' && p.report_id === repData.id && p.version_id === repData.version_id && !p.withdrawn);
      setPublication(matchingPub || null);
      if (matchingPub) {
        setPubSlug(matchingPub.slug);
      } else {
        setPubSlug(`${repData.slug}-paper`);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load report.');
    } finally {
      setLoading(false);
    }
  }, [org, projectSlug, reportSlug]);

  useEffect(() => {
    void loadReportData();
  }, [loadReportData]);

  const handleSaveDraft = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!report || report.state !== 'draft') return;
    setSaving(true);
    setSaveError(null);
    try {
      const parsedDoc = JSON.parse(editDocJson) as Record<string, unknown>;
      const updated = await platformApi.updateReport(org, projectSlug, report.slug, {
        title: editTitle,
        document: parsedDoc, draft_revision: report.draft_revision ?? undefined,
      });
      setReport(updated);
      setActiveTab('editorial');
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save draft.');
    } finally {
      setSaving(false);
    }
  };

  const handleFreezeReport = async () => {
    if (!report || report.state !== 'draft') return;
    if (!window.confirm('Freeze this report? Freezing permanently locks the document with a cryptographic hash. This cannot be undone.')) {
      return;
    }
    setSaving(true);
    try {
      const frozen = await platformApi.freezeReport(org, projectSlug, report.slug);
      setReport(frozen);
      await loadReportData();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Failed to freeze report.');
    } finally {
      setSaving(false);
    }
  };

  const handlePublish = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!report) return;
    setPublishing(true);
    try {
      const authorsList = pubAuthors.split(',').map((a) => a.trim()).filter(Boolean);
      const pub = await platformApi.publishReport(org, projectSlug, {
        report_id: report.id, version_id: report.version_id ?? undefined,
        slug: pubSlug.trim() || `${report.slug}-pub`,
        citation: {
          title: report.title,
          authors: authorsList.length > 0 ? authorsList : ['OpenBinding Contributor'],
          venue: pubVenue.trim() || 'OpenBinding Research Repository',
          doi: pubDoi.trim() || undefined,
          year: new Date().getFullYear(),
        },
      });
      setPublication(pub);
      setShowPublishModal(false);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Failed to publish report.');
    } finally {
      setPublishing(false);
    }
  };

  const handleDeletePublication = async () => {
    if (!publication) return;
    if (!window.confirm(`Withdraw publication while retaining its version and citation "${publication.slug}"?`)) return;
    try {
      await platformApi.deletePublication(org, projectSlug, publication.slug);
      setPublication(null);
      await loadReportData();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Failed to delete publication.');
    }
  };

  const handleDeleteReport = async () => {
    if (!report) return;
    setDeleting(true);
    try {
      await platformApi.deleteReport(org, projectSlug, report.slug);
      navigate(`/app/${org}/${projectSlug}/reports`);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Failed to delete report.');
    } finally {
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <div>
        <div className="glass-panel">
          <span className="telemetry-pulse glow-running" />
          Loading report and publication credentials…
        </div>
      </div>
    );
  }

  if (error || !report) {
    return (
      <div>
        <Link
          to={`/app/${org}/${projectSlug}/reports`}

        >
          <ArrowLeft size={14} /> Back to Reports
        </Link>
        <div className="glass-panel glow-failed">
          {error || 'Report not found.'}
        </div>
      </div>
    );
  }

  const doc = (report.document || {}) as Record<string, unknown>;
  const summary = (doc.summary as Record<string, unknown> | string | undefined) || '';
  const provenance = (doc.provenance as Record<string, unknown> | undefined) || {};
  const isDraft = report.state === 'draft';
  const isFrozen = report.state === 'frozen';

  return (
    <div>
      {/* Top Breadcrumb & Header */}
      <div>
        <Link
          to={`/app/${org}/${projectSlug}/reports`}

        >
          <ArrowLeft size={14} /> Back to Reports
        </Link>

        <div>
          <div>
            <div>
              <h1>{report.title}</h1>
              <Link to={`/app/${org}/library?artifact=${report.artifact_id}${report.version_id ? `&version=${report.version_id}` : ''}`}>Version history</Link>
              {isFrozen && <button type="button" disabled={saving} onClick={async () => {
                setSaving(true);
                try { await platformApi.createReportDraft(org, projectSlug, report.slug); await loadReportData(); setActiveTab('edit'); }
                catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not create a new report draft.'); }
                finally { setSaving(false); }
              }}>New version</button>}
              <span className={`hash-badge ${isFrozen ? 'glow-completed' : 'glow-running'}`}>
                {publication ? 'PUBLISHED' : report.state.toUpperCase()}
              </span>
              {isFrozen ? (
                <span className="hash-badge">
                  <ShieldCheck size={12} />
                  FROZEN SEAL
                </span>
              ) : (
                <span className="hash-badge">
                  <Sparkles size={12} />
                  EDITABLE DRAFT
                </span>
              )}
            </div>
            <div>
              <span>Slug: <code>{report.slug}</code></span>
              <span>•</span>
              <span>Created {new Date(report.created_at).toLocaleString()}</span>
              {report.digest && (
                <>
                  <span>•</span>
                  <DigestBadge
                    digest={report.digest}
                    kind="report"
                    document={report.document}
                    size="sm"
                  />
                </>
              )}
            </div>
          </div>

          <div>
            {isDraft && (
              <>
                <button
                  type="button"
                  onClick={() => setActiveTab('edit')}
                  className="hash-badge"

                >
                  <Edit3 size={13} /> Edit Draft
                </button>
                <button
                  type="button"
                  onClick={() => void handleFreezeReport()}
                  className="hash-badge"

                >
                  <Lock size={13} /> Freeze Report
                </button>
              </>
            )}

            {isFrozen && !publication && (
              <button
                type="button"
                onClick={() => setShowPublishModal(true)}
                className="hash-badge"

              >
                <Globe2 size={13} /> Publish to Explore
              </button>
            )}

            {publication && (
              <button
                type="button"
                onClick={() => void handleDeletePublication()}
                className="hash-badge"

                title="Unpublish report"
              >
                <Globe2 size={13} /> Unpublish
              </button>
            )}

            <button
              type="button"
              onClick={() => setShowDeleteConfirm(true)}
              className="hash-badge"

            >
              <Trash2 size={13} /> Delete
            </button>
          </div>
        </div>
      </div>

      {/* Publication Banner (if published) */}
      {publication && (
        <div className="glass-panel glow-completed">
          <div>
            <div>
              <div>
                <Globe2 size={18} color="var(--color-text-primary)" />
                <strong>
                  Public Scientific Publication · /{publication.slug}
                </strong>
                {Boolean(publication.citation?.doi) && (
                  <span className="hash-badge">
                    DOI: {String(publication.citation?.doi)}
                  </span>
                )}
              </div>
              <p>
                Authors: {Array.isArray(publication.citation?.authors) ? (publication.citation?.authors as string[]).join(', ') : 'OpenBinding Research Team'}
                {Boolean(publication.citation?.venue) && ` · Venue: ${String(publication.citation?.venue)}`}
              </p>
            </div>

            <Link
              to={`/explore`}
              className="hash-badge"

            >
              <ExternalLink size={13} />
              Open in Explore Directory
            </Link>
          </div>
        </div>
      )}

      {/* Navigation Tabs */}
      <div className="drawer-tabs">
        <button
          type="button"
          className={`drawer-tab ${activeTab === 'editorial' ? 'is-active' : ''}`}
          onClick={() => setActiveTab('editorial')}
        >
          <BookOpen size={14} /> Editorial Reading View
        </button>
        <button
          type="button"
          className={`drawer-tab ${activeTab === 'provenance' ? 'is-active' : ''}`}
          onClick={() => setActiveTab('provenance')}
        >
          <ShieldCheck size={14} /> Scientific Provenance
        </button>
        <button
          type="button"
          className={`drawer-tab ${activeTab === 'json' ? 'is-active' : ''}`}
          onClick={() => setActiveTab('json')}
        >
          <FileText size={14} /> Signed Document (JSON)
        </button>
        {isDraft && (
          <button
            type="button"
            className={`drawer-tab ${activeTab === 'edit' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('edit')}
          >
            <Edit3 size={14} /> Draft Editor
          </button>
        )}
      </div>

      {/* Tab 1: Editorial View */}
      {activeTab === 'editorial' && doc.kind === 'binding-decision' && Array.isArray(doc.selected) && (
        <div className="glass-panel">
          <h3>Recorded binding decision</h3>
          <p>This snapshot records the selected rule and evidence. Reopening verifies source access and identities before recalculating.</p>
          <Link className="hash-badge" to={`/app/analysis?report=${encodeURIComponent(`${org}/${projectSlug}/${report.slug}`)}`}>Reopen decision workspace</Link>
          <SavedDecision document={doc} />
        </div>
      )}
      {activeTab === 'editorial' && doc.kind !== 'binding-decision' && (
        <div>
          {/* Executive Summary Card */}
          <div className="glass-panel">
            <h3>
              Executive Summary & Benchmark Conclusion
            </h3>
            {typeof summary === 'object' && summary !== null ? (
              <div>
                {Boolean((summary as Record<string, unknown>).conclusion) && (
                  <p>
                    {String((summary as Record<string, unknown>).conclusion)}
                  </p>
                )}
                <div>
                  {Object.entries(summary as Record<string, unknown>).filter(([k]) => k !== 'conclusion').map(([k, v]) => (
                    <div key={k} className="glass-panel">
                      <small>
                        {k.replace(/_/g, ' ')}
                      </small>
                      <div>
                        {String(v)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p>
                {String(summary || 'No summary text registered in this report.')}
              </p>
            )}
          </div>

          {/* Sections breakdown if available */}
          {Array.isArray(doc.sections) && (
            <div>
              {(doc.sections as Array<{ heading?: string; content?: string }>).map((sec, idx) => (
                <div key={idx} className="glass-panel">
                  <h4>
                    {sec.heading || `Section ${idx + 1}`}
                  </h4>
                  <p>
                    {sec.content || ''}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Tab 2: Scientific Provenance */}
      {activeTab === 'provenance' && (
        <div className="glass-panel">
          <div>
            <h3>Scientific Provenance Ledger</h3>
            <p>
              Cryptographic hashes, software dependencies, and study execution fingerprints guaranteeing full empirical reproducibility.
            </p>
          </div>

          <div>
            <div className="glass-panel">
              <small>Associated Study Run</small>
              <div>
                {report.study_run_id ? (
                  <Link
                    to={`/app/${org}/${projectSlug}/analytics`}

                  >
                    Run ID: {report.study_run_id.slice(0, 18)}…
                  </Link>
                ) : (
                  <span>No study run pinned</span>
                )}
              </div>
            </div>

            <div className="glass-panel">
              <small>BIM Canonical Version</small>
              <div>
                {String(provenance.bimVersion || 'bim/v1')}
              </div>
            </div>
          </div>

          {Array.isArray(provenance.software) && (
            <div className="glass-panel">
              <h4>Declared Software Solvers</h4>
              <div>
                {(provenance.software as Array<{ name?: string; version?: string; digest?: string }>).map((s, i) => (
                  <span key={i} className="hash-badge">
                    {s.name} v{s.version} {s.digest && `(${s.digest.slice(0, 12)}…)`}
                  </span>
                ))}
              </div>
            </div>
          )}

          {Array.isArray(provenance.datasets) && (
            <div className="glass-panel">
              <h4>Dataset & Case References</h4>
              <div>
                {(provenance.datasets as Array<{ reference?: string; digest?: string }>).map((d, i) => (
                  <span key={i} className="hash-badge">
                    {d.reference} · {d.digest ? d.digest.slice(0, 16) + '…' : 'latest'}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Tab 3: JSON Document */}
      {activeTab === 'json' && (
        <div className="glass-panel">
          <div>
            <span>
              Cryptographically signed canonical report document
            </span>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(JSON.stringify(report.document, null, 2));
              }}
              className="hash-badge"

            >
              <Copy size={12} /> Copy JSON
            </button>
          </div>
          <div>
            <CodeEditor
              value={JSON.stringify(report.document, null, 2)}
              onChange={() => {}}
              readOnly={true}
              language="json"
              minHeight="400px"
              maxHeight="700px"
              ariaLabel="Report JSON Document"
            />
          </div>
        </div>
      )}

      {/* Tab 4: Draft Editor (only if draft) */}
      {activeTab === 'edit' && isDraft && (
        <div className="glass-panel">
          <h3>Edit Working Draft</h3>
          {saveError && (
            <div className="glass-panel glow-failed">
              {saveError}
            </div>
          )}
          <form onSubmit={handleSaveDraft}>
            <div>
              <label>Title</label>
              <input
                type="text"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                required

              />
            </div>

            <div>
              <label>
                Document Content (JSON)
              </label>
              <div>
                <CodeEditor
                  value={editDocJson}
                  onChange={(val) => setEditDocJson(val)}
                  language="json"
                  minHeight="300px"
                  maxHeight="500px"
                  ariaLabel="Edit report JSON"
                />
              </div>
            </div>

            <div>
              <button type="submit" disabled={saving} className="hash-badge">
                {saving ? 'Saving…' : 'Save Draft Changes'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Publish Modal */}
      {showPublishModal && (
        <div className="entity-drawer-overlay" onClick={() => setShowPublishModal(false)}>
          <div className="glass-panel" onClick={(e) => e.stopPropagation()}>
            <h3>Publish Frozen Report</h3>
            <p>
              Publishing adds this verified benchmark to the public Explore catalogue for community citation and peer review.
            </p>

            <form onSubmit={handlePublish}>
              <div>
                <label>Publication URL Slug</label>
                <input
                  type="text"
                  value={pubSlug}
                  onChange={(e) => setPubSlug(e.target.value)}
                  required

                />
              </div>

              <div>
                <label>Authors (comma-separated)</label>
                <input
                  type="text"
                  value={pubAuthors}
                  onChange={(e) => setPubAuthors(e.target.value)}
                  placeholder="e.g. Alice Researcher, Bob Engineer"

                />
              </div>

              <div>
                <label>Venue / Journal</label>
                <input
                  type="text"
                  value={pubVenue}
                  onChange={(e) => setPubVenue(e.target.value)}
                  placeholder="e.g. IEEE Transactions on Services Computing"

                />
              </div>

              <div>
                <label>DOI (Optional)</label>
                <input
                  type="text"
                  value={pubDoi}
                  onChange={(e) => setPubDoi(e.target.value)}
                  placeholder="10.1109/TSC.2026.000000"

                />
              </div>

              <div>
                <button type="button" onClick={() => setShowPublishModal(false)} className="hash-badge">
                  Cancel
                </button>
                <button type="submit" disabled={publishing} className="hash-badge">
                  {publishing ? 'Publishing…' : 'Publish Report'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && (
        <div className="entity-drawer-overlay" onClick={() => setShowDeleteConfirm(false)}>
          <div className="glass-panel glow-failed" onClick={(e) => e.stopPropagation()}>
            <h3>Permanently Delete Report?</h3>
            <p>
              Are you sure you want to delete report <strong>"{report.title}"</strong> ({report.slug})? Any associated publication will also be removed. This cannot be undone.
            </p>
            <div>
              <button type="button" onClick={() => setShowDeleteConfirm(false)} className="hash-badge">
                Cancel
              </button>
              <button type="button" onClick={handleDeleteReport} disabled={deleting} className="hash-badge">
                {deleting ? 'Deleting…' : 'Delete Permanently'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
