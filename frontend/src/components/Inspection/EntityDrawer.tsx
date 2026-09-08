import { useState, type ReactNode } from 'react';
import { X, Copy, Check, ExternalLink, Trash2, Edit3, Archive, Info, Code, FileText } from 'lucide-react';
import { ZipViewer } from './ZipViewer';
import './VisualEffects.css';

export interface EntityDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  badge?: { label: string; variant?: 'running' | 'completed' | 'failed' | 'queued' | 'default' };
  metadata?: Array<{ label: string; value: ReactNode }>;
  jsonDocument?: Record<string, unknown> | null;
  archiveBlob?: Blob | null;
  fetchArchiveBlob?: () => Promise<Blob | ArrayBuffer>;
  archiveFilename?: string;
  editable?: {
    fields: Array<{ key: string; label: string; type?: 'text' | 'textarea'; initialValue: string }>;
    onSave: (values: Record<string, string>) => Promise<void>;
  };
  deletable?: {
    onDelete: () => Promise<void>;
    confirmMessage?: string;
  };
  actions?: Array<{
    label: string;
    icon?: ReactNode;
    onClick: () => void | Promise<void>;
    variant?: 'primary' | 'secondary' | 'danger';
    disabled?: boolean;
    title?: string;
  }>;
  fullPageUrl?: string;
}

