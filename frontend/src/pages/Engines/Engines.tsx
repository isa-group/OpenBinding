import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiClient } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import type { Engine } from '../../api/client';
import { Card } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Alert } from '../../components/ui/Alert';
import './Engines.css';

export function Engines() {
  const [engines, setEngines] = useState<Engine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedEngines, setSelectedEngines] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState('grid' as 'grid' | 'comparison');
  // Built-in engines and registered ones answer different questions - "what
  // can this gateway do" versus "what have I put here" - so they get a filter
  // rather than being mixed into one list.
  const [origin, setOrigin] = useState('all' as 'all' | 'builtin' | 'mine' | 'public');
  const { user } = useAuth();

  useEffect(() => {
    loadEngines();
  }, []);

  const loadEngines = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await apiClient.getEngines();
      setEngines(data);
    } catch (err: any) {
      setError(err.message || 'Failed to load engines');
    } finally {
      setLoading(false);
    }
  };

  const matchesOrigin = (engine: Engine) => {
    if (origin === 'all') return true;
    if (origin === 'builtin') return !engine.federated;
    if (origin === 'mine') return engine.federated && engine.owner === user?.username;
    return engine.federated && engine.visibility === 'public';
  };

  const filteredEngines = engines.filter(
    (engine) => engine.id.toLowerCase().includes(searchQuery.toLowerCase()) && matchesOrigin(engine)
  );

  const hasFederated = engines.some((engine) => engine.federated);

  const toggleEngineSelection = (engineId: string) => {
    setSelectedEngines(prev =>
      prev.includes(engineId)
        ? prev.filter(id => id !== engineId)
        : [...prev, engineId].slice(-3) // Max 3 engines for comparison
    );
  };

  const extractCapabilities = (engine: Engine) => {
    const caps = engine.capabilities || {};
    return Object.entries(caps).map(([key, value]) => ({
      key,
      value: Array.isArray(value) 
        ? value 
        : typeof value === 'object' && value !== null
        ? Object.keys(value) 
        : [value]
    }));
  };

  const formatCapabilityName = (name: string) => {
    // Replace underscores with spaces and capitalize first letter
    const formatted = name.replace(/_/g, ' ');
    return formatted.charAt(0).toUpperCase() + formatted.slice(1);
  };

  if (loading) {
    return (
      <div className="engines-page">
        <div className="container">
          <div className="page-header">
            <h1>Solver Engines</h1>
          </div>
          <div className="loading-state">Loading engines...</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="engines-page">
        <div className="container">
          <div className="page-header">
            <h1>Solver Engines</h1>
          </div>
          <Alert type="error" title="Failed to Load Engines">
            {error}
          </Alert>
          <Button onClick={loadEngines} className="mt-4">Retry</Button>
        </div>
      </div>
    );
  }

  if (engines.length === 0) {
    return (
      <div className="engines-page">
        <div className="container">
          <div className="page-header">
            <h1>Solver Engines</h1>
          </div>
          <Alert type="info" title="No Engines Available">
            Make sure the OpenBinding gateway is running and engines are registered.
          </Alert>
        </div>
      </div>
    );
  }

  return (
    <div className="engines-page">
      <div className="container">
        <div className="page-header">
          <h1>Solver Engines</h1>
          <p className="page-description">
            Explore available solver engines and compare their capabilities
          </p>
        </div>

        {/* Controls */}
        <div className="engines-controls">
          <input
            type="text"
            placeholder="Search engines..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="search-input"
          />
          
          <div className="view-mode-toggle">
            <Button
              variant={viewMode === 'grid' ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => setViewMode('grid')}
            >
              Grid View
            </Button>
            <Button
              variant={viewMode === 'comparison' ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => setViewMode('comparison')}
            >
              Comparison
            </Button>
          </div>

          <Link to="/engines/new" className="register-engine-link">
            <Button size="sm">Register an engine</Button>
          </Link>
        </div>

        {hasFederated && (
          <div className="origin-filter">
            {([
              ['all', 'All'],
              ['builtin', 'Built-in'],
              ['mine', 'Mine'],
              ['public', 'Public'],
            ] as const).map(([value, label]) => (
              <Button
                key={value}
                variant={origin === value ? 'primary' : 'secondary'}
                size="sm"
                onClick={() => setOrigin(value)}
              >
                {label}
              </Button>
            ))}
          </div>
        )}

        {/* Comparison Mode Instructions */}
        {viewMode === 'comparison' && (
          <Alert type="info">
            Select up to 3 engines to compare side-by-side. Click on engine cards to select them.
          </Alert>
        )}

        {/* Grid View */}
        {viewMode === 'grid' && (
          <div className="engines-grid">
            {filteredEngines.map((engine) => {
              const capabilities = extractCapabilities(engine);
              const isSelected = selectedEngines.includes(engine.id);

              return (
                <Card
                  key={engine.id}
                  padding="lg"
                  hover
                  className={`engine-card ${isSelected ? 'selected' : ''}`}
                  onClick={() => toggleEngineSelection(engine.id)}
                >
                  <div className="engine-header">
                    <h3 className="engine-title">{engine.id}</h3>
                    <div className="engine-badges">
                      {isSelected && <Badge variant="success">Selected</Badge>}
                      {engine.federated && <Badge variant="warning">Federated</Badge>}
                      {engine.visibility === 'pending_review' && (
                        <Badge variant="default">Pending review</Badge>
                      )}
                      <Badge variant={engine.active === false ? 'error' : 'accent'}>
                        {engine.active === false ? 'Inactive' : 'Active'}
                      </Badge>
                    </div>
                  </div>

                  {capabilities.length > 0 ? (
                    <div className="capabilities-section">
                      <h4 className="capabilities-title">Capabilities</h4>
                      <div className="capabilities-list">
                        {capabilities.map(({ key, value }) => (
                          <div key={key} className="capability-item">
                            <span className="capability-key">{formatCapabilityName(key)}:</span>
                            <div className="capability-values">
                              {Array.isArray(value) && value.length > 0 ? (
                                value.map((v, i) => (
                                  <Badge key={i} variant="default" size="sm" title={`${formatCapabilityName(key)}: ${String(v)}`}>
                                    {String(v) === '*' ? '* (any)' : String(v)}
                                  </Badge>
                                ))
                              ) : (
                                <Badge variant="default" size="sm">
                                  {value.length} items
                                </Badge>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <p className="no-capabilities">
                      Capabilities defined in schema
                    </p>
                  )}
                </Card>
              );
            })}
          </div>
        )}

        {/* Comparison View */}
        {viewMode === 'comparison' && (
          <div className="comparison-view">
            {selectedEngines.length === 0 ? (
              <div className="comparison-empty">
                <p>Select engines from the list to compare them</p>
                <div className="engines-selection-grid">
                  {filteredEngines.map((engine) => (
                    <Card
                      key={engine.id}
                      padding="md"
                      hover
                      onClick={() => toggleEngineSelection(engine.id)}
                      className="selectable-engine-card"
                    >
                      <h4>{engine.id}</h4>
                      <Button size="sm" variant="secondary">
                        Select
                      </Button>
                    </Card>
                  ))}
                </div>
              </div>
            ) : (
              <div className="comparison-grid">
                {selectedEngines.map((engineId) => {
                  const engine = engines.find(e => e.id === engineId);
                  if (!engine) return null;

                  const capabilities = extractCapabilities(engine);

                  return (
                    <Card key={engineId} padding="lg" className="comparison-card">
                      <div className="comparison-card-header">
                        <h3>{engine.id}</h3>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => toggleEngineSelection(engineId)}
                        >
                          Remove
                        </Button>
                      </div>

                      {capabilities.length > 0 ? (
                        <div className="comparison-capabilities">
                          {capabilities.map(({ key, value }) => {
                            // Check if value is array containing only '*'
                            const isAny = Array.isArray(value) && value.length === 1 && value[0] === '*';
                            const displayValue = isAny ? 'Any' : (Array.isArray(value) ? value.length : '—');
                            
                            return (
                              <div key={key} className="comparison-capability">
                                <div className="comparison-cap-key">{formatCapabilityName(key)}</div>
                                <div className="comparison-cap-value">
                                  {displayValue}
                                  {Array.isArray(value) && value.length > 0 && !isAny && (
                                    <div className="comparison-cap-items">
                                      {value.slice(0, 3).map((v, i) => (
                                        <Badge key={i} variant="default" size="sm">
                                          {String(v)}
                                        </Badge>
                                      ))}
                                      {value.length > 3 && (
                                        <span className="more-items">+{value.length - 3} more</span>
                                      )}
                                    </div>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <p className="no-capabilities">No capability data available</p>
                      )}
                    </Card>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
