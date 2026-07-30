import { useEffect, useState } from 'react';
import { apiClient } from '../../api/client';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Alert } from '../../components/ui/Alert';
import './Schemas.css';

// The general schema covers plain binding problems and placement-aware ones
// alike: the resource and latency models are optional blocks within it.
type SchemaType = 'general' | 'engine';

export function Schemas() {
  const [engines, setEngines] = useState<string[]>([]);
  const [generalSchema, setGeneralSchema] = useState<any>(null);
  const [engineSchemas, setEngineSchemas] = useState<Record<string, any>>({});
  const [selectedType, setSelectedType] = useState<SchemaType>('general');
  const [selectedEngine, setSelectedEngine] = useState<string>('');
  const [loadingSchema, setLoadingSchema] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());

  useEffect(() => {
    loadEngines();
    loadGeneralSchema();
  }, []);

  useEffect(() => {
    if (selectedType === 'engine' && selectedEngine && !engineSchemas[selectedEngine]) {
      loadEngineSchema(selectedEngine);
    }
  }, [selectedType, selectedEngine, engineSchemas]);

  const loadEngines = async () => {
    try {
      const data = await apiClient.getEngines();
      const engineIds = data.map(e => e.id);
      setEngines(engineIds);
      if (engineIds.length > 0 && !selectedEngine) {
        setSelectedEngine(engineIds[0]);
      }
    } catch (err) {
      console.error('Failed to load engines:', err);
    }
  };

  const loadGeneralSchema = async () => {
    try {
      setLoadingSchema(true);
      setError(null);
      const schema = await apiClient.getGeneralSchema();
      setGeneralSchema(schema);
    } catch (err: any) {
      setError(err.message || 'Failed to load general schema');
    } finally {
      setLoadingSchema(false);
    }
  };

  const loadEngineSchema = async (engineId: string) => {
    try {
      setLoadingSchema(true);
      setError(null);
      const schema = await apiClient.getEngineSchema(engineId);
      setEngineSchemas(prev => ({ ...prev, [engineId]: schema }));
    } catch (err: any) {
      setError(err.message || `Failed to load schema for ${engineId}`);
    } finally {
      setLoadingSchema(false);
    }
  };

  const getCurrentSchema = () => {
    if (selectedType === 'general') {
      return generalSchema;
    }
    return engineSchemas[selectedEngine];
  };

  const downloadSchema = () => {
    const schema = getCurrentSchema();
    if (!schema) return;

    const filename = selectedType === 'general'
      ? 'general-schema.json'
      : `${selectedEngine}-schema.json`;
    
    const blob = new Blob([JSON.stringify(schema, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  const togglePath = (path: string) => {
    setExpandedPaths(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const renderJsonTree = (obj: any, path: string = '', level: number = 0): React.ReactElement => {
    if (obj === null) {
      return <span className="json-null">null</span>;
    }

    if (typeof obj !== 'object') {
      const className = `json-${typeof obj}`;
      return <span className={className}>{JSON.stringify(obj)}</span>;
    }

    if (Array.isArray(obj)) {
      if (obj.length === 0) {
        return <span className="json-array">[]</span>;
      }

      const isExpanded = expandedPaths.has(path);
      
      return (
        <div className="json-node">
          <span 
            className="json-toggle" 
            onClick={() => togglePath(path)}
            style={{ cursor: 'pointer' }}
          >
            {isExpanded ? '▼' : '▶'} [{obj.length}]
          </span>
          {isExpanded && (
            <div className="json-children" style={{ marginLeft: `${level * 16}px` }}>
              {obj.map((item, i) => (
                <div key={i} className="json-item">
                  <span className="json-key">{i}:</span>
                  {renderJsonTree(item, `${path}[${i}]`, level + 1)}
                </div>
              ))}
            </div>
          )}
        </div>
      );
    }

    const keys = Object.keys(obj);
    if (keys.length === 0) {
      return <span className="json-object">{'{}'}</span>;
    }

    const isExpanded = expandedPaths.has(path) || level === 0;

    return (
      <div className="json-node">
        <span 
          className="json-toggle" 
          onClick={() => level > 0 && togglePath(path)}
          style={{ cursor: level > 0 ? 'pointer' : 'default' }}
        >
          {level > 0 && (isExpanded ? '▼' : '▶')} {'{'}
        </span>
        {isExpanded && (
          <div className="json-children" style={{ marginLeft: `${Math.max(0, level) * 16}px` }}>
            {keys.map(key => {
              const childPath = path ? `${path}.${key}` : key;
              const matchesSearch = !searchQuery || 
                key.toLowerCase().includes(searchQuery.toLowerCase());

              if (!matchesSearch && searchQuery) return null;

              return (
                <div key={key} className="json-item">
                  <span className="json-key">{key}:</span>
                  <span className="json-copy" onClick={() => copyToClipboard(childPath)} title="Copy path">
                    📋
                  </span>
                  {renderJsonTree(obj[key], childPath, level + 1)}
                </div>
              );
            })}
          </div>
        )}
        <span className="json-bracket">{'}'}</span>
      </div>
    );
  };

  const schema = getCurrentSchema();

  const renderJsonTab = () => {
    if (loadingSchema) {
      return <div className="loading-state">Loading schema...</div>;
    }

    if (error) {
      return (
        <Alert type="error" title="Error">
          {error}
        </Alert>
      );
    }

    if (!schema) {
      return (
        <Alert type="info">
          Select a schema type to view its structure.
        </Alert>
      );
    }

    return (
      <>
        <div className="schema-search">
          <input
            type="text"
            placeholder="Search schema properties..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="search-input"
          />
          {searchQuery && (
            <Button variant="ghost" size="sm" onClick={() => setSearchQuery('')}>
              Clear
            </Button>
          )}
        </div>
        <Card padding="lg" className="schema-viewer">
          <div className="json-tree">
            {renderJsonTree(schema)}
          </div>
        </Card>
      </>
    );
  };

  return (
    <div className="schemas-page">
      <div className="container">
        <div className="page-header">
          <h1>Schema Explorer</h1>
          <p className="page-description">
            Browse the general schema and the instance schema each engine accepts
          </p>
        </div>

        {/* Controls */}
        <div className="schema-controls">
          <div className="schema-type-selector">
            <Button
              variant={selectedType === 'general' ? 'primary' : 'secondary'}
              onClick={() => setSelectedType('general')}
            >
              General Schema
            </Button>
            <Button
              variant={selectedType === 'engine' ? 'primary' : 'secondary'}
              onClick={() => setSelectedType('engine')}
            >
              Engine Schemas
            </Button>
          </div>

          {selectedType === 'engine' && (
            <select
              value={selectedEngine}
              onChange={(e) => setSelectedEngine(e.target.value)}
              className="engine-selector"
            >
              {engines.map(id => (
                <option key={id} value={id}>{id}</option>
              ))}
            </select>
          )}

          {schema && (
            <Button variant="secondary" onClick={downloadSchema}>
              Download JSON
            </Button>
          )}
        </div>

        {/* Schema Info */}
        {schema && (
          <Card padding="md" className="schema-info-card">
            <div className="schema-info-grid">
              {schema.$id && (
                <div className="schema-info-item">
                  <span className="info-label">Schema ID:</span>
                  <code>{schema.$id}</code>
                </div>
              )}
              {schema.$schema && (
                <div className="schema-info-item">
                  <span className="info-label">JSON Schema Version:</span>
                  <code>{schema.$schema}</code>
                </div>
              )}
              {schema.title && (
                <div className="schema-info-item">
                  <span className="info-label">Title:</span>
                  <span>{schema.title}</span>
                </div>
              )}
              {schema.description && (
                <div className="schema-info-item">
                  <span className="info-label">Description:</span>
                  <span>{schema.description}</span>
                </div>
              )}
            </div>
          </Card>
        )}

        {renderJsonTab()}
      </div>
    </div>
  );
}
