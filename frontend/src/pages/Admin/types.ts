export type TimeHorizon = 'realtime' | 'day' | 'week' | 'month' | 'historic';

export type DashboardCategory = 'builtin' | 'public_federated' | 'private_federated' | 'unified';

export type AdminViewMode = 'all' | 'dashboards' | 'accounts' | 'engines' | 'autorouter' | 'operations' | 'diagnostics';

export interface UserEngineUsage {
  engineId: string;
  engineName: string;
  category: 'builtin' | 'public_federated';
  executionSeconds: number;
  jobCount: number;
  completedJobs: number;
  failedJobs: number;
}

export interface TenantPrivateFlow {
  tenantId: string;
  tenantName: string;
  email: string;
  plan: string;
  totalRequests: number;
  totalExecutionSeconds: number;
  peakFlowRateReqPerMin: number;
  bandwidthKb: number;
}

export interface EngineTenantAllocation {
  userId: string;
  username: string;
  email: string;
  plan: string;
  executionSeconds: number;
  jobCount: number;
  completedJobs: number;
  failedJobs: number;
}

export interface EngineMetricSummary {
  engineId: string;
  name: string;
  version: string;
  category: 'builtin' | 'public_federated' | 'private_federated';
  executionSeconds: number;
  jobCount: number;
  completedJobs: number;
  failedJobs: number;
  runningJobs: number;
  avgDurationSeconds: number;
  userCount: number;
  remoteLatencyMs?: number;
  successRatePercent?: number;
  quotaBurnRate?: number;
  topTenants?: EngineTenantAllocation[];
}
export type JobOrigin = 'all' | 'studies' | 'single_cases';

export interface OriginMetrics {
  studyJobs: number;
  studyExecutionSeconds: number;
  singleCaseJobs: number;
  singleCaseExecutionSeconds: number;
}

export interface AdvancedAdminMetrics {
  budgetEfficiencyPercent: number;
  totalRequestedBudgetSeconds: number;
  totalActualComputeSeconds: number;
  retryRatePercent: number;
  totalRetriedJobs: number;
  peakConcurrencySlots: number;
  terminationBreakdown: {
    optimal: number;
    feasible: number;
    infeasible: number;
    unknown: number;
  };
  avgThroughputReqPerMin: number;
  activePrivateSolvers: number;
}

export interface UserComputeSpend {
  userId: string;
  username: string;
  email: string;
  plan: string;
  builtinExecutionSeconds: number;
  builtinJobs: number;
  federatedExecutionSeconds: number;
  federatedJobs: number;
  totalExecutionSeconds: number;
  totalJobs: number;
  studyJobs: number;
  studyExecutionSeconds: number;
  singleCaseJobs: number;
  singleCaseExecutionSeconds: number;
  quotaUsedSeconds: number;
  quotaLimitSeconds: number;
  quotaUsagePercent: number;
  isHighSpender: boolean;
  lastActive: string;
  engineBreakdown?: UserEngineUsage[];
}

export interface TelemetryDataPoint {
  timestamp: string;
  label: string;
  // Built-in metrics
  builtinExecutionSeconds: number;
  builtinJobs: number;
  // Public federated metrics
  publicFederatedExecutionSeconds: number;
  publicFederatedJobs: number;
  // Private federated anonymized aggregate metrics
  privateExecutionSeconds: number;
  privateRequests: number;
  privateFlowRateReqPerMin: number;
  privateThroughputKb: number;
  // Origin metrics (Studies vs Single Cases)
  studyJobs: number;
  studyExecutionSeconds: number;
  singleCaseJobs: number;
  singleCaseExecutionSeconds: number;
  // Totals
  totalExecutionSeconds: number;
  totalJobs: number;
}

export interface PrivateFederatedTelemetry {
  totalRequests: number;
  totalExecutionSeconds: number;
  activeConcurrency: number;
  peakFlowRateReqPerMin: number;
  avgDurationSeconds: number;
  successRatePercent: number;
  bandwidthTransferredMb: number;
  activeSolversCount: number;
  recentFlowPoints: Array<{
    time: string;
    flowRate: number; // req/min
    activeSlots: number;
    avgLatencyMs: number;
  }>;
  tenantFlows?: TenantPrivateFlow[];
}

export interface AdminTelemetryState {
  timeHorizon: TimeHorizon;
  points: TelemetryDataPoint[];
  builtinEngines: EngineMetricSummary[];
  publicFederatedEngines: EngineMetricSummary[];
  privateFederated: PrivateFederatedTelemetry;
  userSpends: UserComputeSpend[];
  originBreakdown: OriginMetrics;
  advancedMetrics: AdvancedAdminMetrics;
  totals: {
    builtinExecutionSeconds: number;
    builtinJobs: number;
    publicFederatedExecutionSeconds: number;
    publicFederatedJobs: number;
    privateExecutionSeconds: number;
    privateRequests: number;
    overallExecutionSeconds: number;
    overallJobs: number;
    activeRunningJobs: number;
  };
  isLive: boolean;
  lastUpdated: Date;
}

export interface ErrorEventQuotaDetail {
  limit_id?: string;
  used: number;
  limit: number;
  unit?: string;
  renews_at?: string;
}

export interface ErrorEventDetail {
  quota?: ErrorEventQuotaDetail;
  [key: string]: unknown;
}

export interface ApiErrorEventItem {
  id: string;
  user_id?: string | null;
  userId?: string | null;
  user_email?: string | null;
  userEmail?: string | null;
  organization_id?: string | null;
  organizationId?: string | null;
  status_code: number;
  statusCode: number;
  category: 'pricing_quota' | 'concurrency' | 'solver_failure' | 'system_bug' | 'validation' | 'auth';
  error_code: string;
  errorCode: string;
  endpoint: string;
  http_method: string;
  httpMethod: string;
  detail: ErrorEventDetail;
  created_at: string;
  createdAt: string;
}

export interface AdminErrorOverview {
  total_errors_24h: number;
  by_category_24h: Record<string, number>;
  by_status_code_24h: Record<string, number>;
  top_users_quota: Array<{
    userId: string;
    email?: string | null;
    errorCount: number;
    lastSeen?: string | null;
  }>;
  top_solvers_failed: Array<{
    engine: string;
    failureCount: number;
    lastSeen?: string | null;
  }>;
  timeline: Array<{
    timestamp: string;
    quota: number;
    concurrency: number;
    solver: number;
    system: number;
    validation: number;
  }>;
}

export interface AdminErrorListResponse {
  items: ApiErrorEventItem[];
  total: number;
  limit: number;
  offset: number;
}
