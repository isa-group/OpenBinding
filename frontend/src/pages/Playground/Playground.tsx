import { useState, useEffect, useRef } from 'react';
import Ajv from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { apiClient } from '../../api/client';
import type { Engine, JobStatus } from '../../api/client';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Alert } from '../../components/ui/Alert';
import { Badge } from '../../components/ui/Badge';
import { Tabs } from '../../components/ui/Tabs';
import { CodeEditor } from '../../components/CodeEditor/CodeEditor';
import './Playground.css';

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);

const DEFAULT_INSTANCE = `{
  "metadata": {
    "id": "example-composition",
    "description": "Sample service composition"
  },
  "tasks": [],
  "candidates": [],
  "composition": {}
}`;

const DEFAULT_OPTIONS = `{
  "iterations_count": 1000
}`;

type JobState = 'idle' | 'validating' | 'queued' | 'running' | 'completed' | 'failed';

// Available examples in /examples directory
const AVAILABLE_EXAMPLES = [
  'common-basic.json',
  'common-huge.json',
  'common-mixed.json',
  'minizinc-constrained-loop.json',
  'minizinc-huge.json',
  'minizinc-tight.json',
  'random-search-example.json',
  'random-search-huge.json',
  'random-search-valid.json'
];

export function Playground() {
  // State
  const [engines, setEngines] = useState<Engine[]>([]);
  const [selectedEngine, setSelectedEngine] = useState<string>('');
  const [inputJson, setInputJson] = useState(DEFAULT_INSTANCE);
  const [solverOptions, setSolverOptions] = useState(DEFAULT_OPTIONS);
  const [sendOptions, setSendOptions] = useState(true);
  const [verbose, setVerbose] = useState(true);
  const [selectedExample, setSelectedExample] = useState<string>('');
  
  const [jobState, setJobState] = useState<JobState>('idle');
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const validateRef = useRef<any>(null);
  const generalSchemaRef = useRef<any>(null);

  // Load engines and schemas
  useEffect(() => {
    loadEngines();
    loadGeneralSchema();
  }, []);

  useEffect(() => {
    if (selectedEngine) {
      loadEngineSchema(selectedEngine);
    }
  }, [selectedEngine]);

  const loadEngines = async () => {
    try {
      const data = await apiClient.getEngines();
      setEngines(data);
      if (data.length > 0) {
        setSelectedEngine(data[0].id);
      }
    } catch (err) {
      console.error('Failed to load engines:', err);
    }
  };

  const loadGeneralSchema = async () => {
    try {
      const schema = await apiClient.getGeneralSchema();
      generalSchemaRef.current = schema;
      validateRef.current = ajv.compile(schema);
    } catch (err) {
      console.error('Failed to load general schema:', err);
    }
  };

  const loadEngineSchema = async (engineId: string) => {
    try {
      const schema = await apiClient.getEngineSchema(engineId);
      
      if (schema.$id && ajv.getSchema(schema.$id)) {
        ajv.removeSchema(schema.$id);
      }
      
      validateRef.current = ajv.compile(schema);
    } catch (err) {
      console.warn(`No specialized schema for ${engineId}, using general schema`);
      if (generalSchemaRef.current) {
        validateRef.current = ajv.compile(generalSchemaRef.current);
      }
    }
  };

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target?.result as string;
      try {
        const parsed = JSON.parse(content);
        const instance = parsed.instance || parsed;
        setInputJson(JSON.stringify(instance, null, 2));
        setSelectedExample(''); // Clear example selection when uploading
        setError(null);
      } catch (err) {
        setError('Invalid JSON file');
      }
    };
    reader.readAsText(file);
    event.target.value = '';
  };

  const handleExampleLoad = async (exampleFile: string) => {
    if (!exampleFile) {
      setSelectedExample('');
      return;
    }
    
    try {
      // In production, examples should be served via the gateway or a static path
      const response = await fetch(`/examples/${exampleFile}`);
      if (!response.ok) {
        throw new Error(`Failed to load example: ${response.statusText}`);
      }
      const content = await response.text();
      setInputJson(content);
      setSelectedExample(exampleFile);
      setError(null);
    } catch (err: any) {
      console.error('Failed to load example:', err);
      setError(`Failed to load example: ${err.message}`);
    }
  };

  const handleAnalyze = async () => {
    setJobState('validating');
    setError(null);
    setResult(null);

    try {
      const instance = JSON.parse(inputJson);
      const options = sendOptions ? JSON.parse(solverOptions) : {};

      const response = await apiClient.analyze({
        engine_id: selectedEngine,
        instance,
        options,
        verbose
      });

      setResult(response);
      setJobState('completed');
    } catch (err: any) {
      setError(err.message || 'Analysis failed');
      setJobState('failed');
    }
  };

  const handleSolve = async () => {
    setJobState('validating');
    setError(null);
    setResult(null);

    try {
      const instance = JSON.parse(inputJson);
      
      // Client-side validation
      if (validateRef.current) {
        const valid = validateRef.current(instance);
        if (!valid) {
          const errors = validateRef.current.errors?.map((e: any) => ({
            message: e.message,
            path: e.instancePath,
            code: 'client_validation_error'
          })) || [];
          
          setResult({ violations: errors, status: 'failed' });
          setJobState('failed');
          return;
        }
      }

      const options = sendOptions ? JSON.parse(solverOptions) : {};

      setJobState('queued');
      
      const jobResponse = await apiClient.solve({
        engine_id: selectedEngine,
        instance,
        options,
        verbose
      });

      // Check if it's a validation error response (422)
      if ((jobResponse as any).detail) {
        setResult((jobResponse as any).detail);
        setJobState('failed');
        return;
      }

      if (jobResponse.status === 'failed') {
        setResult(jobResponse.result || { error: jobResponse.error });
        setJobState('failed');
        return;
      }

      // Poll for job completion
      setJobState('running');
      const finalResult = await apiClient.pollJob(
        jobResponse.job_id,
        (status: JobStatus) => {
          if (status.status === 'running') {
            setJobState('running');
          }
        }
      );

      setResult(finalResult);
      setJobState('completed');
    } catch (err: any) {
      setError(err.message || 'Solve failed');
      setJobState('failed');
    }
  };

  const selectedEngineData = engines.find(e => e.id === selectedEngine);

  return (
    <div className="playground-page">
      <div className="playground-container">
        {/* Input Panel */}
        <div className="playground-panel playground-input">
          <div className="panel-header">
            <h2>Input</h2>
            <div className="header-actions">
              <select
                value={selectedExample}
                onChange={(e) => handleExampleLoad(e.target.value)}
                className="example-select"
              >
                <option value="">Load Example...</option>
                {AVAILABLE_EXAMPLES.map(ex => (
                  <option key={ex} value={ex}>{ex}</option>
                ))}
              </select>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json"
                onChange={handleFileUpload}
                style={{ display: 'none' }}
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
              >
                📁 Upload
              </Button>
            </div>
          </div>

          <div className="panel-content">
            {/* Engine Selector */}
            <Card padding="md" className="engine-selector-card">
              <div className="engine-selector-header">
                <label className="engine-label">Solver Engine</label>
                <select
                  value={selectedEngine}
                  onChange={(e) => setSelectedEngine(e.target.value)}
                  className="engine-select"
                >
                  {engines.map(e => (
                    <option key={e.id} value={e.id}>{e.id}</option>
                  ))}
                </select>
              </div>
              
              {selectedEngineData?.capabilities && (
                <div className="engine-capabilities-preview">
                  <span className="capabilities-label">Capabilities:</span>
                  <div className="capabilities-badges">
                    {Object.entries(selectedEngineData.capabilities).map(([cap, value]) => {
                      const valueStr = Array.isArray(value) 
                        ? value.map(v => v === '*' ? '* (any)' : String(v)).join(', ')
                        : typeof value === 'object' && value !== null
                        ? `${Object.keys(value).length} options`
                        : String(value);
                      
                      // Format capability name: replace _ with space and capitalize first letter
                      const formattedCap = cap.replace(/_/g, ' ');
                      const displayCap = formattedCap.charAt(0).toUpperCase() + formattedCap.slice(1);
                      
                      return (
                        <Badge 
                          key={cap} 
                          variant="accent" 
                          size="sm"
                          title={`${displayCap}: ${valueStr}`}
                        >
                          {displayCap}
                        </Badge>
                      );
                    })}
                  </div>
                </div>
              )}
            </Card>

            {/* Instance Editor */}
            <div className="editor-section">
              <label className="editor-label">Instance (JSON)</label>
              <CodeEditor
                value={inputJson}
                onChange={setInputJson}
                minHeight="300px"
                maxHeight="500px"
              />
            </div>

            {/* Solver Options */}
            <div className="editor-section">
              <div className="options-header">
                <label className="editor-label">Solver Options</label>
                <div className="options-toggles">
                  <label className="toggle-label">
                    <input
                      type="checkbox"
                      checked={sendOptions}
                      onChange={(e) => setSendOptions(e.target.checked)}
                    />
                    <span>Enable</span>
                  </label>
                  <label className="toggle-label">
                    <input
                      type="checkbox"
                      checked={verbose}
                      onChange={(e) => setVerbose(e.target.checked)}
                    />
                    <span>Verbose</span>
                  </label>
                </div>
              </div>
              
              {sendOptions && (
                <CodeEditor
                  value={solverOptions}
                  onChange={setSolverOptions}
                  minHeight="100px"
                  maxHeight="200px"
                />
              )}
            </div>

            {/* Action Buttons */}
            <div className="action-buttons">
              <Button
                variant="secondary"
                onClick={handleAnalyze}
                disabled={jobState === 'validating' || jobState === 'running' || jobState === 'queued'}
                fullWidth
                title="Validate the instance and analyze the binding space without solving. Returns warnings and diagnostics."
              >
                Analyze
              </Button>
              <Button
                variant="primary"
                onClick={handleSolve}
                disabled={jobState === 'validating' || jobState === 'running' || jobState === 'queued'}
                fullWidth
                title="Validate, analyze and solve the composition problem. Returns solutions, diagnostics (if verbose), and warnings."
              >
                {jobState === 'queued' ? 'Queued...' : jobState === 'running' ? 'Solving...' : 'Solve'}
              </Button>
            </div>
          </div>
        </div>

        {/* Output Panel */}
        <div className="playground-panel playground-output">
          <div className="panel-header">
            <h2>Output</h2>
            <div className="status-indicator">
              <Badge
                variant={
                  jobState === 'completed' ? 'success' :
                  jobState === 'failed' ? 'error' :
                  jobState === 'running' || jobState === 'queued' ? 'info' :
                  'default'
                }
              >
                {jobState.charAt(0).toUpperCase() + jobState.slice(1)}
              </Badge>
            </div>
          </div>

          <div className="panel-content">
            {error && (
              <Alert type="error" title="Error">
                {error}
              </Alert>
            )}

            {!result && !error && jobState === 'idle' && (
              <div className="empty-state">
                <div className="empty-state-icon">🎯</div>
                <h3>Ready to Start</h3>
                <p>Configure your instance and click Analyze or Solve to begin</p>
              </div>
            )}

            {(jobState === 'validating' || jobState === 'queued' || jobState === 'running') && (
              <div className="loading-state">
                <div className="loading-spinner"></div>
                <p>
                  {jobState === 'validating' ? 'Validating...' :
                   jobState === 'queued' ? 'Job queued...' :
                   'Solving...'}
                </p>
              </div>
            )}

            {result && (
              <Tabs
                tabs={[
                  {
                    id: 'summary',
                    label: 'Summary',
                    content: <SummaryView result={result} />
                  },
                  {
                    id: 'solutions',
                    label: 'Solutions',
                    badge: result.solutions?.length || 0,
                    content: <SolutionsView result={result} />
                  },
                  {
                    id: 'binding-space',
                    label: 'Binding Space',
                    content: <BindingSpaceView result={result} />
                  },
                  {
                    id: 'violations',
                    label: 'Violations',
                    badge: result.errors?.length || result.violations?.length || 0,
                    content: <ViolationsView result={result} />
                  },
                  {
                    id: 'warnings',
                    label: 'Warnings',
                    badge: result.warnings?.length || 0,
                    content: <WarningsView result={result} />
                  },
                  {
                    id: 'raw',
                    label: 'Raw JSON',
                    content: <RawView result={result} />
                  }
                ]}
                defaultTab="summary"
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Result View Components
function SummaryView({ result }: { result: any }) {
  return (
    <div className="result-view summary-view">
      {result.status && (
        <Card padding="md">
          <div className="summary-item">
            <span className="summary-label">Status:</span>
            <Badge variant={result.status === 'validated' || result.status === 'completed' ? 'success' : 'error'}>
              {result.status}
            </Badge>
          </div>
        </Card>
      )}

      {result.binding_space && (
        <Card padding="md">
          <h4>Binding Space Analysis</h4>
          <div className="summary-grid">
            <div className="summary-item">
              <span className="summary-label">Cardinality:</span>
              <span className="summary-value">{result.binding_space.cardinality}</span>
            </div>
            <div className="summary-item">
              <span className="summary-label">Log10 Size:</span>
              <span className="summary-value">~{result.binding_space.log10_cardinality?.toFixed(2)}</span>
            </div>
          </div>
          {result.binding_space.empty_tasks?.length > 0 && (
            <Alert type="warning" title="Empty Tasks">
              {result.binding_space.empty_tasks.length} task(s) have zero candidates
            </Alert>
          )}
        </Card>
      )}

      {result.aggregated_qos && (
        <Card padding="md">
          <h4>Aggregated QoS</h4>
          <div className="qos-grid">
            {Object.entries(result.aggregated_qos).map(([key, value]) => (
              <div key={key} className="qos-item">
                <span className="qos-label">{key}:</span>
                <span className="qos-value">{String(value)}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {result.provenance && (
        <Card padding="md">
          <h4>Provenance</h4>
          <div className="summary-grid">
            {result.provenance.engine_id && (
              <div className="summary-item">
                <span className="summary-label">Engine:</span>
                <span className="summary-value">{result.provenance.engine_id}</span>
              </div>
            )}
            {result.provenance.execution_time_ms !== undefined && (
              <div className="summary-item">
                <span className="summary-label">Execution Time:</span>
                <span className="summary-value">{result.provenance.execution_time_ms}ms</span>
              </div>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}

function SolutionsView({ result }: { result: any }) {
  if (!result.solutions || result.solutions.length === 0) {
    return (
      <div className="empty-result">
        <p>No solutions found in the result</p>
      </div>
    );
  }

  return (
    <div className="result-view solutions-view">
      {result.solutions.map((solution: any, index: number) => (
        <Card key={index} padding="md">
          <h4>Solution {index + 1}</h4>
          {solution.binding && (
            <div className="binding-table">
              <table>
                <thead>
                  <tr>
                    <th>Task</th>
                    <th>Candidate</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(solution.binding).map(([task, candidate]) => (
                    <tr key={task}>
                      <td><code>{task}</code></td>
                      <td><code>{String(candidate)}</code></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {solution.aggregated_qos && (
            <div className="solution-qos">
              <strong>QoS Metrics:</strong>
              <div className="qos-grid">
                {Object.entries(solution.aggregated_qos).map(([key, value]) => (
                  <div key={key} className="qos-item">
                    <span className="qos-label">{key}:</span>
                    <span className="qos-value">{String(value)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}

function ViolationsView({ result }: { result: any }) {
  const violations = result.violations || result.errors || [];

  if (violations.length === 0) {
    return (
      <div className="empty-result">
        <Alert type="success" title="No Violations">
          The instance passed all validation stages
        </Alert>
      </div>
    );
  }

  return (
    <div className="result-view violations-view">
      {violations.map((violation: any, index: number) => (
        <Card key={index} padding="md" className="violation-card">
          <div className="violation-header">
            <Badge variant="error">{violation.code || 'ERROR'}</Badge>
            {violation.stage && <Badge variant="default">Stage: {violation.stage}</Badge>}
          </div>
          <p className="violation-message">{violation.message}</p>
          {violation.path && (
            <div className="violation-path">
              <span>Path: </span>
              <code>{violation.path}</code>
            </div>
          )}
          {violation.constraint_id && (
            <div className="violation-constraint">
              <span>Constraint: </span>
              <code>{violation.constraint_id}</code>
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}

function BindingSpaceView({ result }: { result: any }) {
  // Binding space can be in result.binding_space (from analyze)
  // or in result.diagnostics.binding_space (from solve with verbose=true)
  const bindingSpace = result.binding_space || result.diagnostics?.binding_space;

  if (!bindingSpace) {
    return (
      <div className="empty-result">
        <Alert type="info" title="No Binding Space Data">
          {result.solutions ? 
            'Enable verbose mode to see binding space diagnostics when solving.' :
            'Binding space data not available. Run Analyze or Solve with verbose mode.'}
        </Alert>
      </div>
    );
  }

  return (
    <div className="result-view binding-space-view">
      <Card padding="lg">
        <h3>Binding Space Analysis</h3>
        
        <div className="binding-space-metrics">
          <div className="metric-card">
            <span className="metric-label">Total Cardinality</span>
            <span className="metric-value">{bindingSpace.cardinality}</span>
            <span className="metric-subtitle">Total possible bindings</span>
          </div>
          
          <div className="metric-card">
            <span className="metric-label">Log₁₀ Cardinality</span>
            <span className="metric-value">{bindingSpace.log10_cardinality?.toFixed(2)}</span>
            <span className="metric-subtitle">Logarithmic scale</span>
          </div>
        </div>

        {bindingSpace.empty_tasks && bindingSpace.empty_tasks.length > 0 && (
          <Alert type="warning" title="Empty Tasks Detected">
            The following tasks have no candidate services: {bindingSpace.empty_tasks.join(', ')}
          </Alert>
        )}

        <div className="per-task-counts">
          <h4>Candidates Per Task</h4>
          <div className="task-counts-grid">
            {Object.entries(bindingSpace.per_task_counts || {}).map(([taskId, count]) => (
              <div key={taskId} className="task-count-item">
                <span className="task-id">{taskId}</span>
                <Badge variant={(count as number) === 0 ? 'error' : 'success'} size="sm">
                  {String(count)} candidate{(count as number) !== 1 ? 's' : ''}
                </Badge>
              </div>
            ))}
          </div>
        </div>
      </Card>
    </div>
  );
}

function WarningsView({ result }: { result: any }) {
  const warnings = result.warnings || [];

  if (warnings.length === 0) {
    return (
      <div className="empty-result">
        <Alert type="success" title="No Warnings">
          No warnings were generated
        </Alert>
      </div>
    );
  }

  return (
    <div className="result-view warnings-view">
      {warnings.map((warning: any, index: number) => (
        <Card key={index} padding="md" className="warning-card">
          <div className="warning-header">
            <Badge variant="warning">{warning.code || 'WARNING'}</Badge>
          </div>
          <p className="warning-message">{warning.message}</p>
          {warning.details && (
            <details className="warning-details">
              <summary>Details</summary>
              <pre>{JSON.stringify(warning.details, null, 2)}</pre>
            </details>
          )}
        </Card>
      ))}
    </div>
  );
}

function RawView({ result }: { result: any }) {
  return (
    <div className="result-view raw-view">
      <pre>{JSON.stringify(result, null, 2)}</pre>
    </div>
  );
}
