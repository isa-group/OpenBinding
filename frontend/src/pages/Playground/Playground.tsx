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
import { BindingSpaceExplorer } from '../../components/BindingSpaceExplorer/BindingSpaceExplorer';
import { TraceChart } from '../../components/TraceChart/TraceChart';
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

const EMPTY_OPTIONS = `{}\n`;

type JobState = 'idle' | 'validating' | 'queued' | 'running' | 'completed' | 'failed';

// Available examples in /examples directory
const AVAILABLE_EXAMPLES = {
  'Demo Examples': [
    'demo/01_simple_seq.json',
    'demo/02_parallel.json',
    'demo/03_xor_choice.json',
    'demo/04_conflict.json',
    'demo/05_single_obj_various.json',
    'demo/06_loops.json',
    'demo/07_soft_constraints.json',
    'demo/08_dependencies.json',
    'demo/09_mixed.json',
    'demo/10_large_scale.json',
    'demo/11_multi_obj_negative.json',
    'demo/12_many_obj_pareto.json',
    'demo/13_fms.json'
  ],
  'Literature Examples': [
    'literature/benatallah.json',
    'literature/bultan.json',
    'literature/cremaschi.json',
    'literature/netedu.json',
    'literature/pautasso.json',
    'literature/zhang.json'
  ],
  'Placement (BIM*)': [
    'placement/01_small_placement.json',
    'placement/02_stock_market_sample.json'
  ]
};

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
  const [currentInstance, setCurrentInstance] = useState<any>(null);
  
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

  useEffect(() => {
    if (!selectedEngine) return;

    // Keep the options editor in sync with the selected engine.
    // If the engine has no options defaults, show an empty object.
    const loadDefaultOptions = async () => {
      try {
        const defaults = await apiClient.getEngineDefaultOptions(selectedEngine);
        const normalized = (defaults && typeof defaults === 'object' && !Array.isArray(defaults)) ? defaults : {};
        const keys = Object.keys(normalized);
        setSolverOptions(keys.length > 0 ? `${JSON.stringify(normalized, null, 2)}\n` : EMPTY_OPTIONS);
      } catch (err) {
        console.warn(`Failed to load default options for engine '${selectedEngine}', using empty options`, err);
        setSolverOptions(EMPTY_OPTIONS);
      }
    };

    loadDefaultOptions();
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
      const cacheBuster = Date.now();
      const response = await fetch(`/examples/${exampleFile}?v=${cacheBuster}`, {
        cache: 'no-store',
      });
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
      setCurrentInstance(instance);
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

  /**
   * Inspects a solve result for anomalies: empty solutions, empty bindings, etc.
   * Sets user-facing warnings/errors so issues are visible in the UI.
   */
  const checkAndWarnEmptyResult = (solveResult: any) => {
    if (!solveResult) return;

    const solutions = solveResult.solutions;

    // No solutions at all
    if (!solutions || solutions.length === 0) {
      setError(
        'The solver returned no solutions. The instance may be infeasible under the current constraints, ' +
        'or the engine did not find any feasible binding within the given budget.'
      );
      return;
    }

    // Check for solutions with empty or missing bindings
    const emptyBindingSolutions = solutions.filter(
      (s: any) => !s.binding || Object.keys(s.binding).length === 0
    );

    if (emptyBindingSolutions.length > 0) {
      setError(
        `${emptyBindingSolutions.length} solution(s) have an empty binding — this likely indicates ` +
        'an engine bug or an unsupported instance structure. Please report this instance to the administrator ' +
        'so it can be investigated.'
      );
    }
  };

  const handleSolve = async () => {
    setJobState('validating');
    setError(null);
    setResult(null);

    try {
      const instance = JSON.parse(inputJson);
      setCurrentInstance(instance);
      
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

      // Handle synchronous failure (engine returned error directly)
      if (jobResponse.status === 'failed') {
        setResult(jobResponse.result || { error: jobResponse.error || 'The solver could not process this instance.' });
        setJobState('failed');
        return;
      }

      // Handle synchronous completion (engine returned solution directly, no polling needed)
      if (jobResponse.status === 'completed') {
        const syncResult = jobResponse.result;
        if (syncResult) {
          checkAndWarnEmptyResult(syncResult);
        }
        setResult(syncResult || { solutions: [], _warning: 'The engine returned an empty response.' });
        setJobState('completed');
        return;
      }

      // Asynchronous job: poll for completion
      setJobState('running');
      const finalResult = await apiClient.pollJob(
        jobResponse.job_id,
        (status: JobStatus) => {
          if (status.status === 'running') {
            setJobState('running');
          }
        }
      );

      if (finalResult) {
        checkAndWarnEmptyResult(finalResult);
      }
      setResult(finalResult || { solutions: [], _warning: 'The engine returned an empty response.' });
      setJobState('completed');
    } catch (err: any) {
      const message = err.message || 'Solve failed';
      // Provide user-friendly messages for common errors
      if (message.includes('HTTP 404')) {
        setError('The solver job could not be found. The engine may have completed synchronously or restarted. Please try again.');
      } else if (message.includes('timed out') || message.includes('Polling timed out')) {
        setError('The solver is taking longer than expected. The instance may be very large or the engine may be overloaded. Try reducing the problem size or iterations count.');
      } else if (message.includes('HTTP 502') || message.includes('HTTP 503') || message.includes('HTTP 504')) {
        setError('The solver engine is temporarily unavailable. Please check that the engine is running and try again.');
      } else if (message.includes('Failed to fetch') || message.includes('NetworkError')) {
        setError('Could not connect to the API gateway. Please check your network connection and ensure the server is running.');
      } else if (message.includes('JSON')) {
        setError('Invalid JSON in the instance or options editor. Please check the syntax and try again.');
      } else {
        setError(message);
      }
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
                {Object.entries(AVAILABLE_EXAMPLES).map(([category, examples]) => (
                  <optgroup key={category} label={category}>
                    {examples.map(ex => {
                      const fileName = ex.split('/')[1].replace('.json', '');
                      // Format: "01_simple_seq" -> "01 - Simple Seq"
                      const displayName = fileName
                        .replace(/_/g, ' ')
                        .split(' ')
                        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                        .join(' ')
                        .replace(/^(\d+) /, '$1 - ');
                      return (
                        <option key={ex} value={ex}>
                          {displayName}
                        </option>
                      );
                    })}
                  </optgroup>
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

            {/* Engine Options */}
            <div className="editor-section">
              <div className="options-header">
                <label className="editor-label">Engine Options</label>
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
                    id: 'trace',
                    label: 'Trace',
                    badge: Array.isArray(result?.provenance?.metadata?.trace)
                      ? result.provenance.metadata.trace.length
                      : 0,
                    content: (
                      <div className="result-view">
                        <TraceChart
                          trace={result?.provenance?.metadata?.trace}
                          engineId={result?.provenance?.engine_id || selectedEngine}
                        />
                      </div>
                    )
                  },
                  {
                    id: 'binding-space',
                    label: 'Binding Space',
                    content: <BindingSpaceView result={result} engineId={selectedEngine} instance={currentInstance} />
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
  const solutions = result.solutions || [];
  const feasibility = result.feasibility;
  const emptyBindings = solutions.filter(
    (s: any) => !s.binding || Object.keys(s.binding).length === 0
  );
  const infeasibleCount = feasibility === 'INFEASIBLE' ? 1 : 0;
  const unknownCount = feasibility === 'UNKNOWN' ? 1 : 0;

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
          {feasibility && (
            <div className="summary-item" style={{ marginTop: '8px' }}>
              <span className="summary-label">Feasibility:</span>
              <Badge variant={feasibility === 'FEASIBLE' ? 'success' : feasibility === 'INFEASIBLE' ? 'warning' : 'accent'}>
                {feasibility}
              </Badge>
            </div>
          )}
        </Card>
      )}

      {/* Solution quality summary */}
      {solutions.length > 0 && (
        <Card padding="md">
          <h4>Solutions Overview</h4>
          <div className="summary-grid">
            <div className="summary-item">
              <span className="summary-label">Total Solutions:</span>
              <span className="summary-value">{solutions.length}</span>
            </div>
            {infeasibleCount > 0 && (
              <div className="summary-item">
                <span className="summary-label">Infeasible:</span>
                <span className="summary-value" style={{ color: 'var(--color-warning, #e6a700)' }}>{infeasibleCount}</span>
              </div>
            )}
            {unknownCount > 0 && (
              <div className="summary-item">
                <span className="summary-label">Unknown:</span>
                <span className="summary-value">{unknownCount}</span>
              </div>
            )}
          </div>
          {emptyBindings.length > 0 && (
            <Alert type="error" title="Engine Anomaly Detected">
              {emptyBindings.length} solution(s) returned with empty bindings. This is likely an engine bug.
              Please report this instance to the administrator for investigation.
            </Alert>
          )}
        </Card>
      )}

      {/* No solutions warning */}
      {result.solutions !== undefined && solutions.length === 0 && (
        <Card padding="md">
          {feasibility === 'INFEASIBLE' ? (
            <Alert type="warning" title="Infeasible Instance">
              The engine completed and reported the instance as INFEASIBLE.
            </Alert>
          ) : (
            <Alert type="warning" title="No Solutions Found">
              The engine completed without a non-empty binding. For heuristic engines this usually means
              the execution budget was insufficient.
            </Alert>
          )}
        </Card>
      )}

      {/* Internal warning (e.g. empty engine response) */}
      {result._warning && (
        <Card padding="md">
          <Alert type="warning" title="Warning">
            {result._warning}
          </Alert>
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
            {result.provenance.metadata?.status && (
              <div className="summary-item">
                <span className="summary-label">Solver Status:</span>
                <Badge
                  variant={
                    result.provenance.metadata.status === 'OPTIMAL' ? 'success' :
                    result.provenance.metadata.status === 'SATISFIED' ? 'info' :
                    result.provenance.metadata.status === 'UNSATISFIABLE' ? 'warning' :
                    'default'
                  }
                  title={
                    result.provenance.metadata.status === 'OPTIMAL' ? 'Search completed with an optimality proof' :
                    result.provenance.metadata.status === 'SATISFIED' ? 'Time budget expired: best (unproven) incumbent returned' :
                    result.provenance.metadata.status === 'UNSATISFIABLE' ? 'Infeasibility proved: no assignment satisfies the hard constraints' :
                    'Budget expired before any incumbent was found'
                  }
                >
                  {result.provenance.metadata.status}
                </Badge>
              </div>
            )}
            {result.provenance.metadata?.seed !== undefined && result.provenance.metadata?.seed !== null && (
              <div className="summary-item">
                <span className="summary-label">Seed:</span>
                <span className="summary-value">{String(result.provenance.metadata.seed)}</span>
              </div>
            )}
            {result.provenance.metadata?.evaluations !== undefined && result.provenance.metadata?.evaluations !== null && (
              <div className="summary-item">
                <span className="summary-label">Evaluations:</span>
                <span className="summary-value">{String(result.provenance.metadata.evaluations)}</span>
              </div>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}

function SolutionsView({ result }: { result: any }) {
  // Determine if there's only one binding to show features expanded by default
  const solutions = result.solutions || [];
  const hasSingleSolution = solutions.length === 1;
  const [expandedSolutions, setExpandedSolutions] = useState<Record<number, boolean>>(
    hasSingleSolution ? { 0: true } : {}
  );

  // No solutions at all — explain possible causes
  if (solutions.length === 0) {
    const hasError = result.error || result._warning;
    const errorMsg = result.error || result._warning;

    return (
      <div className="result-view solutions-view">
        {hasError ? (
          <Alert type="warning" title="No Solutions Found">
            {errorMsg}
          </Alert>
        ) : (
          <Alert type="info" title="No Solutions">
            The solver did not return any solutions. Possible causes:
            <ul style={{ margin: '8px 0 0 16px', padding: 0 }}>
              <li>The instance may be infeasible under the current constraints.</li>
              <li>The solver budget (iterations / time) may be too low.</li>
              <li>A required task has no available candidates.</li>
            </ul>
          </Alert>
        )}
      </div>
    );
  }

  const toggleExpanded = (index: number) => {
    setExpandedSolutions(prev => ({
      ...prev,
      [index]: !prev[index]
    }));
  };

  // Count anomalies
  const emptyBindings = solutions.filter(
    (s: any) => !s.binding || Object.keys(s.binding).length === 0
  );

  return (
    <div className="result-view solutions-view">
      {emptyBindings.length > 0 && (
        <Alert type="error" title="Empty Binding Detected">
          {emptyBindings.length} of {solutions.length} solution(s) have an empty binding.
          This usually indicates an engine bug or an unsupported instance structure.
          Please report this instance to the administrator.
        </Alert>
      )}

      {solutions.map((solution: any, index: number) => {
        const isExpanded = expandedSolutions[index] || false;
        const hasAggregatedFeatures = solution.aggregated_features &&
          Object.keys(solution.aggregated_features).length > 0;
        const isBindingEmpty = !solution.binding || Object.keys(solution.binding).length === 0;
        // Prefer the per-solution reference-evaluator verdict (BIM* instances);
        // fall back to the response-level feasibility flag otherwise.
        const isInfeasible = solution.feasible === false ||
          (solution.feasible === undefined && result.feasibility === 'INFEASIBLE');
        const hasEngineObjective = solution.engine_objective_value !== undefined &&
          solution.engine_objective_value !== null;

        return (
          <Card key={index} padding="md">
            <div className="solution-header">
              <h4>Solution {index + 1}</h4>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                {solution.feasible === true && (
                  <Badge variant="success" title="Verified by the gateway reference evaluator: all hard constraints hold.">
                    Feasible
                  </Badge>
                )}
                {isInfeasible && (
                  <Badge variant="warning" title="The reference evaluator found violated hard constraints (best-effort anytime solution).">
                    Infeasible
                  </Badge>
                )}
                {isBindingEmpty && (
                  <Badge variant="error">Empty Binding</Badge>
                )}
                {solution.objective_value !== undefined && solution.objective_value !== null && (
                  <div
                    className="solution-objective"
                    title="Canonical objective: recomputed by the gateway reference evaluator from the returned binding (lower is better). Engine-independent, used for fair comparison."
                  >
                    <span className="objective-label">Objective:</span>
                    <span className="objective-value">{solution.objective_value.toFixed(4)}</span>
                  </div>
                )}
              </div>
            </div>

            {hasEngineObjective && (
              <div
                className="engine-objective-note"
                title="The engine's own internal search objective. It should match the canonical objective for feasible solutions (integrity audit)."
              >
                Engine-reported objective: <code>{Number(solution.engine_objective_value).toFixed(6)}</code>
              </div>
            )}

            {isBindingEmpty && (
              <Alert type="error" title="Empty Binding">
                This solution has no task-to-candidate assignments. This is unexpected and likely indicates
                an engine bug. Please save this instance and report it to the administrator.
              </Alert>
            )}

            {isInfeasible && !isBindingEmpty && (
              <Alert type="warning" title="Infeasible Solution">
                This is the engine's best-effort (anytime) solution: it violates one or more hard
                constraints. Check the Violations tab for details.
              </Alert>
            )}
            
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

            {hasAggregatedFeatures && (
              <div className="solution-features">
                <button
                  className="features-toggle"
                  onClick={() => toggleExpanded(index)}
                  aria-expanded={isExpanded}
                >
                  <span className="features-toggle-icon">{isExpanded ? '▼' : '▶'}</span>
                  <strong>Aggregated Features</strong>
                  <Badge variant="accent" size="sm">
                    {Object.keys(solution.aggregated_features).length} features
                  </Badge>
                </button>
                {isExpanded && (
                  <div className="features-content">
                    <div className="qos-grid">
                      {Object.entries(solution.aggregated_features).map(([key, value]) => (
                        <div key={key} className="qos-item">
                          <span className="qos-label">{key}:</span>
                          <span className="qos-value">{typeof value === 'number' ? value.toFixed(4) : String(value)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
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
        );
      })}
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

function BindingSpaceView({ result, engineId, instance }: { result: any; engineId: string; instance: any }) {
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

  // Extract tasks and candidates from instance
  const tasks = instance?.tasks || [];
  const candidates = instance?.candidates || [];

  if (tasks.length === 0 || candidates.length === 0) {
    return (
      <div className="empty-result">
        <Alert type="warning" title="Incomplete Data">
          Tasks or candidates data is missing from the instance. Make sure your instance includes both tasks and candidates arrays.
        </Alert>
      </div>
    );
  }

  return (
    <div className="result-view binding-space-view">
      {bindingSpace && (
        <Card padding="md" className="binding-space-summary">
          <h3>Binding Space Analysis</h3>
          <div className="binding-space-metrics">
            {bindingSpace.cardinality !== undefined && (
              <div className="metric-card">
                <div className="metric-label">Cardinality</div>
                <div className="metric-value">
                  {typeof bindingSpace.cardinality === 'number' && bindingSpace.cardinality < 1e6
                    ? bindingSpace.cardinality.toLocaleString()
                    : typeof bindingSpace.cardinality === 'number'
                    ? bindingSpace.cardinality.toExponential(2)
                    : bindingSpace.cardinality}
                </div>
                <div className="metric-subtitle">Total possible combinations</div>
              </div>
            )}
            {bindingSpace.log10_cardinality !== undefined && (
              <div className="metric-card">
                <div className="metric-label">Log10 Size</div>
                <div className="metric-value">
                  ~{typeof bindingSpace.log10_cardinality === 'number'
                    ? bindingSpace.log10_cardinality.toFixed(2)
                    : bindingSpace.log10_cardinality}
                </div>
                <div className="metric-subtitle">Logarithmic scale</div>
              </div>
            )}
            {bindingSpace.empty_tasks?.length > 0 && (
              <div className="metric-card">
                <div className="metric-label">Empty Tasks</div>
                <div className="metric-value" style={{ color: 'var(--color-warning)' }}>
                  {bindingSpace.empty_tasks.length}
                </div>
                <div className="metric-subtitle">Tasks with zero candidates</div>
              </div>
            )}
          </div>
          {bindingSpace.empty_tasks?.length > 0 && (
            <Alert type="warning" title="Warning">
              {bindingSpace.empty_tasks.length} task(s) have zero candidates: {bindingSpace.empty_tasks.join(', ')}
            </Alert>
          )}
        </Card>
      )}
      
      <BindingSpaceExplorer
        key={`${engineId}-${tasks.length}-${candidates.length}-${instance?.metadata?.id || 'instance'}`}
        engineId={engineId}
        instance={instance}
        tasks={tasks}
        candidates={candidates}
      />
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
