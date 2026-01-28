import { useState, useEffect, useRef } from 'react';
import Ajv from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import './index.css';

interface Engine {
  id: string;
  capabilities: any;
}

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);

function App() {
  const [engines, setEngines] = useState<Engine[]>([]);
  const [selectedEngine, setSelectedEngine] = useState<string>('');
  
  // We start with a basic template for the problem instance.
  const [inputJson, setInputJson] = useState<string>('{\n  "metadata": { "id": "test" },\n  "tasks": [],\n  "candidates": [],\n  "composition": {}\n}');
  const [solverOptions, setSolverOptions] = useState<string>('{\n  "iterations_count": 1000\n}');
  const [sendOptions, setSendOptions] = useState(true);
  const [verbose, setVerbose] = useState(false);
  
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // We keep the validator in a ref so we don't re-compile AJV on every render.
  const validateRef = useRef<any>(null);
  const generalSchemaRef = useRef<any>(null);

  useEffect(() => {
    fetchEngines();
    fetchGeneralSchema();
    // Default to light mode as it's the most readable for most users.
    document.documentElement.setAttribute('data-theme', 'light');
  }, []);

  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
    document.documentElement.setAttribute('data-theme', newTheme);
  };

  const fetchEngines = async () => {
    try {
      const res = await fetch('http://localhost:8000/v1/engines');
      const data = await res.json();
      setEngines(data);
      if (data.length > 0) setSelectedEngine(data[0].id);
    } catch (err) {
      console.error("Couldn't reach the gateway to list engines.", err);
      setEngines([]);
      setSelectedEngine('');
    }
  };

  const fetchGeneralSchema = async () => {
      try {
          const res = await fetch('http://localhost:8000/v1/schemas/general');
          if (!res.ok) throw new Error("Gateway didn't provide the general schema.");
          const schema = await res.json();
          generalSchemaRef.current = schema;
          validateRef.current = ajv.compile(schema);
          console.log("General QoS schema loaded from gateway.");
      } catch (err) {
          console.error("Failed to load base schema. Validation might be limited.", err);
      }
  };

  // When the user picks a different engine, we try to load its specific constraints.
  useEffect(() => {
      if (!selectedEngine) return;
      
      const loadSchema = async () => {
          try {
              console.log(`Checking specialized constraints for ${selectedEngine}...`);
              const res = await fetch(`http://localhost:8000/v1/schemas/${selectedEngine}`);
              
              if (!res.ok) {
                  console.warn(`No specialized schema for ${selectedEngine}, falling back to general.`);
                  if (generalSchemaRef.current) {
                      validateRef.current = ajv.compile(generalSchemaRef.current);
                  }
                  return;
              }
              
              const schema = await res.json();
              
              // Remove old cached version from AJV if it exists.
              if (schema.$id && ajv.getSchema(schema.$id)) {
                  ajv.removeSchema(schema.$id);
              }
              
              validateRef.current = ajv.compile(schema);
              console.log(`Loaded specific schema for ${selectedEngine}`);
              
          } catch (e) {
              console.error("Specialized schema load failed.", e);
              if (generalSchemaRef.current) {
                  validateRef.current = ajv.compile(generalSchemaRef.current);
              }
          }
      };
      
      loadSchema();
  }, [selectedEngine]);

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target?.result as string;
      try {
        const parsed = JSON.parse(content);
        // Extracts the instance part even if the whole envelope was uploaded.
        const instance = parsed.instance || parsed; 
        setInputJson(JSON.stringify(instance, null, 2));
        setError(null);
      } catch (err) {
        setError("That doesn't look like valid JSON.");
      }
    };
    reader.readAsText(file);
    event.target.value = '';
  };

  const handleSolve = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    
    try {
      let instance;
      try {
        instance = JSON.parse(inputJson);
      } catch (e) {
        throw new Error("Invalid Instance JSON");
      }

      let options = {};
      if (sendOptions) {
        try {
            options = JSON.parse(solverOptions);
        } catch (e) {
            throw new Error("Check your solver options JSON syntax.");
        }
      }

      // We run a quick check here before bothering the backend.
      if (validateRef.current) {
         const valid = validateRef.current(instance);
         if (!valid) {
             const errors = validateRef.current.errors?.map((e: any) => ({
                 message: e.message,
                 path: e.instancePath,
                 code: "frontend_validation_error"
             })) || [];
             
             setResult({
                 errors: errors
             });
             setLoading(false);
             return; 
         }
      }

      // Construct Payload
      const payload = {
          engine_id: selectedEngine,
          instance: instance,
          options: options,
          verbose: verbose
      };

      const res = await fetch('http://localhost:8000/v1/solve', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      
      const data = await res.json();
      console.log("Job Response:", res.status, data);
      
      if (data.status === 'failed') {
           setResult(data.result || { errors: [{ message: data.error, code: "job_failed" }] });
           setLoading(false);
      } else if (res.status === 202) {
          // Accepted! Now we poll until the engine finishes.
          const jobId = data.job_id;
          pollJob(jobId);
      } else if (data.errors) {
          setResult(data); 
          setLoading(false);
      } else {
           setResult(data);
           setLoading(false);
      }

    } catch (err: any) {
        setError(err.message);
        setLoading(false);
    }
  };

  const handleAnalyze = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    
    try {
      const instance = JSON.parse(inputJson);

      const payload = {
          engine_id: selectedEngine,
          instance: instance,
          options: sendOptions ? JSON.parse(solverOptions) : {},
          verbose: verbose
      };

      const res = await fetch('http://localhost:8000/v1/analyze', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      
      const data = await res.json();
      // Analyze returns the full diagnostic report directly.
      setResult(data);
      setLoading(false);

    } catch (err: any) {
        setError(err.message);
        setLoading(false);
    }
  };

  const pollJob = async (jobId: string) => {
      try {
          const res = await fetch(`http://localhost:8000/v1/jobs/${jobId}`);
          
          if (!res.ok) {
              throw new Error(`The gateway lost track of the job: ${res.status}`);
          }

          const data = await res.json();
          
          if (data.status === 'completed') {
              setResult(data.result);
              setLoading(false);
          } else if (data.status === 'failed') {
              setError(data.error || "The engine reported a failure.");
               if (data.result) setResult(data.result); 
              setLoading(false);
          } else {
              // Still cooking...
              setTimeout(() => pollJob(jobId), 1000); 
          }
      } catch (err: any) {
          setError("Check your connection: " + err.message);
          setLoading(false);
      }
  };

  return (
    <>
      <header className="header">
        <div className="logo-container">
            <img src={theme === 'light' ? "/logo-light.png" : "/logo.png"} alt="OpenBinding" className="logo-img" />
            <div className="logo">OpenBinding</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <div className="status">
                {loading ? 'Processing...' : 'Ready'}
            </div>
            <button 
                className="btn btn-secondary" 
                onClick={toggleTheme}
                title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
            >
                {theme === 'light' ? '🌙' : '☀️'}
            </button>
        </div>
      </header>
      
      <main className="main">
        <div className="editor-pane">
          <div className="toolbar">
             <select 
                value={selectedEngine} 
                onChange={(e) => setSelectedEngine(e.target.value)}
             >
                {engines.map(e => <option key={e.id} value={e.id}>{e.id}</option>)}
             </select>
             
             <input 
                type="file" 
                ref={fileInputRef} 
                style={{ display: 'none' }} 
                accept=".json"
                onChange={handleFileUpload}
             />
             <button className="btn btn-secondary" onClick={() => fileInputRef.current?.click()}>
                Upload JSON
             </button>

             <div style={{ flex: 1 }}></div>

             <button className="btn btn-secondary" onClick={handleAnalyze} disabled={loading} style={{ marginRight: '8px' }}>
               Analyze
             </button>

             <button className="btn" onClick={handleSolve} disabled={loading}>
               {loading ? 'Solving...' : 'Solve'}
             </button>
          </div>
          <div className="pane-header">Input Instance (JSON)</div>
          <textarea 
            className="json-editor"
            value={inputJson} 
            onChange={(e) => setInputJson(e.target.value)}
            spellCheck={false}
          />
          <div className="pane-header" style={{ marginTop: '10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
             <span>Solver Options (JSON)</span>
             <div style={{ display: 'flex', gap: '10px', fontSize: '0.9em' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
                    <input type="checkbox" checked={sendOptions} onChange={e => setSendOptions(e.target.checked)} />
                    Enable
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
                    <input type="checkbox" checked={verbose} onChange={e => setVerbose(e.target.checked)} />
                    Verbose
                </label>
             </div>
          </div>
          {sendOptions && (
            <textarea 
                className="options-editor"
                style={{ height: '100px', fontFamily: 'monospace' }}
                value={solverOptions} 
                onChange={(e) => setSolverOptions(e.target.value)}
                spellCheck={false}
            />
          )}
        </div>
        
        <div className="result-pane">
           <div className="pane-header">Output</div>
           <div className="result-view">
             {error && (
                <div className="status-badge status-error">
                   Error: {error}
                </div>
             )}
             
             {result && result.status === 'validated' && (
                  <div className="status-badge status-success">
                     Validation Successful
                  </div>
             )}

             {result && result.status === 'failed' && (
                  <div className="status-badge status-error">
                     Validation Failed
                  </div>
             )}
             
             {result && result.errors && (
                 <div className="status-badge status-error">
                    Validation Failed ({result.errors.length} errors)
                 </div>
             )}
             
             {result && !result.errors && !result.status && (
                  <div className="status-badge status-success">
                     Solved Successfully
                  </div>
             )}

             {result && result.binding_space && (
                 <div className="card" style={{ marginTop: '1em', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)' }}>
                     <h4>Binding Space Analysis</h4>
                     <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', fontSize: '0.9em' }}>
                         <div><strong>Cardinality:</strong> <br/> {result.binding_space.cardinality}</div>
                         <div><strong>Log10 Size:</strong> <br/> ~{result.binding_space.log10_cardinality.toFixed(2)}</div>
                     </div>
                     {result.binding_space.empty_tasks?.length > 0 && (
                         <div style={{ marginTop: '10px', color: 'var(--error-color)' }}>
                             <strong>⚠️ Empty Tasks (0 candidates):</strong>
                             <ul style={{ margin: '5px 0' }}>
                                 {result.binding_space.empty_tasks.map((t: string) => <li key={t}>{t}</li>)}
                             </ul>
                         </div>
                     )}
                 </div>
             )}
             
             {result && result.warnings && result.warnings.length > 0 && (
                 <div className="card" style={{ marginTop: '1em', background: '#fff3cd', color: '#856404', border: '1px solid #ffeeba' }}>
                     <h4>Warnings</h4>
                     <ul style={{ paddingLeft: '20px' }}>
                         {result.warnings.map((w: any, i: number) => (
                             <li key={i}><strong>{w.code}:</strong> {w.message}</li>
                         ))}
                     </ul>
                 </div>
             )}

             {result && (
                <pre>{JSON.stringify(result, null, 2)}</pre>
             )}
           </div>
        </div>
      </main>
    </>
  )
}

export default App
