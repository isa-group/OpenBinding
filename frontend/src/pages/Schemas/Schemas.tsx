import { useEffect, useMemo, useRef, useState } from 'react';
import mermaid from 'mermaid';
import { TransformComponent, TransformWrapper } from 'react-zoom-pan-pinch';
import { apiClient } from '../../api/client';
import { schemaModelService } from '../../api/schemaModels';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Alert } from '../../components/ui/Alert';
import { Tabs } from '../../components/ui/Tabs';
import './Schemas.css';

// 'bimstar' is the placement-aware BIM* variant of the general schema
// (resource model, latency model, budgets); it is served by the gateway under
// the same schema endpoints with the pseudo-id 'bimstar'.
type SchemaType = 'general' | 'bimstar' | 'engine';

export function Schemas() {
  const [engines, setEngines] = useState<string[]>([]);
  const [generalSchema, setGeneralSchema] = useState<any>(null);
  const [engineSchemas, setEngineSchemas] = useState<Record<string, any>>({});
  const [generalModel, setGeneralModel] = useState<string | null | undefined>(undefined);
  const [engineModels, setEngineModels] = useState<Record<string, string | null>>({});
  const [selectedType, setSelectedType] = useState<SchemaType>('general');
  const [selectedEngine, setSelectedEngine] = useState<string>('');
  const [loadingSchema, setLoadingSchema] = useState(false);
  const [loadingModel, setLoadingModel] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [renderedModelSvg, setRenderedModelSvg] = useState<string>('');
  const [renderingModel, setRenderingModel] = useState(false);
  const modelDiagramRef = useRef<HTMLDivElement | null>(null);

  const normalizeMermaidSvg = (svg: string): string => {
    return svg.replace(/<svg([^>]*)>/, (_match, rawAttrs: string) => {
      const cleanedAttrs = rawAttrs
        .replace(/\swidth="[^"]*"/g, '')
        .replace(/\sheight="[^"]*"/g, '')
        .replace(/\sstyle="[^"]*"/g, '');

      return `<svg${cleanedAttrs} preserveAspectRatio="xMidYMid meet" width="100%" height="100%" style="width: 100%; height: 100%; max-width: none;">`;
    });
  };

  const fitSvgToCanvas = (container?: HTMLDivElement | null) => {
    const diagramContainer = container ?? modelDiagramRef.current;
    if (!diagramContainer) return;

    const svg = diagramContainer.querySelector('svg');
    if (!svg) return;

    try {
      const bbox = svg.getBBox();
      if (!Number.isFinite(bbox.width) || !Number.isFinite(bbox.height) || bbox.width <= 0 || bbox.height <= 0) {
        return;
      }

      const paddingX = Math.max(16, bbox.width * 0.04);
      const paddingY = Math.max(16, bbox.height * 0.04);
      const viewBox = `${bbox.x - paddingX} ${bbox.y - paddingY} ${bbox.width + paddingX * 2} ${bbox.height + paddingY * 2}`;

      svg.setAttribute('viewBox', viewBox);
      svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      svg.setAttribute('width', '100%');
      svg.setAttribute('height', '100%');
      svg.style.width = '100%';
      svg.style.height = '100%';
      svg.style.maxWidth = 'none';
    } catch {
      // Ignore fit errors and keep default Mermaid sizing.
    }
  };

  const handleModelDiagramRef = (node: HTMLDivElement | null) => {
    modelDiagramRef.current = node;
    if (!node) return;

    requestAnimationFrame(() => {
      fitSvgToCanvas(node);
    });
  };

  useEffect(() => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'default',
    });

    loadEngines();
    loadGeneralSchema();
    loadGeneralModel();
  }, []);

  useEffect(() => {
    if (selectedType === 'engine' && selectedEngine && !engineSchemas[selectedEngine]) {
      loadEngineSchema(selectedEngine);
    }
    if (selectedType === 'bimstar' && !engineSchemas['bimstar']) {
      loadEngineSchema('bimstar');
    }
  }, [selectedType, selectedEngine, engineSchemas]);

  useEffect(() => {
    if (selectedType === 'general' && generalModel === undefined) {
      loadGeneralModel();
      return;
    }

    if (selectedType === 'engine' && selectedEngine && !(selectedEngine in engineModels)) {
      loadEngineModel(selectedEngine);
    }
    if (selectedType === 'bimstar' && !('bimstar' in engineModels)) {
      loadEngineModel('bimstar');
    }
  }, [selectedType, selectedEngine, generalModel, engineModels]);

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

  const loadGeneralModel = async () => {
    try {
      setLoadingModel(true);
      setModelError(null);
      const model = await schemaModelService.getGeneralModel();
      setGeneralModel(model);
    } catch (err: any) {
      setModelError(err.message || 'Failed to load general model');
    } finally {
      setLoadingModel(false);
    }
  };

  const loadEngineModel = async (engineId: string) => {
    try {
      setLoadingModel(true);
      setModelError(null);
      const model = await schemaModelService.getEngineModel(engineId);
      setEngineModels(prev => ({ ...prev, [engineId]: model }));
    } catch (err: any) {
      setModelError(err.message || `Failed to load model for ${engineId}`);
    } finally {
      setLoadingModel(false);
    }
  };

  const getCurrentSchema = () => {
    if (selectedType === 'general') {
      return generalSchema;
    }
    if (selectedType === 'bimstar') {
      return engineSchemas['bimstar'];
    }
    return engineSchemas[selectedEngine];
  };

  const getCurrentModel = () => {
    if (selectedType === 'general') {
      return generalModel;
    }
    if (selectedType === 'bimstar') {
      return engineModels['bimstar'];
    }
    return engineModels[selectedEngine];
  };

  const downloadSchema = () => {
    const schema = getCurrentSchema();
    if (!schema) return;

    const filename = selectedType === 'general'
      ? 'general-schema.json'
      : selectedType === 'bimstar'
      ? 'bimstar-schema.json'
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
  const model = useMemo(() => getCurrentModel(), [selectedType, selectedEngine, generalModel, engineModels]);

  useEffect(() => {
    let cancelled = false;

    const renderModel = async () => {
      if (!model || typeof model !== 'string') {
        setRenderedModelSvg('');
        return;
      }

      try {
        setRenderingModel(true);
        setModelError(null);
        const id = `schema-model-${selectedType}-${selectedEngine || 'general'}-${Date.now()}`;
        const { svg } = await mermaid.render(id, model);
        if (!cancelled) {
          setRenderedModelSvg(normalizeMermaidSvg(svg));
        }
      } catch (err: any) {
        if (!cancelled) {
          setRenderedModelSvg('');
          setModelError(err.message || 'Failed to render model');
        }
      } finally {
        if (!cancelled) {
          setRenderingModel(false);
        }
      }
    };

    renderModel();

    return () => {
      cancelled = true;
    };
  }, [model, selectedType, selectedEngine]);

  useEffect(() => {
    if (!renderedModelSvg) return;

    requestAnimationFrame(() => {
      fitSvgToCanvas();
    });
  }, [renderedModelSvg]);

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

  const renderModelTab = () => {
    if (loadingModel) {
      return <div className="loading-state">Loading model...</div>;
    }

    if (modelError) {
      return (
        <Alert type="error" title="Error">
          {modelError}
        </Alert>
      );
    }

    if (model === null) {
      return (
        <Alert type="info" title="Model not available">
          This engine does not provide a Mermaid model yet. Schema validation remains available through JSON.
        </Alert>
      );
    }

    if (!model) {
      return (
        <Alert type="info">
          Select a schema to load its model.
        </Alert>
      );
    }

    if (renderingModel) {
      return <div className="loading-state">Rendering model...</div>;
    }

    return (
      <Card padding="md" className="schema-model-viewer">
        <TransformWrapper initialScale={1} minScale={0.1} maxScale={4} centerOnInit limitToBounds={false}>
          {({ zoomIn, zoomOut, resetTransform }) => (
            <>
              <div className="model-toolbar">
                <Button variant="secondary" size="sm" onClick={() => zoomIn()}>Zoom In</Button>
                <Button variant="secondary" size="sm" onClick={() => zoomOut()}>Zoom Out</Button>
                <Button variant="ghost" size="sm" onClick={() => resetTransform()}>Reset</Button>
              </div>
              <div className="schema-model-canvas">
                <TransformComponent wrapperClass="schema-model-transform-wrapper" contentClass="schema-model-transform-content">
                  <div
                    ref={handleModelDiagramRef}
                    className="schema-model-diagram"
                    dangerouslySetInnerHTML={{ __html: renderedModelSvg }}
                  />
                </TransformComponent>
              </div>
            </>
          )}
        </TransformWrapper>
      </Card>
    );
  };

  return (
    <div className="schemas-page">
      <div className="container">
        <div className="page-header">
          <h1>Schema Explorer</h1>
          <p className="page-description">
            Browse JSON schemas and their visual model representation
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
              variant={selectedType === 'bimstar' ? 'primary' : 'secondary'}
              onClick={() => setSelectedType('bimstar')}
              title="Placement-aware BIM* variant: resource model, latency model, budgets and canonical normalization"
            >
              BIM* Placement
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

        <Tabs
          tabs={[
            {
              id: 'json',
              label: 'JSON',
              content: renderJsonTab(),
            },
            {
              id: 'model',
              label: 'Model',
              content: renderModelTab(),
            },
          ]}
          defaultTab="json"
        />
      </div>
    </div>
  );
}