export function EntityDrawer({
  isOpen,
  onClose,
  title,
  subtitle,
  badge,
  metadata = [],
  jsonDocument,
  archiveBlob,
  fetchArchiveBlob,
  archiveFilename,
  editable,
  deletable,
  actions,
  fullPageUrl,
}: EntityDrawerProps) {
  const [activeTab, setActiveTab] = useState<'overview' | 'files' | 'json' | 'edit'>('overview');
  const [editValues, setEditValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    editable?.fields.forEach((f) => {
      initial[f.key] = f.initialValue;
    });
    return initial;
  });
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [copiedJson, setCopiedJson] = useState(false);

  if (!isOpen) return null;

  const hasFiles = Boolean(archiveBlob || fetchArchiveBlob);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editable) return;
    setSaving(true);
    try {
      await editable.onSave(editValues);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deletable) return;
    setDeleting(true);
    try {
      await deletable.onDelete();
      onClose();
    } finally {
      setDeleting(false);
      setShowDeleteConfirm(false);
    }
  };

  const copyJson = () => {
    if (!jsonDocument) return;
    navigator.clipboard.writeText(JSON.stringify(jsonDocument, null, 2)).then(() => {
      setCopiedJson(true);
      setTimeout(() => setCopiedJson(false), 2000);
    });
  };

  return (
    <div className="entity-drawer-overlay" onClick={onClose}>
      <aside className="entity-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-header">
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <h3 style={{ margin: 0, fontSize: '1.15rem' }}>{title}</h3>
              {badge && (
                <span className={`hash-badge ${badge.variant ? `glow-${badge.variant}` : ''}`}>
                  {badge.label}
                </span>
              )}
            </div>
            {subtitle && (
              <small style={{ color: 'var(--color-text-secondary)', display: 'block', marginTop: '4px' }}>
                {subtitle}
              </small>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            {fullPageUrl && (
              <a
                href={fullPageUrl}
                target="_blank"
                rel="noreferrer"
                className="hash-badge"
                style={{ padding: '5px 9px', textDecoration: 'none' }}
                title="Open full page view"
              >
                <ExternalLink size={13} />
                Open
              </a>
            )}
            <button
              type="button"
              onClick={onClose}
              style={{ background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', padding: 4 }}
              aria-label="Close drawer"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="drawer-tabs">
          <button
            type="button"
            className={`drawer-tab ${activeTab === 'overview' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('overview')}
          >
            <Info size={14} />
            Overview
          </button>
          {hasFiles && (
            <button
              type="button"
              className={`drawer-tab ${activeTab === 'files' ? 'is-active' : ''}`}
              onClick={() => setActiveTab('files')}
            >
              {archiveFilename?.toLowerCase().endsWith('.zip') ? <Archive size={14} /> : <FileText size={14} />}
              {archiveFilename?.toLowerCase().endsWith('.zip') ? 'Decompress & Files' : 'Inspect Content'}
            </button>
          )}
          {jsonDocument && (
            <button
              type="button"
              className={`drawer-tab ${activeTab === 'json' ? 'is-active' : ''}`}
              onClick={() => setActiveTab('json')}
            >
              <Code size={14} />
              Document / JSON
            </button>
          )}
          {editable && (
            <button
              type="button"
              className={`drawer-tab ${activeTab === 'edit' ? 'is-active' : ''}`}
              onClick={() => setActiveTab('edit')}
            >
              <Edit3 size={14} />
              Edit
            </button>
          )}
        </div>

        <div className="drawer-content">
          {activeTab === 'overview' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div className="drawer-meta-grid">
                {metadata.map((item, idx) => (
                  <div key={idx} className="drawer-meta-item">
                    <span className="drawer-meta-label">
                      {item.label}
                    </span>
                    <span className="drawer-meta-value">
                      {item.value}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'files' && hasFiles && (
            <ZipViewer
              blob={archiveBlob}
              fetchBlob={fetchArchiveBlob}
              filename={archiveFilename}
            />
          )}

          {activeTab === 'json' && jsonDocument && (
            <div style={{ position: 'relative' }}>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '0.5rem' }}>
                <button
                  type="button"
                  onClick={copyJson}
                  className="hash-badge"
                  style={{ cursor: 'pointer' }}
                >
                  {copiedJson ? <Check size={12} color="var(--color-success)" /> : <Copy size={12} />}
                  {copiedJson ? 'Copied' : 'Copy JSON'}
                </button>
              </div>
              <pre
                className="terminal-viewer"
                style={{ maxHeight: '460px', overflowY: 'auto' }}
              >
                <code>{JSON.stringify(jsonDocument, null, 2)}</code>
              </pre>
            </div>
          )}

          {activeTab === 'edit' && editable && (
            <form onSubmit={handleSave} className="drawer-form">
              {editable.fields.map((field) => (
                <label key={field.key} className="drawer-form-label">
                  <span>{field.label}</span>
                  {field.type === 'textarea' ? (
                    <textarea
                      value={editValues[field.key] ?? ''}
                      onChange={(e) => setEditValues({ ...editValues, [field.key]: e.target.value })}
                      rows={4}
                      className="drawer-textarea"
                    />
                  ) : (
                    <input
                      type="text"
                      value={editValues[field.key] ?? ''}
                      onChange={(e) => setEditValues({ ...editValues, [field.key]: e.target.value })}
                      className="drawer-input"
                    />
                  )}
                </label>
              ))}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1rem' }}>
                <button
                  type="submit"
                  disabled={saving}
                  className="drawer-btn-primary"
                >
                  {saving ? 'Saving changes…' : 'Save Changes'}
                </button>
              </div>
            </form>
          )}
        </div>

        <div className="drawer-footer">
          {deletable && !showDeleteConfirm && (
            <button
              type="button"
              onClick={() => setShowDeleteConfirm(true)}
              className="drawer-btn-danger"
              style={{ marginRight: 'auto' }}
            >
              <Trash2 size={13} />
              Delete
            </button>
          )}

          {showDeleteConfirm && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginRight: 'auto' }}>
              <span style={{ fontSize: '0.8rem', color: 'var(--color-error)' }}>
                {deletable?.confirmMessage ?? 'Are you sure you want to permanently delete this?'}
              </span>
              <button
                type="button"
                disabled={deleting}
                onClick={() => void handleDelete()}
                className="drawer-btn-danger"
              >
                {deleting ? 'Deleting…' : 'Yes, Delete'}
              </button>
              <button
                type="button"
                onClick={() => setShowDeleteConfirm(false)}
                className="drawer-btn-secondary"
              >
                Cancel
              </button>
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginLeft: deletable ? '0' : 'auto' }}>
            {actions?.map((act, idx) => (
              <button
                key={idx}
                type="button"
                title={act.title}
                disabled={act.disabled}
                onClick={() => void act.onClick()}
                className={act.variant === 'primary' ? 'drawer-btn-primary' : act.variant === 'danger' ? 'drawer-btn-danger' : 'drawer-btn-secondary'}
              >
                {act.icon}
                {act.label}
              </button>
            ))}
            <button
              type="button"
              onClick={onClose}
              className="drawer-btn-secondary"
            >
              Close
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}
