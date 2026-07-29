import { useState, useEffect, useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { Search, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Loader2 } from 'lucide-react';
import { apiClient, type BindingSpaceRequest, type BindingSpacePage } from '../../api/client';
import './BindingSpaceExplorer.css';

interface Task {
  id: string;
  name?: string;
}

interface Candidate {
  id: string;
  task_ids?: string[];
  task?: string;
  task_id?: string;
  [key: string]: any;
}

interface BindingSpaceExplorerProps {
  engineId: string;
  instance: any;
  tasks: Task[];
  candidates: Candidate[];
  width?: number;
  height?: number;
}

const PAGE_SIZE = 20;

// Get computed CSS color values
const getCSSColor = (varName: string): string => {
  if (typeof window === 'undefined') return '#6b7280';
  return getComputedStyle(document.documentElement).getPropertyValue(varName).trim() || '#6b7280';
};

// Every task a candidate can implement. Older payloads named the single one
// they served, so those are read as a list of one.
const getCandidateTaskIds = (candidate: Candidate): string[] => {
  if (candidate.task_ids?.length) return candidate.task_ids;
  const single = candidate.task ?? candidate.task_id;
  return single ? [single] : [];
};

export const BindingSpaceExplorer: React.FC<BindingSpaceExplorerProps> = ({
  engineId,
  instance,
  tasks,
  candidates,
  width,
  height = 400,
}) => {
  const [bindingData, setBindingData] = useState<BindingSpacePage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(0);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedBinding, setSelectedBinding] = useState<Record<string, string> | null>(null);
  // Calculate cardinality per task
  const taskCardinality = useMemo(() => {
    const cardinalityMap = new Map<string, number>();
    
    tasks.forEach((task) => {
      const count = candidates.filter((c) => getCandidateTaskIds(c).includes(task.id)).length;
      cardinalityMap.set(task.id, count);
    });

    return Array.from(cardinalityMap.entries()).map(([taskId, count]) => {
      const task = tasks.find((t) => t.id === taskId);
      return {
        taskId,
        taskName: task?.name || taskId,
        count,
      };
    });
  }, [tasks, candidates]);

  // Calculate total binding space
  const totalBindingSpace = useMemo(() => {
    if (taskCardinality.length === 0) return 0;
    return taskCardinality.reduce((acc, item) => acc * (item.count || 1), 1);
  }, [taskCardinality]);

  // Calculate log10 of binding space for better visualization
  const log10BindingSpace = useMemo(() => {
    if (totalBindingSpace <= 0) return 0;
    return Math.log10(totalBindingSpace);
  }, [totalBindingSpace]);

  // Determine complexity level based on log10 scale
  const complexityLevel = useMemo(() => {
    if (log10BindingSpace < 2) return 'Low';        // < 100
    if (log10BindingSpace < 4) return 'Medium';     // < 10,000
    if (log10BindingSpace < 6) return 'High';       // < 1,000,000
    return 'Very High';                              // >= 1,000,000
  }, [log10BindingSpace]);

  const getComplexityColor = () => {
    switch (complexityLevel) {
      case 'Low':
        return '#22c55e'; // green
      case 'Medium':
        return '#f59e0b'; // amber
      case 'High':
        return '#ef4444'; // red
      case 'Very High':
        return '#dc2626'; // dark red
      default:
        return '#71717a'; // gray
    }
  };

  const getBarColor = (count: number) => {
    if (taskCardinality.length === 0) return '#8b5cf6';
    const max = Math.max(...taskCardinality.map((t) => t.count));
    const ratio = max > 0 ? count / max : 0;
    if (ratio < 0.3) return '#3b82f6';  // blue
    if (ratio < 0.7) return '#8b5cf6';  // violet
    return '#ec4899';                   // pink
  };

  // Fetch bindings from API
  const fetchBindings = async (offset: number) => {
    setLoading(true);
    setError(null);
    try {
      const request: BindingSpaceRequest = {
        engine_id: engineId,
        instance,
        offset,
        limit: PAGE_SIZE,
      };
      const data = await apiClient.exploreBindingSpace(request);
      setBindingData(data);
    } catch (err: any) {
      setError(err.message || 'Failed to fetch bindings');
    } finally {
      setLoading(false);
    }
  };

  // Load initial bindings and reset state when instance/tasks/candidates change
  useEffect(() => {
    setCurrentPage(0);
    setSearchTerm('');
    setSelectedBinding(null);
    fetchBindings(0);
  }, [engineId, instance, tasks.length, candidates.length]);

  // Handle page change
  const handlePageChange = (newPage: number) => {
    setCurrentPage(newPage);
    fetchBindings(newPage * PAGE_SIZE);
  };

  // Filter bindings based on search term
  const filteredBindings = useMemo(() => {
    if (!bindingData || !searchTerm) return bindingData?.bindings || [];
    
    return bindingData.bindings.filter((binding) => {
      const searchLower = searchTerm.toLowerCase();
      return Object.entries(binding).some(([task, candidate]) => 
        task.toLowerCase().includes(searchLower) || 
        candidate.toLowerCase().includes(searchLower)
      );
    });
  }, [bindingData, searchTerm]);

  const totalPages = bindingData 
    ? Math.ceil(parseInt(bindingData.total_combinations) / PAGE_SIZE) 
    : 0;

  const CustomTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      return (
        <div className="binding-tooltip">
          <p className="tooltip-title">{data.taskName}</p>
          <p className="tooltip-count">Candidates: {data.count}</p>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="binding-space-explorer">
      <div className="summary-cards">
        <div className="summary-card">
          <div className="card-icon">📋</div>
          <div className="card-content">
            <span className="card-label">Total Tasks</span>
            <span className="card-value">{tasks.length}</span>
          </div>
        </div>

        <div className="summary-card">
          <div className="card-icon">🎯</div>
          <div className="card-content">
            <span className="card-label">Total Candidates</span>
            <span className="card-value">{candidates.length}</span>
          </div>
        </div>

        <div className="summary-card">
          <div className="card-icon">🔢</div>
          <div className="card-content">
            <span className="card-label">Binding Space</span>
            <span className="card-value" title={`${totalBindingSpace.toLocaleString()} combinations`}>
              {totalBindingSpace < 1e6 
                ? totalBindingSpace.toLocaleString()
                : totalBindingSpace.toExponential(2)}
            </span>
          </div>
        </div>

        <div className="summary-card complexity" style={{ borderColor: getComplexityColor() }}>
          <div className="card-icon">⚡</div>
          <div className="card-content">
            <span className="card-label">Complexity</span>
            <span className="card-value" style={{ color: getComplexityColor() }} title={`Log10: ${log10BindingSpace.toFixed(2)}`}>
              {complexityLevel}
            </span>
          </div>
        </div>
      </div>

      <div className="chart-section">
        <h3 className="section-title">Candidates per Task</h3>
        <ResponsiveContainer width={width || '100%'} height={height}>
          <BarChart
            data={taskCardinality}
            margin={{ top: 20, right: 30, left: 20, bottom: 60 }}
          >
            <CartesianGrid 
              strokeDasharray="3 3" 
              stroke={getCSSColor('--color-border')} 
            />
            <XAxis
              dataKey="taskName"
              angle={-45}
              textAnchor="end"
              height={80}
              stroke={getCSSColor('--color-text-tertiary')}
              tick={{ fill: getCSSColor('--color-text-secondary'), fontSize: 12 }}
            />
            <YAxis
              stroke={getCSSColor('--color-text-tertiary')}
              tick={{ fill: getCSSColor('--color-text-secondary') }}
              label={{
                value: 'Number of Candidates',
                angle: -90,
                position: 'insideLeft',
                style: { fill: getCSSColor('--color-text-primary'), fontSize: 14 },
              }}
            />
            <Tooltip content={<CustomTooltip />} cursor={{ fill: getCSSColor('--color-bg-tertiary') }} />
            <Bar dataKey="count" radius={[4, 4, 0, 0]}>
              {taskCardinality.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={getBarColor(entry.count)} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Bindings Explorer Section */}
      <div className="bindings-explorer-section">
        <div className="explorer-header">
          <h3 className="section-title">Explore Binding Configurations</h3>
          <div className="search-box">
            <Search size={18} className="search-icon" />
            <input
              type="text"
              placeholder="Search by task or candidate..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="search-input"
            />
          </div>
        </div>

        {error && (
          <div className="error-message">
            <span>⚠️ {error}</span>
          </div>
        )}

        {loading ? (
          <div className="loading-state">
            <Loader2 size={32} className="spinner" />
            <p>Loading bindings...</p>
          </div>
        ) : (
          <>
            <div className="bindings-table-wrapper">
              <table className="bindings-table">
                <thead>
                  <tr>
                    <th className="binding-index">#</th>
                    {tasks.map((task) => (
                      <th key={task.id} className="task-column">
                        {task.name || task.id}
                      </th>
                    ))}
                    <th className="actions-column">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredBindings.length === 0 ? (
                    <tr>
                      <td colSpan={tasks.length + 2} className="empty-state">
                        {searchTerm ? 'No bindings match your search' : 'No bindings available'}
                      </td>
                    </tr>
                  ) : (
                    filteredBindings.map((binding, index) => {
                      const globalIndex = currentPage * PAGE_SIZE + index + 1;
                      const isSelected = selectedBinding === binding;
                      
                      return (
                        <tr 
                          key={index} 
                          className={`binding-row ${isSelected ? 'selected' : ''}`}
                          onClick={() => setSelectedBinding(binding)}
                        >
                          <td className="binding-index">{globalIndex}</td>
                          {tasks.map((task) => (
                            <td key={task.id} className="candidate-cell">
                              <span className="candidate-badge">
                                {binding[task.id] || 'N/A'}
                              </span>
                            </td>
                          ))}
                          <td className="actions-column">
                            <button 
                              className="view-button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedBinding(binding);
                              }}
                            >
                              View
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {bindingData && totalPages > 1 && (
              <div className="pagination">
                <div className="pagination-info">
                  Showing {currentPage * PAGE_SIZE + 1} - {Math.min((currentPage + 1) * PAGE_SIZE, parseInt(bindingData.total_combinations))} of {bindingData.total_combinations}
                </div>
                <div className="pagination-controls">
                  <button
                    onClick={() => handlePageChange(0)}
                    disabled={currentPage === 0 || loading}
                    className="page-button"
                    title="First page"
                  >
                    <ChevronsLeft size={16} />
                  </button>
                  <button
                    onClick={() => handlePageChange(currentPage - 1)}
                    disabled={currentPage === 0 || loading}
                    className="page-button"
                    title="Previous page"
                  >
                    <ChevronLeft size={16} />
                  </button>
                  <span className="page-indicator">
                    Page {currentPage + 1} of {totalPages}
                  </span>
                  <button
                    onClick={() => handlePageChange(currentPage + 1)}
                    disabled={currentPage >= totalPages - 1 || loading}
                    className="page-button"
                    title="Next page"
                  >
                    <ChevronRight size={16} />
                  </button>
                  <button
                    onClick={() => handlePageChange(totalPages - 1)}
                    disabled={currentPage >= totalPages - 1 || loading}
                    className="page-button"
                    title="Last page"
                  >
                    <ChevronsRight size={16} />
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Selected Binding Detail */}
      {selectedBinding && (
        <div className="binding-detail">
          <h3 className="section-title">Selected Binding Configuration</h3>
          <div className="binding-detail-grid">
            {Object.entries(selectedBinding).map(([taskId, candidateId]) => {
              const task = tasks.find((t) => t.id === taskId);
              const candidate = candidates.find(
                (c) => c.id === candidateId && getCandidateTaskIds(c).includes(taskId)
              );
              
              return (
                <div key={taskId} className="binding-detail-item">
                  <div className="detail-task">
                    <span className="detail-label">Task:</span>
                    <span className="detail-value">{task?.name || taskId}</span>
                  </div>
                  <div className="detail-arrow">→</div>
                  <div className="detail-candidate">
                    <span className="detail-label">Candidate:</span>
                    <span className="detail-value">{candidateId}</span>
                    {candidate && Object.keys(candidate).length > 2 && (
                      <div className="candidate-attributes">
                        {Object.entries(candidate)
                          .filter(
                            ([key]) =>
                              key !== 'id' && key !== 'task' && key !== 'task_id' && key !== 'task_ids'
                          )
                          .slice(0, 3)
                          .map(([key, value]) => (
                            <span key={key} className="attribute">
                              {key}: {typeof value === 'number' ? value.toFixed(2) : String(value)}
                            </span>
                          ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="insights-section">
        <h3 className="section-title">Analysis Insights</h3>
        <div className="insights-grid">
          <div className="insight-card">
            <span className="insight-label">Avg Candidates/Task:</span>
            <span className="insight-value">
              {tasks.length > 0 ? (candidates.length / tasks.length).toFixed(2) : '0.00'}
            </span>
          </div>
          <div className="insight-card">
            <span className="insight-label">Min Candidates:</span>
            <span className="insight-value">
              {taskCardinality.length > 0 && taskCardinality.map((t) => t.count).length > 0
                ? Math.min(...taskCardinality.map((t) => t.count))
                : 0}
            </span>
          </div>
          <div className="insight-card">
            <span className="insight-label">Max Candidates:</span>
            <span className="insight-value">
              {taskCardinality.length > 0 && taskCardinality.map((t) => t.count).length > 0
                ? Math.max(...taskCardinality.map((t) => t.count))
                : 0}
            </span>
          </div>
          <div className="insight-card">
            <span className="insight-label">Log10 Space Size:</span>
            <span className="insight-value" title={`Actual: ${totalBindingSpace.toLocaleString()} combinations`}>
              {totalBindingSpace > 0 ? log10BindingSpace.toFixed(2) : '0.00'}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
