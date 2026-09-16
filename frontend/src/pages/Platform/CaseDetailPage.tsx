import { ArtifactVersionPicker } from '../../components/Artifacts/ArtifactVersionPicker';
import type { ArtifactUse } from '../../api/library';
import { useState, useEffect, useCallback } from 'react';
import { useParams, Link, useNavigate, useSearchParams } from 'react-router-dom';
import { platformApi, type BindingCase, type CaseRevision } from '../../api/platform';
import { CodeEditor } from '../../components/CodeEditor/CodeEditor';
import {
  ArrowLeft,
  History,
  Edit3,
  Trash2,
  Plus,
  Archive,
  Lock,
  Layers,
  Cpu,
  Info,
} from 'lucide-react';
import { DigestBadge } from '../../components/Inspection/DigestBadge';
import '../../components/Inspection/VisualEffects.css';
import './CaseDetailPage.css';

export function CaseDetailPage() {
  const { org = '', project: projectSlug = '', caseSlug = '' } = useParams<{ org: string; project: string; caseSlug: string }>();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const revisionId = params.get("revision");

  const [bindingCase, setBindingCase] = useState<BindingCase | null>(null);
  const [revisions, setRevisions] = useState<CaseRevision[]>([]);
  const selectedRevision = (revisionId ? revisions.find(item => item.id === revisionId) : revisions[0]) || null;
  const [activeTab, setActiveTab] = useState<'spec' | 'json'>('spec');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Edit metadata modal state
  const [showEditModal, setShowEditModal] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [savingMeta, setSavingMeta] = useState(false);

  // New revision modal state
  const [showNewRevModal, setShowNewRevModal] = useState(false);
  const [newRevDoc, setNewRevDoc] = useState('');
  const [resourceUses, setResourceUses] = useState<ArtifactUse[]>([]);
  const [resourceRole, setResourceRole] = useState('application');
  const [resourceAlias, setResourceAlias] = useState('app');
  const [savingRev, setSavingRev] = useState(false);
  const [revError, setRevError] = useState<string | null>(null);

  // Delete modal state
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const loadCaseData = useCallback(async () => {
    if (!org || !projectSlug || !caseSlug) return;
    setLoading(true);
    setError(null);
    try {
      const [caseData, revsData] = await Promise.all([
        platformApi.case(org, projectSlug, caseSlug),
        platformApi.caseRevisions(org, projectSlug, caseSlug),
      ]);
      setBindingCase(caseData);
      setEditName(caseData.name);
      setEditDesc(caseData.description || '');

      const sorted = [...revsData].sort((a, b) => b.revision - a.revision);
      setRevisions(sorted);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load case details.');
    } finally {
      setLoading(false);
    }
  }, [org, projectSlug, caseSlug]);

  useEffect(() => {
    void loadCaseData();
  }, [loadCaseData]);

  const handleSaveMeta = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bindingCase) return;
    setSavingMeta(true);
    try {
      const updated = await platformApi.updateCase(org, projectSlug, bindingCase.slug, {
        name: editName,
        description: editDesc,
      });
      setBindingCase(updated);
      setShowEditModal(false);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Failed to update case.');
    } finally {
      setSavingMeta(false);
    }
  };

  const handleCreateRevision = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bindingCase) return;
    setSavingRev(true);
    setRevError(null);
    try {
      const parsed = JSON.parse(newRevDoc) as Record<string, unknown>;
      const created = await platformApi.createCaseRevision(
        org,
        projectSlug,
        bindingCase.slug,
        parsed,
        undefined,
        resourceUses
      );
      setShowNewRevModal(false);
      await loadCaseData();
      setParams({ revision: created.id });
    } catch (err: unknown) {
      setRevError(err instanceof Error ? err.message : 'Invalid JSON document or server rejected revision.');
    } finally {
      setSavingRev(false);
    }
  };

  const handleDeleteCase = async () => {
    if (!bindingCase) return;
    setDeleting(true);
    try {
      await platformApi.deleteCase(org, projectSlug, bindingCase.slug);
      navigate(`/app/${org}/${projectSlug}/cases`);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Failed to delete case.');
    } finally {
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <div className="platform-page case-detail-page">
        <div className="glass-panel">
          <span className="telemetry-pulse glow-running" />
          Loading case specification and revision ledger…
        </div>
      </div>
    );
  }

  if (error || !bindingCase) {
    return (
      <div className="platform-page case-detail-page">
        <Link
          to={`/app/${org}/${projectSlug}/cases`}
          className="case-detail-breadcrumb"
        >
          <ArrowLeft size={14} /> Back to Binding Cases
        </Link>
        <div className="glass-panel glow-failed">
          {error || 'Binding case not found.'}
        </div>
      </div>
    );
  }

  const spec = (selectedRevision?.document?.spec as Record<string, unknown> | undefined) || {};
  const metadata = (selectedRevision?.document?.metadata as Record<string, unknown> | undefined) || {};
  const resources = (spec.resources as Record<string, unknown> | undefined) || {};
  const tasks = (selectedRevision?.document?.tasks as Record<string, unknown> | undefined) || {};

  return (
    <div className="platform-page case-detail-page">
      {/* Top Header & Breadcrumbs */}
      <div>
        <Link
          to={`/app/${org}/${projectSlug}/cases`}
          className="case-detail-breadcrumb"
        >
          <ArrowLeft size={14} /> Back to Binding Cases
        </Link>

        <div className="case-detail-header">
          <div className="case-title-group">
            <div className="case-title-row">
              <h1>{bindingCase.name}</h1>
              <span className="hash-badge">
                {bindingCase.slug}
              </span>
              <span className="hash-badge">
                <Lock size={12} color="var(--color-success)" />
                {revisions.length} {revisions.length === 1 ? 'Revision' : 'Revisions'}
              </span>
            </div>
            <p className="case-description">
              {bindingCase.description || 'No description provided.'}
            </p>
          </div>

          <div className="case-detail-actions">
            <button
              type="button"
              onClick={() => setShowEditModal(true)}
              className="case-action-btn"
            >
              <Edit3 size={13} /> Edit Case
            </button>
            <button
              type="button"
              onClick={() => { setNewRevDoc(JSON.stringify(selectedRevision?.document || {}, null, 2)); setResourceUses([]); setShowNewRevModal(true); }}
              className="case-action-btn is-primary"
            >
              <Plus size={13} /> New Revision (r{revisions.length + 1})
            </button>
            <Link
              to={`/app/${org}/${projectSlug}/workbench?case=${encodeURIComponent(caseSlug)}&revision=${selectedRevision?.id || ""}`}
              className="case-action-btn"
            >
              <Cpu size={13} /> Open in Workbench
            </Link>
            <button
              type="button"
              onClick={() => setShowDeleteConfirm(true)}
              className="case-action-btn is-danger"
            >
              <Trash2 size={13} /> Delete
            </button>
          </div>
        </div>
      </div>

      {/* Main Grid: Revisions Timeline & Revision Deep Inspector */}
      <div className="case-detail-grid">
        {/* Left Column: Revision Timeline */}
        <div className="case-timeline-panel">
          <h3 className="case-panel-title">
            <History size={15} color="var(--color-accent)" />
            Revision Timeline
          </h3>

          <div className="case-timeline-list">
            {revisions.map((rev) => {
              const isSelected = selectedRevision?.id === rev.id;
              return (
                <div
                  key={rev.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setParams({ revision: rev.id })}
                  onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setParams({ revision: rev.id }); } }}
                  className={`case-timeline-item ${isSelected ? 'is-active' : ''}`}
                >
                  <div className="case-timeline-head">
                    <span className="case-timeline-rev">
                      Revision r{rev.revision}
                    </span>
                    <span className="case-timeline-date">
                      {new Date(rev.created_at).toLocaleDateString()}
                    </span>
                  </div>
                  <code className="case-timeline-digest">
                    {rev.digest.slice(0, 24)}…
                  </code>
                  {rev.source_snapshot_id && (
                    <span className="hash-badge">
                      <Archive size={11} /> Snapshot linked
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Right Column: Selected Revision Deep Inspector */}
        <div className="case-inspector-panel">
          {selectedRevision ? (
            <>
              {/* Revision Header Ribbon */}
              <div className="case-inspector-ribbon">
                <div>
                  <div className="case-ribbon-title">
                    <h2>
                      Revision r{selectedRevision.revision} Document
                    </h2>
                    <span className="hash-badge">
                      IMMUTABLE SEAL
                    </span>
                  </div>
                  <div>
                    <DigestBadge
                      digest={selectedRevision.digest}
                      kind="case"
                      document={selectedRevision.document}
                      size="sm"
                    />
                  </div>
                </div>

                {selectedRevision.source_snapshot_id && (
                  <Link
                    to={`/app/${org}/${projectSlug}/snapshots/${selectedRevision.source_snapshot_id}`}
                    className="case-action-btn"
                    title="Inspect and decompress source snapshot"
                  >
                    <Archive size={13} />
                    Inspect Snapshot (.bim.zip)
                  </Link>
                )}
              </div>

              {/* Inspector Tabs */}
              <div className="drawer-tabs">
                <button
                  type="button"
                  className={`drawer-tab ${activeTab === 'spec' ? 'is-active' : ''}`}
                  onClick={() => setActiveTab('spec')}
                >
                  <Layers size={14} /> Specification Breakdown
                </button>
                <button
                  type="button"
                  className={`drawer-tab ${activeTab === 'json' ? 'is-active' : ''}`}
                  onClick={() => setActiveTab('json')}
                >
                  <Info size={14} /> Source Document (JSON)
                </button>
              </div>

              {activeTab === 'spec' ? (
                <div>
                  <div className="case-spec-kpis">
                    <div className="case-kpi-card">
                      <span className="case-kpi-label">API Version</span>
                      <div className="case-kpi-value">
                        {String(selectedRevision.document?.apiVersion || 'bim/v1')}
                      </div>
                    </div>
                    <div className="case-kpi-card">
                      <span className="case-kpi-label">Kind</span>
                      <div className="case-kpi-value">
                        {String(selectedRevision.document?.kind || 'Instance')}
                      </div>
                    </div>
                    <div className="case-kpi-card">
                      <span className="case-kpi-label">Target Profile</span>
                      <div className="case-kpi-value">
                        {String(spec.profile || metadata.profile || 'qos-binding/v1')}
                      </div>
                    </div>
                  </div>

                  <div className="case-section-box">
                    <h4>Declared Resources</h4>
                    {Object.keys(resources).length > 0 ? (
                      <div className="case-pill-list">
                        {Object.entries(resources).map(([resKey, resVal]) => (
                          <span key={resKey} className="hash-badge">
                            {resKey}: {typeof resVal === 'object' && resVal !== null ? (resVal as { kind?: string }).kind || 'resource' : String(resVal)}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <p>No local inline resources declared.</p>
                    )}
                  </div>

                  <div className="case-section-box">
                    <h4>Tasks & Placement Topology</h4>
                    {Object.keys(tasks).length > 0 ? (
                      <div className="case-pill-list">
                        {Object.keys(tasks).map((t) => (
                          <span key={t} className="hash-badge">
                            Task: {t}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <p>Standard declarative workflow graph.</p>
                    )}
                  </div>
                </div>
              ) : (
                <div>
                  <CodeEditor
                    value={JSON.stringify(selectedRevision.document, null, 2)}
                    onChange={() => {}}
                    readOnly={true}
                    language="json"
                    minHeight="350px"
                    maxHeight="600px"
                    ariaLabel="Revision JSON document"
                  />
                </div>
              )}
            </>
          ) : (
            <div>
              Select a revision from the timeline to inspect its sealed document.
            </div>
          )}
        </div>
      </div>

      {/* Edit Case Modal */}
      {showEditModal && (
        <div className="entity-drawer-overlay" onClick={() => setShowEditModal(false)}>
          <div className="case-modal-card" onClick={(e) => e.stopPropagation()}>
            <h3>Edit Case Metadata</h3>
            <form onSubmit={handleSaveMeta} className="case-modal-form">
              <label>
                Name
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  required
                />
              </label>
              <label>
                Description
                <textarea
                  rows={4}
                  value={editDesc}
                  onChange={(e) => setEditDesc(e.target.value)}
                />
              </label>
              <div className="case-modal-actions">
                <button type="button" onClick={() => setShowEditModal(false)} className="case-action-btn">
                  Cancel
                </button>
                <button type="submit" disabled={savingMeta} className="case-action-btn is-primary">
                  {savingMeta ? 'Saving…' : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* New Revision Modal */}
      {showNewRevModal && (
        <div className="entity-drawer-overlay" onClick={() => setShowNewRevModal(false)}>
          <div className="case-modal-card" onClick={(e) => e.stopPropagation()}>
            <h3>Create Immutable Revision r{revisions.length + 1}</h3>
            <p>
              Revisions are content-addressed and cryptographically sealed. Submitting valid JSON creates revision r{revisions.length + 1}.
            </p>

            {revError && (
              <div className="glass-panel glow-failed">
                {revError}
              </div>
            )}

            <form onSubmit={handleCreateRevision} className="case-modal-form">
              <p>Select every resource consumed by this revision. Sealing validates the composition and creates its executable snapshot.</p>
              <label>Resource role<input value={resourceRole} onChange={event => setResourceRole(event.target.value)} /></label>
              <label>Local alias<input value={resourceAlias} onChange={event => setResourceAlias(event.target.value)} /></label>
              <ArtifactVersionPicker org={org} onSelect={(_artifact, version) => {
                if (!resourceRole.trim() || !resourceAlias.trim()) return;
                setResourceUses(current => [...current.filter(item => item.alias !== resourceAlias.trim()), {
                  role: resourceRole.trim(), alias: resourceAlias.trim(), artifact: version.ref, bindings: {},
                }]);
              }} />
              {resourceUses.map(use => <div key={use.alias}>
                <code>{use.role}/{use.alias}: {use.artifact.name}@{use.artifact.version}</code>
                <button type="button" onClick={() => setResourceUses(current => current.filter(item => item.alias !== use.alias))}>Remove {use.alias}</button>
              </div>)}

              <label>
                Case Document JSON
                <div>
                  <CodeEditor
                    value={newRevDoc}
                    onChange={(val) => setNewRevDoc(val)}
                    language="json"
                    minHeight="250px"
                    maxHeight="400px"
                    ariaLabel="New revision JSON"
                  />
                </div>
              </label>

              <div className="case-modal-actions">
                <button type="button" onClick={() => setShowNewRevModal(false)} className="case-action-btn">
                  Cancel
                </button>
                <button type="submit" disabled={savingRev} className="case-action-btn is-primary">
                  {savingRev ? 'Sealing Revision…' : `Seal Revision r${revisions.length + 1}`}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && (
        <div className="entity-drawer-overlay" onClick={() => setShowDeleteConfirm(false)}>
          <div className="case-modal-card glow-failed" onClick={(e) => e.stopPropagation()}>
            <h3>Permanently Delete Case?</h3>
            <p>
              Are you sure you want to permanently delete <strong>{bindingCase.name}</strong> ({bindingCase.slug}) and all {revisions.length} cryptographic revisions? This action cannot be undone.
            </p>
            <div className="case-modal-actions">
              <button type="button" onClick={() => setShowDeleteConfirm(false)} className="case-action-btn">
                Cancel
              </button>
              <button type="button" onClick={handleDeleteCase} disabled={deleting} className="case-action-btn is-danger">
                {deleting ? 'Deleting…' : 'Delete Permanently'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
