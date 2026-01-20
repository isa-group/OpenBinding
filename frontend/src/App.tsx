import { useState, useEffect, useRef } from 'react';
import Ajv from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import universalSchema from './schemas/universal.json';
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
  /* 
    Default JSON is now just the instance structure.
    Engine selection is handled by the UI.
  */
  const [inputJson, setInputJson] = useState<string>('{\n  "metadata": { "id": "test" },\n  "tasks": [],\n  "candidates": [],\n  "composition": {}\n}');
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchEngines();
    // Default to light as requested
    document.documentElement.setAttribute('data-theme', 'light');
  }, []);

  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
    document.documentElement.setAttribute('data-theme', newTheme);
  };

  // Validator reference to persist across renders until schema changes
  const validateRef = useRef<any>(null);

  // Initialize universal validator as fallback
  useEffect(() => {
      const v = ajv.compile(universalSchema);
      validateRef.current = v;
  }, []);

  const fetchEngines = async () => {
    try {
      const res = await fetch('http://localhost:8000/v1/engines');
      const data = await res.json();
      setEngines(data);
      if (data.length > 0) setSelectedEngine(data[0].id);
    } catch (err) {
      console.error("Failed to fetch engines", err);
      setEngines([]);
      setSelectedEngine('');
    }
  };

  // Fetch schema when engine changes
  useEffect(() => {
      if (!selectedEngine) return;
      
      const loadSchema = async () => {
          try {
              console.log(`Fetching schema for ${selectedEngine}...`);
              const res = await fetch(`http://localhost:8000/v1/schemas/${selectedEngine}`);
              if (!res.ok) {
                  console.warn(`Could not fetch schema for ${selectedEngine}, using universal only.`);
                  validateRef.current = ajv.compile(universalSchema);
                  return;
              }
              const schema = await res.json();
              console.log(`Loaded schema for ${selectedEngine}`);
              
              // We need to re-compile AJV. 
              // Note: AJV might cache schemas by ID. If we use same ID, remove it first.
              if (schema.$id && ajv.getSchema(schema.$id)) {
                  ajv.removeSchema(schema.$id);
              }
              
              validateRef.current = ajv.compile(schema);
              
          } catch (e) {
              console.error("Schema load failed", e);
              validateRef.current = ajv.compile(universalSchema);
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
        // If file contains engine_id, warn or just strip it? 
        // User wants separation. Let's extract instance.
        const instance = parsed.instance || parsed; // Handle both full envelope and raw instance
        setInputJson(JSON.stringify(instance, null, 2));
        setError(null);
      } catch (err) {
        setError("Invalid JSON file");
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
        throw new Error("Invalid JSON");
      }

      // Frontend Validation with Dynamic Schema
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
          instance: instance
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
      
      // Handle Job Response
      if (data.status === 'failed') {
           // Immediate failure (e.g. Validation Error)
           setResult(data.result || { errors: [{ message: data.error, code: "job_failed" }] });
           setLoading(false);
      } else if (res.status === 202) {
          const jobId = data.job_id;
          pollJob(jobId);
      } else if (data.errors) {
          // Sync validation error or failed job returned immediately (bad request pattern)
          setResult(data); 
          setLoading(false);
      } else {
           // Fallback
           setResult(data);
           setLoading(false);
      }

    } catch (err: any) {
        setError(err.message);
        setLoading(false);
    }
  };

  const pollJob = async (jobId: string) => {
      try {
          const res = await fetch(`http://localhost:8000/v1/jobs/${jobId}`);
          
          if (!res.ok) {
              throw new Error(`Job lookup failed: ${res.status} ${res.statusText}`);
          }

          const data = await res.json();
          
          if (data.status === 'completed') {
              setResult(data.result);
              setLoading(false);
          } else if (data.status === 'failed') {
              setError(data.error || "Job failed");
               if (data.result) setResult(data.result); // Might contain detailed errors
              setLoading(false);
          } else {
              // Still running or queued
              setTimeout(() => pollJob(jobId), 1000); // Poll every 1s
          }
      } catch (err: any) {
          setError("Polling failed: " + err.message);
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
                {loading ? 'Solving...' : 'Ready to solve!'}
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

             <button className="btn" onClick={handleSolve} disabled={loading}>
               {loading ? 'Solving...' : 'Solve Instance'}
             </button>
          </div>
          <div className="pane-header">Input Instance (JSON)</div>
          <textarea 
            value={inputJson} 
            onChange={(e) => setInputJson(e.target.value)}
            spellCheck={false}
          />
        </div>
        
        <div className="result-pane">
           <div className="pane-header">Solution / Output</div>
           <div className="result-view">
             {error && (
                <div className="status-badge status-error">
                   Error: {error}
                </div>
             )}
             
             {result && result.errors && (
                 <div className="status-badge status-error">
                    Validation Failed ({result.errors.length} errors)
                 </div>
             )}
             
             {result && !result.errors && (
                  <div className="status-badge status-success">
                     Solved Successfully
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
