import { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  FileCode,
  FileText,
  HelpCircle,
  Play,
  RotateCcw,
  Sliders,
  Sparkles,
  Wand2,
  X,
} from 'lucide-react';
import {
  apiClient,
  type GenerateInstanceParams,
  type InstanceGeneratedResponse,
} from '../../api/client';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Alert } from '../../components/ui/Alert';
import type { WorkspaceFiles } from '../../utils/workspaceDraft';

interface InstanceGeneratorModalProps {
  isOpen: boolean;
  onClose: () => void;
  onLoadGeneratedFiles: (files: WorkspaceFiles, name: string, features?: Record<string, unknown>) => void;
}

export function InstanceGeneratorModal({
  isOpen,
  onClose,
  onLoadGeneratedFiles,
}: InstanceGeneratorModalProps) {
  const [activeTab, setActiveTab] = useState<'synthesize' | 'legacy'>('synthesize');

  // Synthesize Form State
  const [name, setName] = useState('generated_qaco');
  const [tasks, setTasks] = useState(10);
  const [candidates, setCandidates] = useState(5);
  const [controlFlow, setControlFlow] = useState(50);
  const [loops, setLoops] = useState(30);
  const [branches, setBranches] = useState(30);
  const [parallel, setParallel] = useState(20);
  const [maxNesting, setMaxNesting] = useState(3);
  const [iterationsPerLoop, setIterationsPerLoop] = useState(5);
  const [qosProperties, setQosProperties] = useState(5);
  const [constraints, setConstraints] = useState(1);
  const [tension, setTension] = useState(0.7);
  const [guaranteeFeasibility, setGuaranteeFeasibility] = useState(true);
  const [optimizationMode, setOptimizationMode] = useState<'weighted' | 'pareto'>('weighted');
  const [targetEngines, setTargetEngines] = useState<string[]>(['evolutionary-heuristics', 'minizinc-csp']);
  const [seed, setSeed] = useState<string>('');

  // Legacy Form State
  const [legacyText, setLegacyText] = useState('');
  const [legacyName, setLegacyName] = useState('converted_legacy');
  const [repairEmptyBranches, setRepairEmptyBranches] = useState(true);
  const [legacyFeasibility, setLegacyFeasibility] = useState(true);
  const [legacyTension, setLegacyTension] = useState(0.7);

  // Status & Feedback
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const estimatedScale = (tasks * Math.log10(candidates)).toFixed(1);

  const toggleEngine = (engine: string) => {
    setTargetEngines((prev) =>
      prev.includes(engine) ? prev.filter((e) => e !== engine) : [...prev, engine]
    );
  };

  const handleSynthesize = async () => {
    setBusy(true);
    setError(null);
    try {
      const parsedSeed = seed.trim() ? parseInt(seed.trim(), 10) : undefined;
      const params: GenerateInstanceParams = {
        name,
        tasks,
        candidates,
        control_flow: controlFlow,
        loops,
        branches,
        parallel,
        max_nesting: maxNesting,
        iterations_per_loop: iterationsPerLoop,
        qos_properties: qosProperties,
        constraints,
        tension,
        guarantee_feasibility: guaranteeFeasibility,
        optimization_mode: optimizationMode,
        target_engines: targetEngines,
        seed: isNaN(parsedSeed as number) ? undefined : parsedSeed,
      };

      const res = await apiClient.generateBimInstance(params);

      // Convert returned files into WorkspaceFiles strings
      const workspaceFiles: WorkspaceFiles = {};
      for (const [filename, content] of Object.entries(res.files)) {
        workspaceFiles[filename] =
          typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`;
      }

      onLoadGeneratedFiles(workspaceFiles, res.name, res.workload_features);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Instance synthesis failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleConvertLegacy = async () => {
    if (!legacyText.trim()) {
      setError('Please paste the legacy problem text to convert.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await apiClient.convertLegacyBimProblem({
        raw_text: legacyText,
        name: legacyName,
        repair_empty_branches: repairEmptyBranches,
        guarantee_feasibility: legacyFeasibility,
        tension: legacyTension,
      });

      const workspaceFiles: WorkspaceFiles = {};
      for (const [filename, content] of Object.entries(res.files)) {
        workspaceFiles[filename] =
          typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`;
      }

      onLoadGeneratedFiles(workspaceFiles, res.name, res.workload_features);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Legacy conversion failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="generator-modal-title"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.65)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: '1rem',
      }}
    >
      <div
        style={{
          backgroundColor: 'var(--color-surface)',
          borderRadius: '8px',
          width: '100%',
          maxWidth: '820px',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 12px 36px rgba(0, 0, 0, 0.4)',
          border: '1px solid var(--color-border)',
          overflow: 'hidden',
        }}
      >
        {/* Modal Header */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '1rem 1.25rem',
            borderBottom: '1px solid var(--color-border)',
            backgroundColor: 'var(--color-surface-subtle)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <Wand2 size={20} color="var(--color-primary)" />
            <h2 id="generator-modal-title" style={{ margin: 0, fontSize: '1.25rem' }}>
              QACO Instance Generator & Legacy Converter
            </h2>
            <Badge variant="info">BIM v1</Badge>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--color-muted)',
              cursor: 'pointer',
              padding: '0.25rem',
            }}
            aria-label="Close dialog"
          >
            <X size={18} />
          </button>
        </div>

        {/* Tab Navigation */}
        <div
          style={{
            display: 'flex',
            borderBottom: '1px solid var(--color-border)',
            backgroundColor: 'var(--color-surface)',
          }}
        >
          <button
            type="button"
            onClick={() => { setActiveTab('synthesize'); setError(null); }}
            style={{
              padding: '0.75rem 1.25rem',
              border: 'none',
              background: 'none',
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: '0.9rem',
              borderBottom: activeTab === 'synthesize' ? '2px solid var(--color-primary)' : '2px solid transparent',
              color: activeTab === 'synthesize' ? 'var(--color-primary)' : 'var(--color-muted)',
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
            }}
          >
            <Sparkles size={16} /> Synthesize Instance
          </button>
          <button
            type="button"
            onClick={() => { setActiveTab('legacy'); setError(null); }}
            style={{
              padding: '0.75rem 1.25rem',
              border: 'none',
              background: 'none',
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: '0.9rem',
              borderBottom: activeTab === 'legacy' ? '2px solid var(--color-primary)' : '2px solid transparent',
              color: activeTab === 'legacy' ? 'var(--color-primary)' : 'var(--color-muted)',
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
            }}
          >
            <FileCode size={16} /> Import Legacy QACO
          </button>
        </div>

        {/* Content Body */}
        <div style={{ padding: '1.25rem', overflowY: 'auto', flex: 1 }}>
          {error && (
            <Alert variant="error" style={{ marginBottom: '1rem' }} onClose={() => setError(null)}>
              {error}
            </Alert>
          )}

          {activeTab === 'synthesize' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <p style={{ margin: 0, color: 'var(--color-muted)', fontSize: '0.9rem' }}>
                  Synthesize a mathematically sound BIM v1 problem instance with guaranteed feasibility and custom control structures.
                </p>
                <Badge variant="default">Scale log₁₀ ≈ {estimatedScale}</Badge>
              </div>

              {/* Grid 1: Basic Parameters */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                  gap: '0.85rem',
                }}
              >
                <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.85rem' }}>
                  <span>Instance Name</span>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    style={{ padding: '0.4rem', borderRadius: '4px', border: '1px solid var(--color-border)', backgroundColor: 'var(--color-surface)', color: 'inherit' }}
                  />
                </label>

                <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.85rem' }}>
                  <span>Tasks / Activities (N)</span>
                  <input
                    type="number"
                    min={2}
                    max={100}
                    value={tasks}
                    onChange={(e) => setTasks(Math.max(2, parseInt(e.target.value, 10) || 2))}
                    style={{ padding: '0.4rem', borderRadius: '4px', border: '1px solid var(--color-border)', backgroundColor: 'var(--color-surface)', color: 'inherit' }}
                  />
                </label>

                <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.85rem' }}>
                  <span>Candidates / Task (|C|)</span>
                  <input
                    type="number"
                    min={2}
                    max={50}
                    value={candidates}
                    onChange={(e) => setCandidates(Math.max(2, parseInt(e.target.value, 10) || 2))}
                    style={{ padding: '0.4rem', borderRadius: '4px', border: '1px solid var(--color-border)', backgroundColor: 'var(--color-surface)', color: 'inherit' }}
                  />
                </label>

                <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.85rem' }}>
                  <span>Control Flow (%)</span>
                  <input
                    type="number"
                    min={0}
                    max={90}
                    value={controlFlow}
                    onChange={(e) => setControlFlow(Math.min(90, Math.max(0, parseInt(e.target.value, 10) || 0)))}
                    style={{ padding: '0.4rem', borderRadius: '4px', border: '1px solid var(--color-border)', backgroundColor: 'var(--color-surface)', color: 'inherit' }}
                  />
                </label>
              </div>

              {/* Grid 2: Structure & Nesting */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                  gap: '0.85rem',
                  padding: '0.75rem',
                  backgroundColor: 'var(--color-surface-subtle)',
                  borderRadius: '6px',
                }}
              >
                <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.85rem' }}>
                  <span>Loops Distribution (%)</span>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={loops}
                    onChange={(e) => setLoops(parseFloat(e.target.value) || 0)}
                    style={{ padding: '0.4rem', borderRadius: '4px', border: '1px solid var(--color-border)', backgroundColor: 'var(--color-surface)', color: 'inherit' }}
                  />
                </label>

                <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.85rem' }}>
                  <span>Branches (%)</span>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={branches}
                    onChange={(e) => setBranches(parseFloat(e.target.value) || 0)}
                    style={{ padding: '0.4rem', borderRadius: '4px', border: '1px solid var(--color-border)', backgroundColor: 'var(--color-surface)', color: 'inherit' }}
                  />
                </label>

                <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.85rem' }}>
                  <span>Parallel Flows (%)</span>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={parallel}
                    onChange={(e) => setParallel(parseFloat(e.target.value) || 0)}
                    style={{ padding: '0.4rem', borderRadius: '4px', border: '1px solid var(--color-border)', backgroundColor: 'var(--color-surface)', color: 'inherit' }}
                  />
                </label>

                <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.85rem' }}>
                  <span>Max Nesting Depth</span>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={maxNesting}
                    onChange={(e) => setMaxNesting(parseInt(e.target.value, 10) || 1)}
                    style={{ padding: '0.4rem', borderRadius: '4px', border: '1px solid var(--color-border)', backgroundColor: 'var(--color-surface)', color: 'inherit' }}
                  />
                </label>
              </div>

              {/* Grid 3: Constraints & Feasibility */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                  gap: '0.85rem',
                }}
              >
                <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.85rem' }}>
                  <span>Global Constraints</span>
                  <input
                    type="number"
                    min={0}
                    max={10}
                    value={constraints}
                    onChange={(e) => setConstraints(parseInt(e.target.value, 10) || 0)}
                    style={{ padding: '0.4rem', borderRadius: '4px', border: '1px solid var(--color-border)', backgroundColor: 'var(--color-surface)', color: 'inherit' }}
                  />
                </label>

                <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.85rem' }}>
                  <span>Constraint Tension / Tightness: {tension.toFixed(2)}</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={tension}
                    onChange={(e) => setTension(parseFloat(e.target.value))}
                  />
                </label>

                <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.85rem' }}>
                  <span>Optimization Mode</span>
                  <select
                    value={optimizationMode}
                    onChange={(e) => setOptimizationMode(e.target.value as 'weighted' | 'pareto')}
                    style={{ padding: '0.4rem', borderRadius: '4px', border: '1px solid var(--color-border)', backgroundColor: 'var(--color-surface)', color: 'inherit' }}
                  >
                    <option value="weighted">Weighted (Single Objective)</option>
                    <option value="pareto">Pareto (Multi-Objective)</option>
                  </select>
                </label>

                <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.85rem' }}>
                  <span>Random Seed (optional)</span>
                  <input
                    type="number"
                    placeholder="e.g. 42"
                    value={seed}
                    onChange={(e) => setSeed(e.target.value)}
                    style={{ padding: '0.4rem', borderRadius: '4px', border: '1px solid var(--color-border)', backgroundColor: 'var(--color-surface)', color: 'inherit' }}
                  />
                </label>
              </div>

              {/* Target Engines Selection & Witness Toggle */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', paddingTop: '0.5rem' }}>
                <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>Target Solvers Compatibility:</span>
                <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
                  {['random-search', 'evolutionary-heuristics', 'minizinc-csp'].map((eng) => (
                    <label key={eng} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.85rem', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={targetEngines.includes(eng)}
                        onChange={() => toggleEngine(eng)}
                      />
                      <code>{eng}</code>
                    </label>
                  ))}
                </div>

                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem', fontSize: '0.85rem', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={guaranteeFeasibility}
                    onChange={(e) => setGuaranteeFeasibility(e.target.checked)}
                  />
                  <span>
                    <strong>Guarantee Feasibility:</strong> Automatically inject and preserve witness candidate assignments to prevent unsatisfiable problem spaces.
                  </span>
                </label>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <p style={{ margin: 0, color: 'var(--color-muted)', fontSize: '0.9rem' }}>
                Paste the plain text of a legacy QACO problem file. The gateway will parse the service tasks, QoS tables, and structural tree, converting it into a strict BIM v1 package.
              </p>

              <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.85rem', flex: 1 }}>
                  <span>Instance Name</span>
                  <input
                    type="text"
                    value={legacyName}
                    onChange={(e) => setLegacyName(e.target.value)}
                    style={{ padding: '0.4rem', borderRadius: '4px', border: '1px solid var(--color-border)', backgroundColor: 'var(--color-surface)', color: 'inherit' }}
                  />
                </label>

                <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.85rem', flex: 1 }}>
                  <span>Tension: {legacyTension.toFixed(2)}</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={legacyTension}
                    onChange={(e) => setLegacyTension(parseFloat(e.target.value))}
                  />
                </label>
              </div>

              <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.85rem', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={repairEmptyBranches}
                    onChange={(e) => setRepairEmptyBranches(e.target.checked)}
                  />
                  <span>Repair empty branches in structural sequences</span>
                </label>

                <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.85rem', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={legacyFeasibility}
                    onChange={(e) => setLegacyFeasibility(e.target.checked)}
                  />
                  <span>Enforce witness feasibility guarantee</span>
                </label>
              </div>

              <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.85rem' }}>
                <span>Raw Legacy QACO Text Content:</span>
                <textarea
                  rows={10}
                  value={legacyText}
                  onChange={(e) => setLegacyText(e.target.value)}
                  placeholder="Paste legacy QACO instance text here (e.g. task definitions, QoS tables, structural compositions)..."
                  style={{
                    padding: '0.5rem',
                    borderRadius: '4px',
                    border: '1px solid var(--color-border)',
                    backgroundColor: 'var(--color-surface-subtle)',
                    color: 'inherit',
                    fontFamily: 'monospace',
                    fontSize: '0.8rem',
                    resize: 'vertical',
                  }}
                />
              </label>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '0.75rem',
            padding: '1rem 1.25rem',
            borderTop: '1px solid var(--color-border)',
            backgroundColor: 'var(--color-surface-subtle)',
          }}
        >
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>

          {activeTab === 'synthesize' ? (
            <Button
              variant="primary"
              onClick={handleSynthesize}
              disabled={busy}
            >
              <Sparkles size={15} className={busy ? 'spin' : ''} />
              {busy ? 'Synthesizing…' : 'Generate & Load into Workspace'}
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={handleConvertLegacy}
              disabled={busy || !legacyText.trim()}
            >
              <FileCode size={15} className={busy ? 'spin' : ''} />
              {busy ? 'Converting…' : 'Convert to BIM v1 & Load'}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
