import React, { useState, useEffect, useCallback, type FormEvent } from 'react';
import { useParams, useOutletContext, Link } from 'react-router-dom';
import {
  Library,
  GitBranch,
  ArrowLeft,
  ExternalLink,
  Plus,
  Download,
  FileBox,
  Layers,
  FileText,
} from 'lucide-react';
import {
  platformApi,
  type Collection,
  type CollectionRevision,
  type CollectionItem,
} from '../../api/platform';
import type { PlatformOutletContext } from '../../components/PlatformShell/PlatformShell';
import { DigestBadge } from '../../components/Inspection/DigestBadge';
import './CollectionDetailPage.css';

export const CollectionDetailPage: React.FC = () => {
  const { collectionSlug } = useParams<{ collectionSlug: string }>();
  const { organization, project } = useOutletContext<PlatformOutletContext>();

  const [collection, setCollection] = useState<Collection | null>(null);
  const [revisions, setRevisions] = useState<CollectionRevision[]>([]);
  const [selectedRevision, setSelectedRevision] = useState<CollectionRevision | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addingRevision, setAddingRevision] = useState(false);
  const [newItemsJson, setNewItemsJson] = useState('');

  const load = useCallback(async () => {
    if (!organization || !project || !collectionSlug) return;
    setLoading(true);
    setError(null);
    try {
      const allCols = await platformApi.collections(organization.slug, project.slug);
      const found = allCols.find((c) => c.slug === collectionSlug);
      if (!found) {
        setError(`Collection "${collectionSlug}" not found in project.`);
        return;
      }
      setCollection(found);

      const revs = await platformApi.collectionRevisions(organization.slug, project.slug, found.slug);
      setRevisions(revs);
      if (revs.length > 0) {
        setSelectedRevision(revs[0]);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to load collection details.');
    } finally {
      setLoading(false);
    }
  }, [organization, project, collectionSlug]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreateRevision = async (e: FormEvent) => {
    e.preventDefault();
    if (!organization || !project || !collection) return;
    setError(null);
    try {
      const items = JSON.parse(newItemsJson) as CollectionItem[];
      if (!Array.isArray(items)) {
        throw new Error('Collection items must be a JSON array of references.');
      }
      await platformApi.createCollectionRevision(organization.slug, project.slug, collection.slug, items);
      setAddingRevision(false);
      setNewItemsJson('');
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to create collection revision.');
    }
  };

  const exportManifest = () => {
    if (!collection || !selectedRevision) return;
    const data = {
      kind: 'Collection',
      collection: collection.slug,
      name: collection.name,
      revision: selectedRevision.revision,
      digest: selectedRevision.digest,
      items: selectedRevision.items,
      exported_at: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `collection-${collection.slug}-r${selectedRevision.revision}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!organization || !project) return null;

  return (
    <div className="platform-page collection-detail-page">
      <div>
        <Link
          to={`/app/${organization.slug}/${project.slug}/collections`}
          className="collection-breadcrumb"
        >
          <ArrowLeft size={14} /> Back to Collections
        </Link>
      </div>

      {error && <p className="platform-form-error" role="alert">{error}</p>}

      {loading && !collection && (
        <div className="route-loading" role="status">
          <span className="status-dot" aria-hidden="true" /> Loading collection…
        </div>
      )}

      {collection && (
        <>
          <div className="collection-header-card">
            <div className="collection-title-row">
              <div className="collection-title-group">
                <h1>
                  <Library className="header-icon" />
                  {collection.name}
                </h1>
                <div>
                  <code>{collection.slug}</code>
                  <span className="hash-badge">{revisions.length} Revisions</span>
                  {selectedRevision && (
                    <DigestBadge
                      digest={selectedRevision.digest}
                      kind="collection"
                      label={`r${selectedRevision.revision}`}
                      size="sm"
                    />
                  )}
                </div>
              </div>

              <div className="collection-actions">
                <button
                  type="button"
                  onClick={exportManifest}
                  className="collection-action-btn"
                  title="Export canonical collection manifest JSON"
                >
                  <Download size={14} /> Export Manifest
                </button>
                <button
                  type="button"
                  onClick={() => setAddingRevision(!addingRevision)}
                  className="collection-action-btn is-primary"
                >
                  <Plus size={14} /> New Revision
                </button>
              </div>
            </div>

            <p className="collection-desc">
              {collection.description || 'No description provided.'}
            </p>
          </div>

          {/* New Revision Form Modal / Collapse */}
          {addingRevision && (
            <div className="collection-header-card">
              <h3>Append Immutable Revision</h3>
              <p>
                Provide an array of target references (cases, resources, reports) with target digests.
              </p>
              <form onSubmit={handleCreateRevision}>
                <textarea
                  rows={8}
                  className="collection-textarea"
                  value={newItemsJson}
                  onChange={(e) => setNewItemsJson(e.target.value)}
                  placeholder={`[\n  {\n    "target_kind": "case",\n    "target_digest": "sha256-...",\n    "target_ref": { "case": "simple-seq", "revision": 1 }\n  }\n]`}
                  required
                />
                <div>
                  <button type="submit" className="collection-action-btn is-primary">
                    Publish Revision
                  </button>
                  <button type="button" onClick={() => setAddingRevision(false)} className="collection-action-btn">
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* Revisions Navigation */}
          <div className="collection-revisions-nav">
            <span>
              <GitBranch size={14} />
              REVISIONS:
            </span>
            {revisions.map((rev) => (
              <button
                key={rev.id}
                type="button"
                onClick={() => setSelectedRevision(rev)}
                className={`revision-tab-btn ${selectedRevision?.id === rev.id ? 'is-active' : ''}`}
              >
                <strong>r{rev.revision}</strong>
                <span>({rev.items.length} items)</span>
              </button>
            ))}
          </div>

          {/* Selected Revision Items Table */}
          {selectedRevision && (
            <div className="collection-table-panel">
              <div className="collection-table-header">
                <div>
                  <span>Revision r{selectedRevision.revision} Elements Breakdown</span>
                  <small>
                    Created: {new Date(selectedRevision.created_at).toLocaleString()}
                  </small>
                </div>
                <DigestBadge digest={selectedRevision.digest} kind="collection" label="Revision Digest" size="sm" />
              </div>

              <table className="collection-items-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Target Kind</th>
                    <th>Target Reference</th>
                    <th>Cryptographic Digest</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedRevision.items.map((item, idx) => {
                    const kind = item.target_kind || 'case';
                    const targetRef = item.target_ref || {};
                    const caseSlug = targetRef.case || targetRef.case_slug;
                    const reportSlug = targetRef.report || targetRef.report_slug;

                    let targetLink = '';
                    if (kind === 'case' && caseSlug) {
                      targetLink = `/app/${organization.slug}/${project.slug}/cases/${caseSlug}`;
                    } else if (kind === 'report' && reportSlug) {
                      targetLink = `/app/${organization.slug}/${project.slug}/reports/${reportSlug}`;
                    } else if (kind === 'resource') {
                      targetLink = `/app/${organization.slug}/${project.slug}/resources`;
                    }

                    return (
                      <tr key={idx}>
                        <td>
                          {String(idx + 1).padStart(2, '0')}
                        </td>
                        <td>
                          <span className={`kind-tag kind-${kind}`}>
                            {kind === 'case' && <FileBox size={10} />}
                            {kind === 'resource' && <Layers size={10} />}
                            {kind === 'report' && <FileText size={10} />}
                            {kind}
                          </span>
                        </td>
                        <td>
                          <code className="item-target-ref">{JSON.stringify(targetRef)}</code>
                        </td>
                        <td>
                          <DigestBadge digest={item.target_digest} kind={kind} size="sm" />
                        </td>
                        <td>
                          {targetLink ? (
                            <Link
                              to={targetLink}
                              className="digest-copy-btn"
                             
                            >
                              <ExternalLink size={12} /> Inspect
                            </Link>
                          ) : (
                            <span>—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {selectedRevision.items.length === 0 && (
                    <tr>
                      <td colSpan={5}>
                        No items in this collection revision.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
};
