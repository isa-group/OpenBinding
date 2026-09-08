import { useState, useEffect, useCallback } from 'react';
import { useOutletContext, useParams } from 'react-router-dom';
import { platformApi, type Job } from '../../api/platform';
import type { PlatformOutletContext } from '../../components/PlatformShell/PlatformShell';
import { Terminal, Cpu, Clock, CheckCircle2, AlertTriangle, XCircle, RotateCcw, Ban, Sparkles, Copy, Check, CircleDashed } from 'lucide-react';
import { EntityDrawer } from '../../components/Inspection/EntityDrawer';
import '../../components/Inspection/VisualEffects.css';
import './JobsPage.css';

export function JobsPage() {
  const { org = '', project: projectSlug = '', jobId } = useParams<{ org: string; project: string; jobId?: string }>();
  const { project } = useOutletContext<PlatformOutletContext>();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'running' | 'queued' | 'completed' | 'failed'>('all');
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [drawerJob, setDrawerJob] = useState<Job | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);

  const loadJobs = useCallback(async () => {
    if (!org || !projectSlug) return;
    setLoading(true);
    setError(null);
    try {
      const data = await platformApi.projectJobs(org, projectSlug);
      setJobs(data);
      if (jobId) {
        const found = data.find((j) => j.id === jobId);
        if (found) {
          setSelectedJob(found);
        } else if (data.length > 0) {
          setSelectedJob(data[0]);
        }
      } else {
        setSelectedJob((prev) => (prev ? prev : (data.length > 0 ? data[0] : null)));
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load jobs.');
    } finally {
      setLoading(false);
    }
  }, [org, projectSlug, jobId]);

  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);

  const filteredJobs = jobs.filter((j) => {
    if (filter === 'all') return true;
    return j.status.toLowerCase() === filter;
  });

  const getStatusIcon = (status: string) => {
    switch (status.toLowerCase()) {
      case 'completed':
        return <CheckCircle2 size={15} color="var(--color-success)" />;
      case 'running':
        return <span className="telemetry-pulse glow-running" style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-dialect)', display: 'inline-block' }} />;
      case 'queued':
        return <Clock size={15} color="var(--color-warning)" />;
      case 'failed':
        return <XCircle size={15} color="var(--color-error)" />;
      default:
        return <AlertTriangle size={15} color="var(--color-text-tertiary)" />;
    }
  };

  const handleFilterChange = (f: 'all' | 'running' | 'queued' | 'completed' | 'failed') => {
    setFilter(f);
    if (f !== 'all' && selectedJob && selectedJob.status.toLowerCase() !== f) {
      const nextMatch = jobs.find((j) => j.status.toLowerCase() === f) ?? null;
      setSelectedJob(nextMatch);
    }
  };

  return (
    <div className="platform-page jobs-page">
      <header className="platform-page-heading">
        <div>
          <span>Project</span>
          <h1>Project Solver Jobs</h1>
          <p>
            Solver execution ledger, daemon processes, and streaming traces for{' '}
            <strong>{project?.name || projectSlug}</strong>.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadJobs()}
          className="platform-primary-action"
        >
          <RotateCcw size={14} aria-hidden="true" /> Refresh
        </button>
      </header>

      {/* Filter Tabs */}
      <div className="jobs-filter-bar">
        {(['all', 'running', 'queued', 'completed', 'failed'] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => handleFilterChange(f)}
            className={`jobs-filter-pill ${filter === f ? 'is-active' : ''}`}
          >
            <span>{f}</span>{' '}
            <small>({f === 'all' ? jobs.length : jobs.filter((j) => (j.status || (j as unknown as { state?: string }).state || '').toLowerCase() === f).length})</small>
          </button>
        ))}
      </div>

      {loading && (
        <div className="observatory-empty">
          <CircleDashed aria-hidden="true" />
          <h3>Loading solver jobs telemetry…</h3>
          <p>Connecting to platform scheduler and streaming engine state.</p>
        </div>
      )}

      {error && (
        <div className="observatory-empty" style={{ borderColor: 'var(--color-error)' }}>
          <XCircle aria-hidden="true" color="var(--color-error)" />
          <h3>Failed to load jobs</h3>
          <p>{error}</p>
        </div>
      )}

      {!loading && jobs.length === 0 && (
        <div className="observatory-empty">
          <Cpu aria-hidden="true" />
          <h3>No solver jobs in this project</h3>
          <p>Launch a solve job from the Workbench or execute a comparative Study to produce traces.</p>
        </div>
      )}

      {!loading && jobs.length > 0 && (
        <div className="jobs-layout">
          {/* Jobs List */}
          <div className="jobs-list">
            {filteredJobs.map((job) => {
              const isSelected = selectedJob?.id === job.id;
              const statusClass = job.status.toLowerCase();
              return (
                <div
                  key={job.id}
                  onClick={() => setSelectedJob(job)}
                  className={`job-card ${isSelected ? 'is-active' : ''}`}
                >
                  <div className="job-card-header">
                    <span className="job-card-title">
                      {getStatusIcon(job.status)}
                      {job.engine_id}
                    </span>
                    <span className={`hash-badge glow-${statusClass}`}>
                      {job.status.toUpperCase()}
                      {job.termination ? ` · ${job.termination}` : ''}
                    </span>
                  </div>

                  <div className="job-card-meta">
                    <span>ID: {job.id.slice(0, 16)}…</span>
                    <span>Created: {new Date(job.created_at).toLocaleString()}</span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Job Details & Terminal Logs */}
          {selectedJob && (
            <div className="job-detail-panel">
              <div className="job-detail-header">
                <div className="job-detail-title-group">
                  <h2>
                    {selectedJob.engine_id}
                    <span className={`hash-badge glow-${selectedJob.status.toLowerCase()}`}>
                      {selectedJob.status.toUpperCase()}
                    </span>
                    {selectedJob.termination && (
                      <span className="hash-badge" style={{ color: 'var(--color-success)' }}>
                        {selectedJob.termination}
                      </span>
                    )}
                  </h2>
                  <small style={{ fontFamily: 'var(--font-mono)' }}>{`UUID: ${selectedJob.id}`}</small>
                </div>

                <div className="job-actions-row">
                  <button
                    type="button"
                    onClick={() => {
                      const url = `${window.location.origin}/app/${org}/${projectSlug}/jobs/${selectedJob.id}`;
                      navigator.clipboard.writeText(url).then(() => {
                        setCopiedLink(true);
                        setTimeout(() => setCopiedLink(false), 2000);
                      });
                    }}
                    className="job-action-btn"
                    title="Copy direct link to this job"
                  >
                    {copiedLink ? <Check size={13} color="var(--color-success)" /> : <Copy size={13} />}
                    {copiedLink ? 'Link Copied' : 'Share'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setDrawerJob(selectedJob)}
                    className="job-action-btn"
                  >
                    <Sparkles size={13} /> Inspect
                  </button>
                  {selectedJob.status === 'running' && (
                    <button
                      type="button"
                      className="job-action-btn is-cancel"
                    >
                      <Ban size={13} /> Cancel
                    </button>
                  )}
                </div>
              </div>

              {/* Options & Execution Info */}
              <div className="job-summary-grid">
                <div className="job-summary-cell">
                  <span>Engine & Solver</span>
                  <strong>
                    {selectedJob.engine_id} ({(selectedJob.options as Record<string, unknown>)?.solver as string || 'default'})
                  </strong>
                </div>
                <div className="job-summary-cell">
                  <span>Time / Budget</span>
                  <strong>
                    {String((selectedJob.options as Record<string, unknown>)?.time_budget_ms || (selectedJob.options as Record<string, unknown>)?.iterations || 'N/A')}
                  </strong>
                </div>
                <div className="job-summary-cell">
                  <span>Finished At</span>
                  <strong>
                    {selectedJob.finished_at ? new Date(selectedJob.finished_at).toLocaleTimeString() : (selectedJob.status === 'running' ? 'Active Execution…' : 'Queued')}
                  </strong>
                </div>
              </div>

              {/* Terminal Logs View */}
              <div className="job-console-section">
                <div className="terminal-header">
                  <div className="terminal-dots">
                    <span />
                    <span />
                    <span />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                    <Terminal size={12} />
                    <span>ENGINE EXECUTION CONSOLE · STDOUT / STDERR</span>
                  </div>
                  <div>
                    {selectedJob.status === 'running' && <span style={{ color: 'var(--color-dialect)' }}>● STREAMING</span>}
                    {selectedJob.status === 'completed' && <span style={{ color: 'var(--color-success)' }}>● EXITED 0</span>}
                    {selectedJob.status === 'failed' && <span style={{ color: 'var(--color-error)' }}>● EXITED 1</span>}
                  </div>
                </div>
                <pre className="terminal-viewer" style={{ borderTopLeftRadius: 0, borderTopRightRadius: 0 }}>
                  <code>
                    {selectedJob.result?.logs
                      || (selectedJob.result?.error ? `FATAL ERROR: ${selectedJob.result.error}` : 'Waiting for solver daemon output…')}
                  </code>
                </pre>
              </div>

              {/* Solutions Preview if Optimal/Feasible */}
              {selectedJob.result?.solutions && selectedJob.result.solutions.length > 0 && (
                <div className="job-solutions-preview">
                  <h3>Optimal Candidate Solution #1</h3>
                  <pre className="terminal-viewer" style={{ maxHeight: '180px' }}>
                    <code>{JSON.stringify(selectedJob.result.solutions[0], null, 2)}</code>
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Slide-over Drawer for Job */}
      {drawerJob && (
        <EntityDrawer
          isOpen={Boolean(drawerJob)}
          onClose={() => setDrawerJob(null)}
          title={`Job: ${drawerJob.engine_id}`}
          subtitle={`UUID: ${drawerJob.id}`}
          badge={{
            label: drawerJob.status.toUpperCase(),
            variant: drawerJob.status.toLowerCase() as 'running' | 'completed' | 'failed' | 'queued',
          }}
          metadata={[
            { label: 'Engine ID', value: drawerJob.engine_id },
            { label: 'Status', value: drawerJob.status },
            { label: 'Termination', value: drawerJob.termination || 'N/A' },
            { label: 'Created At', value: new Date(drawerJob.created_at).toLocaleString() },
            { label: 'Finished At', value: drawerJob.finished_at ? new Date(drawerJob.finished_at).toLocaleString() : 'In Progress' },
            { label: 'Cancellation Requested', value: drawerJob.cancellation_requested ? 'Yes' : 'No' },
          ]}
          jsonDocument={drawerJob as unknown as Record<string, unknown>}
          fullPageUrl={`/app/${org}/${projectSlug}/jobs/${drawerJob.id}`}
        />
      )}
    </div>
  );
}
