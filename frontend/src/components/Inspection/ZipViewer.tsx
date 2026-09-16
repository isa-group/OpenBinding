import { useState, useEffect, useTransition, type ReactNode } from 'react';
import { readZipArchive, isZipBinary, type ZipArchive, type ZipTreeNode, type ZipFileEntry } from '../../utils/zipExplorer';
import { File, Folder, FolderOpen, Download, Copy, Check, Terminal, AlertCircle, FileText } from 'lucide-react';
import { CodeEditor } from '../CodeEditor/CodeEditor';
import './VisualEffects.css';

interface ZipViewerProps {
  blob?: Blob | null;
  fetchBlob?: () => Promise<Blob | ArrayBuffer>;
  filename?: string;
}

export function ZipViewer({ blob: initialBlob, fetchBlob, filename = 'archive.zip' }: ZipViewerProps) {
  const [archive, setArchive] = useState<ZipArchive | null>(null);
  const [nonZipContent, setNonZipContent] = useState<string | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<ZipFileEntry | null>(null);
  const [fileContent, setFileContent] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [, startTransition] = useTransition();
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set(['root']));

  useEffect(() => {
    let active = true;

    async function load() {
      setLoading(true);
      setError(null);
      setNonZipContent(null);
      try {
        let dataBlob: Blob | ArrayBuffer | null = initialBlob ?? null;
        if (!dataBlob && fetchBlob) {
          dataBlob = await fetchBlob();
        }
        if (!dataBlob) {
          throw new Error('No archive binary available to inspect.');
        }

        const isZip = await isZipBinary(dataBlob);
        if (!isZip) {
          let text = '';
          if (dataBlob instanceof Blob) {
            text = await dataBlob.text();
          } else if (dataBlob instanceof ArrayBuffer) {
            text = new TextDecoder().decode(dataBlob);
          } else {
            text = new TextDecoder().decode(dataBlob);
          }
          if (active) {
            setNonZipContent(text);
          }
          return;
        }

        const parsed = await readZipArchive(dataBlob);
        if (active) {
          setArchive(parsed);
          // Auto-select first file
          const firstFile = parsed.entries.find((e) => !e.dir);
          if (firstFile) {
            setSelectedEntry(firstFile);
            const content = await firstFile.readText();
            if (active) setFileContent(content);
          }
        }
      } catch (err: unknown) {
        if (active) {
          setError(err instanceof Error ? err.message : 'Failed to parse ZIP archive.');
        }
      } finally {
        if (active) setLoading(false);
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, [initialBlob, fetchBlob]);

  const selectFile = async (entry: ZipFileEntry) => {
    if (entry.dir) return;
    setSelectedEntry(entry);
    startTransition(() => {
      void entry.readText().then((txt) => {
        setFileContent(txt);
      });
    });
  };

  const toggleFolder = (path: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const copyToClipboard = () => {
    if (!fileContent) return;
    navigator.clipboard.writeText(fileContent).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const downloadCurrentFile = async () => {
    if (!selectedEntry) return;
    try {
      const bytes = await selectedEntry.readBinary();
      const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = selectedEntry.name;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // ignore
    }
  };

  if (loading) {
    return (
      <div className="zip-explorer" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', color: '#94a3b8' }}>
          <span className="telemetry-pulse glow-running" style={{ width: 12, height: 12, borderRadius: '50%' }} />
          Decompressing archive contents in browser…
        </div>
      </div>
    );
  }

  if (nonZipContent !== null) {
    return (
      <div className="zip-explorer">
        <div className="zip-summary-bar">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <FileText size={15} />
            <span><strong>{filename}</strong></span>
            <span>•</span>
            <span>Plain document content</span>
          </div>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(nonZipContent);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}
            className="hash-badge"
            style={{ cursor: 'pointer' }}
          >
            {copied ? <Check size={12} color="var(--color-success)" /> : <Copy size={12} />}
            {copied ? 'Copied' : 'Copy content'}
          </button>
        </div>
        <div className="zip-content-body" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
          <code>{nonZipContent}</code>
        </div>
      </div>
    );
  }

  if (error || !archive) {
    return (
      <div className="zip-explorer" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', color: '#f87171' }}>
          <AlertCircle size={20} />
          {error || 'Unable to open ZIP archive.'}
        </div>
      </div>
    );
  }

  const renderTree = (node: ZipTreeNode, depth = 0): ReactNode => {
    if (node.name === 'root') {
      return node.children.map((child) => renderTree(child, 0));
    }

    const isFolder = node.isDir;
    const isExpanded = expandedFolders.has(node.path);
    const isSelected = selectedEntry && selectedEntry.path === node.path;

    return (
      <div key={node.path} style={{ marginLeft: depth * 12 }}>
        <div
          className={`zip-tree-item ${isSelected ? 'is-active' : ''}`}
          onClick={() => {
            if (isFolder) toggleFolder(node.path);
            else if (node.entry) void selectFile(node.entry);
          }}
          title={node.path}
        >
          {isFolder ? (
            isExpanded ? <FolderOpen size={14} color="#f59e0b" /> : <Folder size={14} color="#f59e0b" />
          ) : (
            <File size={14} color="#38bdf8" />
          )}
          <span>{node.name}</span>
          {!isFolder && (
            <small style={{ marginLeft: 'auto', opacity: 0.6, fontSize: '0.7rem' }}>
              {Math.round(node.size / 1024)}KB
            </small>
          )}
        </div>
        {isFolder && isExpanded && node.children.map((child) => renderTree(child, depth + 1))}
      </div>
    );
  };

  return (
    <div className="zip-explorer">
      <div className="zip-summary-bar">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Terminal size={16} color="#38bdf8" />
          <span><strong>{filename}</strong></span>
          <span>•</span>
          <span>{archive.entries.filter((e) => !e.dir).length} files</span>
          <span>•</span>
          <span>{(archive.totalSize / 1024).toFixed(1)} KB uncompressed</span>
        </div>
      </div>

      <div className="zip-layout">
        <div className="zip-tree-panel">
          <div style={{ fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: '#64748b', padding: '4px 8px 8px' }}>
            Files in Archive
          </div>
          {renderTree(archive.tree)}
        </div>

        <div className="zip-content-panel">
          {selectedEntry ? (
            <>
              <div className="zip-content-header">
                <span style={{ fontFamily: 'monospace' }}>{selectedEntry.path}</span>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button
                    type="button"
                    onClick={copyToClipboard}
                    className="hash-badge"
                    style={{ cursor: 'pointer', background: 'rgba(255,255,255,0.08)' }}
                    title="Copy content"
                  >
                    {copied ? <Check size={12} color="#10b981" /> : <Copy size={12} />}
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void downloadCurrentFile()}
                    className="hash-badge"
                    style={{ cursor: 'pointer', background: 'rgba(255,255,255,0.08)' }}
                    title="Download file"
                  >
                    <Download size={12} />
                    Download
                  </button>
                </div>
              </div>
              <div className="zip-content-body" style={{ padding: 0, overflow: 'hidden' }}>
                <CodeEditor
                  value={fileContent}
                  onChange={() => {}}
                  readOnly={true}
                  language={selectedEntry.name.endsWith('.json') || selectedEntry.name.endsWith('.bim') ? 'json' : 'text'}
                  minHeight="320px"
                  maxHeight="520px"
                  ariaLabel={`Preview of ${selectedEntry.name}`}
                />
              </div>
            </>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#64748b' }}>
              Select a file from the tree to inspect.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
