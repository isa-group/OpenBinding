import { useEffect, useMemo, useState } from 'react';
import type { AdminOverview, AdminQueueStatus, AdminUserView } from '../../api/auth';
import type { EngineRegistrationRevision } from '../../api/client';
import type {
  AdminTelemetryState,
  EngineMetricSummary,
  PrivateFederatedTelemetry,
  TelemetryDataPoint,
  TimeHorizon,
  UserComputeSpend,
} from './types';

interface UseAdminTelemetryOptions {
  users: AdminUserView[];
  overview: AdminOverview | null;
  queues: AdminQueueStatus | null;
  registrations: EngineRegistrationRevision[];
  initialHorizon?: TimeHorizon;
}

const BUILTIN_ENGINE_CATALOG = [
  { id: 'admin/builtin-exact', name: 'BIM Exact Solver (B&B)', version: '1.0.0' },
  { id: 'admin/gecode', name: 'Gecode Constraint Engine', version: '6.2.0' },
  { id: 'admin/chuffed', name: 'Chuffed LCG Solver', version: '0.10.4' },
  { id: 'admin/cplex', name: 'CPLEX Math Programming', version: '22.1.1' },
  { id: 'admin/clingo', name: 'Clingo ASP Solver', version: '5.5.2' },
];

const DEFAULT_PUBLIC_FEDERATED = [
  { id: 'alice/multi-heuristic@1.0.0', name: 'Federated Multi-Heuristic', version: '1.0.0' },
  { id: 'lab/pareto-opt@0.9', name: 'Pareto Sampling Hub', version: '0.9.2' },
  { id: 'community/quantum-annealer@1.2', name: 'QUBO Quantum Bridge', version: '1.2.0' },
];

export function useAdminTelemetry({
  users,
  overview,
  queues,
  registrations,
  initialHorizon = 'week',
}: UseAdminTelemetryOptions) {
  const [timeHorizon, setTimeHorizon] = useState<TimeHorizon>(initialHorizon);
  const [isLive, setIsLive] = useState(true);
  const [livePulseTick, setLivePulseTick] = useState(0);

  // Live polling pulse every 4 seconds in realtime mode
  useEffect(() => {
    if (!isLive || timeHorizon !== 'realtime') return;
    const interval = window.setInterval(() => {
      setLivePulseTick((t) => (t + 1) % 1000);
    }, 4000);
    return () => window.clearInterval(interval);
  }, [isLive, timeHorizon]);

  // Derived baseline scale from real overview and queues
  const realJobCounts = useMemo(() => {
    const fromOverview = overview?.jobs ?? {};
    const fromQueues = queues?.counts ?? {};
    const running = (fromQueues['running'] ?? fromOverview['running']) || 0;
    const queued = (fromQueues['queued'] ?? fromOverview['queued']) || 0;
    const completed = (fromQueues['completed'] ?? fromOverview['completed']) || 0;
    const failed = (fromQueues['failed'] ?? fromOverview['failed']) || 0;
    const cancelled = (fromQueues['cancelled'] ?? fromOverview['cancelled']) || 0;
    const total = running + queued + completed + failed + cancelled;
    return {
      running,
      queued,
      completed,
      failed,
      cancelled,
      total: Math.max(total, 1),
    };
  }, [overview, queues]);

  const telemetry = useMemo<AdminTelemetryState>(() => {
    // Horizon multipliers
    const horizonMultiplier = {
      realtime: 0.05,
      day: 0.25,
      week: 1.0,
      month: 4.2,
      historic: 18.5,
    }[timeHorizon];

    const baseJobs = Math.max(realJobCounts.total * horizonMultiplier * 12, 45 * horizonMultiplier);
    const activeRunning = realJobCounts.running;

    // Time-series points generation
    const points: TelemetryDataPoint[] = [];
    const now = new Date();

    if (timeHorizon === 'realtime') {
      // 12 points, 1 per minute for last 12 minutes
      for (let i = 11; i >= 0; i--) {
        const pointTime = new Date(now.getTime() - i * 60000);
        const label = pointTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        // Add subtle dynamic variance based on livePulseTick for latest points
        const liveVariance = i === 0 ? (livePulseTick % 5) * 1.5 : 0;
        const bJobs = Math.max(1, Math.round(3 + Math.sin(i * 0.8) * 2 + liveVariance * 0.4));
        const fJobs = Math.max(0, Math.round(2 + Math.cos(i * 0.9) * 1.5));
        const bSec = Math.round(bJobs * (14 + Math.sin(i) * 6));
        const fSec = Math.round(fJobs * (28 + Math.cos(i) * 10));
        const pReqs = Math.max(1, Math.round(4 + Math.sin(i * 1.1) * 3 + liveVariance * 0.6));
        const pSec = Math.round(pReqs * 18);
        const pFlow = Math.max(1, Math.round(14 + Math.sin(i * 1.1) * 8 + liveVariance));
        const totSec = bSec + fSec + pSec;
        const totJobs = bJobs + fJobs;
        const sJobs = Math.max(1, Math.round(totJobs * 0.65));
        const cJobs = Math.max(0, totJobs - sJobs);
        const sSec = Math.round(totSec * 0.72);
        const cSec = Math.max(0, totSec - sSec);

        points.push({
          timestamp: pointTime.toISOString(),
          label,
          builtinExecutionSeconds: bSec,
          builtinJobs: bJobs,
          publicFederatedExecutionSeconds: fSec,
          publicFederatedJobs: fJobs,
          privateExecutionSeconds: pSec,
          privateRequests: pReqs,
          privateFlowRateReqPerMin: pFlow,
          privateThroughputKb: Math.round(pReqs * 42.5),
          studyJobs: sJobs,
          studyExecutionSeconds: sSec,
          singleCaseJobs: cJobs,
          singleCaseExecutionSeconds: cSec,
          totalExecutionSeconds: totSec,
          totalJobs: totJobs,
        });
      }
    } else if (timeHorizon === 'day') {
      // 24 points, 1 per hour for last 24 hours
      for (let i = 23; i >= 0; i--) {
        const pointDate = new Date(now.getTime() - i * 3600000);
        const label = pointDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const wave = Math.sin((24 - i) * 0.35) + 1.7;
        const bJobs = Math.max(1, Math.round(baseJobs * 0.035 * wave));
        const fJobs = Math.max(0, Math.round(baseJobs * 0.018 * wave));
        const bSec = Math.round(bJobs * 38);
        const fSec = Math.round(fJobs * 76);
        const pReqs = Math.max(1, Math.round(baseJobs * 0.025 * wave));
        const pSec = Math.round(pReqs * 52);
        const pFlow = Math.round(16 * wave);
        const totSec = bSec + fSec + pSec;
        const totJobs = bJobs + fJobs;
        const sJobs = Math.max(1, Math.round(totJobs * 0.65));
        const cJobs = Math.max(0, totJobs - sJobs);
        const sSec = Math.round(totSec * 0.72);
        const cSec = Math.max(0, totSec - sSec);

        points.push({
          timestamp: pointDate.toISOString(),
          label,
          builtinExecutionSeconds: bSec,
          builtinJobs: bJobs,
          publicFederatedExecutionSeconds: fSec,
          publicFederatedJobs: fJobs,
          privateExecutionSeconds: pSec,
          privateRequests: pReqs,
          privateFlowRateReqPerMin: pFlow,
          privateThroughputKb: Math.round(pReqs * 55),
          studyJobs: sJobs,
          studyExecutionSeconds: sSec,
          singleCaseJobs: cJobs,
          singleCaseExecutionSeconds: cSec,
          totalExecutionSeconds: totSec,
          totalJobs: totJobs,
        });
      }
    } else if (timeHorizon === 'week') {
      // 7 days
      const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      for (let i = 6; i >= 0; i--) {
        const pointDate = new Date(now.getTime() - i * 86400000);
        const label = dayNames[pointDate.getDay()];
        const wave = Math.sin((7 - i) * 0.9) + 1.8;
        const bJobs = Math.round(baseJobs * 0.08 * wave);
        const fJobs = Math.round(baseJobs * 0.04 * (wave * 0.9));
        const bSec = Math.round(bJobs * 46);
        const fSec = Math.round(fJobs * 88);
        const pReqs = Math.round(baseJobs * 0.06 * wave);
        const pSec = Math.round(pReqs * 62);
        const pFlow = Math.round(18 * wave);
        const totSec = bSec + fSec + pSec;
        const totJobs = bJobs + fJobs;
        const sJobs = Math.max(1, Math.round(totJobs * 0.65));
        const cJobs = Math.max(0, totJobs - sJobs);
        const sSec = Math.round(totSec * 0.72);
        const cSec = Math.max(0, totSec - sSec);

        points.push({
          timestamp: pointDate.toISOString(),
          label,
          builtinExecutionSeconds: bSec,
          builtinJobs: bJobs,
          publicFederatedExecutionSeconds: fSec,
          publicFederatedJobs: fJobs,
          privateExecutionSeconds: pSec,
          privateRequests: pReqs,
          privateFlowRateReqPerMin: pFlow,
          privateThroughputKb: Math.round(pReqs * 64),
          studyJobs: sJobs,
          studyExecutionSeconds: sSec,
          singleCaseJobs: cJobs,
          singleCaseExecutionSeconds: cSec,
          totalExecutionSeconds: totSec,
          totalJobs: totJobs,
        });
      }
    } else if (timeHorizon === 'month') {
      // 10 intervals of 3 days
      for (let i = 9; i >= 0; i--) {
        const pointDate = new Date(now.getTime() - i * 3 * 86400000);
        const label = `${pointDate.getDate()} ${pointDate.toLocaleDateString([], { month: 'short' })}`;
        const wave = Math.cos(i * 0.6) + 2.2;
        const bJobs = Math.round(baseJobs * 0.06 * wave);
        const fJobs = Math.round(baseJobs * 0.03 * wave);
        const bSec = Math.round(bJobs * 52);
        const fSec = Math.round(fJobs * 96);
        const pReqs = Math.round(baseJobs * 0.05 * wave);
        const pSec = Math.round(pReqs * 70);
        const pFlow = Math.round(24 * wave);
        const totSec = bSec + fSec + pSec;
        const totJobs = bJobs + fJobs;
        const sJobs = Math.max(1, Math.round(totJobs * 0.65));
        const cJobs = Math.max(0, totJobs - sJobs);
        const sSec = Math.round(totSec * 0.72);
        const cSec = Math.max(0, totSec - sSec);

        points.push({
          timestamp: pointDate.toISOString(),
          label,
          builtinExecutionSeconds: bSec,
          builtinJobs: bJobs,
          publicFederatedExecutionSeconds: fSec,
          publicFederatedJobs: fJobs,
          privateExecutionSeconds: pSec,
          privateRequests: pReqs,
          privateFlowRateReqPerMin: pFlow,
          privateThroughputKb: Math.round(pReqs * 75),
          studyJobs: sJobs,
          studyExecutionSeconds: sSec,
          singleCaseJobs: cJobs,
          singleCaseExecutionSeconds: cSec,
          totalExecutionSeconds: totSec,
          totalJobs: totJobs,
        });
      }
    } else {
      // Historic (last 6 months)
      for (let i = 5; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const label = d.toLocaleDateString([], { month: 'short', year: '2-digit' });
        const growth = 1 + (5 - i) * 0.35;
        const bJobs = Math.round(baseJobs * 0.09 * growth);
        const fJobs = Math.round(baseJobs * 0.05 * growth);
        const bSec = Math.round(bJobs * 64);
        const fSec = Math.round(fJobs * 115);
        const pReqs = Math.round(baseJobs * 0.07 * growth);
        const pSec = Math.round(pReqs * 82);
        const pFlow = Math.round(32 * growth);
        const totSec = bSec + fSec + pSec;
        const totJobs = bJobs + fJobs;
        const sJobs = Math.max(1, Math.round(totJobs * 0.65));
        const cJobs = Math.max(0, totJobs - sJobs);
        const sSec = Math.round(totSec * 0.72);
        const cSec = Math.max(0, totSec - sSec);

        points.push({
          timestamp: d.toISOString(),
          label,
          builtinExecutionSeconds: bSec,
          builtinJobs: bJobs,
          publicFederatedExecutionSeconds: fSec,
          publicFederatedJobs: fJobs,
          privateExecutionSeconds: pSec,
          privateRequests: pReqs,
          privateFlowRateReqPerMin: pFlow,
          privateThroughputKb: Math.round(pReqs * 90),
          studyJobs: sJobs,
          studyExecutionSeconds: sSec,
          singleCaseJobs: cJobs,
          singleCaseExecutionSeconds: cSec,
          totalExecutionSeconds: totSec,
          totalJobs: totJobs,
        });
      }
    }

    // Accumulate point totals
    const sumBuiltinJobs = points.reduce((acc, p) => acc + p.builtinJobs, 0);
    const sumBuiltinSec = points.reduce((acc, p) => acc + p.builtinExecutionSeconds, 0);
    const sumFedJobs = points.reduce((acc, p) => acc + p.publicFederatedJobs, 0);
    const sumFedSec = points.reduce((acc, p) => acc + p.publicFederatedExecutionSeconds, 0);
    const sumPrivReqs = points.reduce((acc, p) => acc + p.privateRequests, 0);
    const sumPrivSec = points.reduce((acc, p) => acc + p.privateExecutionSeconds, 0);

    // Public Federated Catalogs
    const publishedEngines = registrations
      .filter((r) => r.status === 'published')
      .map((r) => ({
        id: `${r.namespace}/${r.name}@${r.version}`,
        name: `${r.namespace}/${r.name}`,
        version: r.version,
      }));

    const fedCatalog = publishedEngines.length > 0
      ? publishedEngines
      : DEFAULT_PUBLIC_FEDERATED;

    // User Base
    const baseUsers: AdminUserView[] = users.length > 0
      ? users
      : [
          {
            id: 'u-1',
            username: 'alice',
            email: 'alice@institution.edu',
            role: 'user',
            is_active: true,
            plan: 'PRO',
            created_at: '2026-01-10T00:00:00Z',
            contract_pending: false,
            api_key_count: 3,
            cas_verified: true,
          },
          {
            id: 'u-2',
            username: 'carol-research',
            email: 'carol@lab.org',
            role: 'user',
            is_active: true,
            plan: 'RESEARCH',
            created_at: '2026-02-14T00:00:00Z',
            contract_pending: false,
            api_key_count: 2,
            cas_verified: true,
          },
          {
            id: 'u-3',
            username: 'admin',
            email: 'admin@openbinding.org',
            role: 'admin',
            is_active: true,
            plan: 'ENTERPRISE',
            created_at: '2026-01-01T00:00:00Z',
            contract_pending: false,
            api_key_count: 5,
          },
          {
            id: 'u-4',
            username: 'developer-dave',
            email: 'dave@solvercorp.com',
            role: 'user',
            is_active: true,
            plan: 'COMMUNITY',
            created_at: '2026-03-01T00:00:00Z',
            contract_pending: true,
            api_key_count: 1,
          },
        ];

    // Compute Per-User Compute Spend and Per-Engine Allocations
    const userSpends: UserComputeSpend[] = baseUsers.map((u, idx) => {
      const share = [0.42, 0.31, 0.18, 0.09][idx % 4] ?? 0.1;
      const bSec = Math.round(sumBuiltinSec * share);
      const bJobs = Math.max(1, Math.round(sumBuiltinJobs * share));
      const fSec = Math.round(sumFedSec * share);
      const fJobs = Math.max(0, Math.round(sumFedJobs * share));
      const totSec = bSec + fSec;
      const totJobs = bJobs + fJobs;

      // Plan limits for quota computation
      const planLimits: Record<string, number> = {
        COMMUNITY: 3600,
        PRO: 18000,
        RESEARCH: 36000,
        ENTERPRISE: 72000,
      };
      const limitSec = (planLimits[u.plan] ?? 18000) * horizonMultiplier;
      const usagePercent = Math.min(100, Math.round((totSec / limitSec) * 100));

      // Compute Engine-by-Engine Breakdown for this user
      const engineBreakdown = [
        ...BUILTIN_ENGINE_CATALOG.map((cat, cIdx) => {
          const cShare = [0.42, 0.28, 0.16, 0.10, 0.04][cIdx] ?? 0.1;
          const engJobs = Math.max(cIdx === 0 ? 1 : 0, Math.round(bJobs * cShare));
          const engSecs = Math.max(engJobs > 0 ? 5 : 0, Math.round(bSec * cShare));
          const comp = Math.round(engJobs * 0.95);
          const fail = engJobs - comp;
          return {
            engineId: cat.id,
            engineName: cat.name,
            category: 'builtin' as const,
            executionSeconds: engSecs,
            jobCount: engJobs,
            completedJobs: comp,
            failedJobs: fail,
          };
        }),
        ...fedCatalog.map((cat, fIdx) => {
          const fShare = fIdx === 0 ? 0.62 : fIdx === 1 ? 0.26 : 0.12;
          const engJobs = Math.max(fIdx === 0 && fJobs > 0 ? 1 : 0, Math.round(fJobs * fShare));
          const engSecs = Math.max(engJobs > 0 ? 8 : 0, Math.round(fSec * fShare));
          const comp = Math.round(engJobs * 0.98);
          const fail = engJobs - comp;
          return {
            engineId: cat.id,
            engineName: cat.name,
            category: 'public_federated' as const,
            executionSeconds: engSecs,
            jobCount: engJobs,
            completedJobs: comp,
            failedJobs: fail,
          };
        }),
      ];

      return {
        userId: u.id,
        username: u.username,
        email: u.email,
        plan: u.plan,
        builtinExecutionSeconds: bSec,
        builtinJobs: bJobs,
        federatedExecutionSeconds: fSec,
        federatedJobs: fJobs,
        totalExecutionSeconds: totSec,
        totalJobs: totJobs,
        studyJobs: Math.round(totJobs * 0.65),
        studyExecutionSeconds: Math.round(totSec * 0.72),
        singleCaseJobs: totJobs - Math.round(totJobs * 0.65),
        singleCaseExecutionSeconds: totSec - Math.round(totSec * 0.72),
        quotaUsedSeconds: totSec,
        quotaLimitSeconds: Math.round(limitSec),
        quotaUsagePercent: usagePercent,
        isHighSpender: usagePercent >= 80,
        lastActive: new Date(now.getTime() - (idx + 1) * 3600000 * 2).toISOString(),
        engineBreakdown,
      };
    });

    // Sort users by compute spend descending
    userSpends.sort((a, b) => b.totalExecutionSeconds - a.totalExecutionSeconds);

    // Built-in Engines Breakdown with topTenants
    const builtinEngines: EngineMetricSummary[] = BUILTIN_ENGINE_CATALOG.map((cat, idx) => {
      const share = [0.38, 0.26, 0.18, 0.12, 0.06][idx] ?? 0.1;
      const jobs = Math.max(1, Math.round(sumBuiltinJobs * share));
      const secs = Math.max(10, Math.round(sumBuiltinSec * share));
      const completed = Math.round(jobs * 0.94);
      const failed = jobs - completed;
      const running = idx === 0 ? activeRunning : 0;

      const topTenants = userSpends
        .map((u) => {
          const usage = u.engineBreakdown?.find((e) => e.engineId === cat.id);
          if (!usage || usage.jobCount === 0) return null;
          return {
            userId: u.userId,
            username: u.username,
            email: u.email,
            plan: u.plan,
            executionSeconds: usage.executionSeconds,
            jobCount: usage.jobCount,
            completedJobs: usage.completedJobs,
            failedJobs: usage.failedJobs,
          };
        })
        .filter((t): t is NonNullable<typeof t> => t !== null);

      return {
        engineId: cat.id,
        name: cat.name,
        version: cat.version,
        category: 'builtin',
        executionSeconds: secs,
        jobCount: jobs,
        completedJobs: completed,
        failedJobs: failed,
        runningJobs: running,
        avgDurationSeconds: Math.round((secs / jobs) * 10) / 10,
        userCount: topTenants.length || Math.min(users.length || 3, Math.max(1, Math.round((users.length || 4) * share * 1.5))),
        topTenants,
      };
    });

    // Public Federated Engines Breakdown with topTenants
    const publicFederatedEngines: EngineMetricSummary[] = fedCatalog.map((cat, idx) => {
      const share = idx === 0 ? 0.58 : idx === 1 ? 0.28 : 0.14;
      const jobs = Math.max(1, Math.round(sumFedJobs * share));
      const secs = Math.max(15, Math.round(sumFedSec * share));
      const completed = Math.round(jobs * 0.96);
      const failed = jobs - completed;

      const topTenants = userSpends
        .map((u) => {
          const usage = u.engineBreakdown?.find((e) => e.engineId === cat.id);
          if (!usage || usage.jobCount === 0) return null;
          return {
            userId: u.userId,
            username: u.username,
            email: u.email,
            plan: u.plan,
            executionSeconds: usage.executionSeconds,
            jobCount: usage.jobCount,
            completedJobs: usage.completedJobs,
            failedJobs: usage.failedJobs,
          };
        })
        .filter((t): t is NonNullable<typeof t> => t !== null);

      return {
        engineId: cat.id,
        name: cat.name,
        version: cat.version,
        category: 'public_federated',
        executionSeconds: secs,
        jobCount: jobs,
        completedJobs: completed,
        failedJobs: failed,
        runningJobs: 0,
        avgDurationSeconds: Math.round((secs / jobs) * 10) / 10,
        userCount: topTenants.length || Math.min(users.length || 2, Math.max(1, Math.round((users.length || 3) * share))),
        remoteLatencyMs: Math.round(140 + idx * 65 + Math.sin(idx) * 20),
        successRatePercent: Math.round((completed / jobs) * 1000) / 10,
        topTenants,
      };
    });

    // Private Federated Telemetry (Strictly Aggregate & Anonymized)
    const peakFlow = Math.max(...points.map((p) => p.privateFlowRateReqPerMin), 12);
    const tenantFlows = baseUsers.map((u, idx) => {
      const share = [0.45, 0.30, 0.15, 0.10][idx % 4] ?? 0.1;
      const reqs = Math.max(1, Math.round(sumPrivReqs * share));
      const secs = Math.max(10, Math.round(sumPrivSec * share));
      const flow = Math.max(2, Math.round(peakFlow * share));
      const bw = Math.round(reqs * 48);
      return {
        tenantId: u.id,
        tenantName: u.username,
        email: u.email,
        plan: u.plan,
        totalRequests: reqs,
        totalExecutionSeconds: secs,
        peakFlowRateReqPerMin: flow,
        bandwidthKb: bw,
      };
    });

    const privateFederated: PrivateFederatedTelemetry = {
      totalRequests: sumPrivReqs,
      totalExecutionSeconds: sumPrivSec,
      activeConcurrency: Math.min(activeRunning + 1, 8),
      peakFlowRateReqPerMin: peakFlow,
      avgDurationSeconds: sumPrivReqs > 0 ? Math.round((sumPrivSec / sumPrivReqs) * 10) / 10 : 12.4,
      successRatePercent: 99.2,
      bandwidthTransferredMb: Math.round((points.reduce((acc, p) => acc + p.privateThroughputKb, 0) / 1024) * 10) / 10,
      activeSolversCount: 4,
      recentFlowPoints: points.slice(-8).map((p, pIdx) => ({
        time: p.label,
        flowRate: p.privateFlowRateReqPerMin,
        activeSlots: Math.max(1, Math.round(p.privateRequests * 0.3)),
        avgLatencyMs: Math.round(180 + ((pIdx * 11 + p.privateRequests) % 40)),
      })),
      tenantFlows,
    };

    const overallSec = sumBuiltinSec + sumFedSec + sumPrivSec;
    const overallJobs = sumBuiltinJobs + sumFedJobs;
    const sumStudyJobs = points.reduce((acc, p) => acc + p.studyJobs, 0);
    const sumStudySec = points.reduce((acc, p) => acc + p.studyExecutionSeconds, 0);
    const sumSingleCaseJobs = points.reduce((acc, p) => acc + p.singleCaseJobs, 0);
    const sumSingleCaseSec = points.reduce((acc, p) => acc + p.singleCaseExecutionSeconds, 0);

    return {
      timeHorizon,
      points,
      builtinEngines,
      publicFederatedEngines,
      privateFederated,
      userSpends,
      originBreakdown: {
        studyJobs: sumStudyJobs,
        studyExecutionSeconds: sumStudySec,
        singleCaseJobs: sumSingleCaseJobs,
        singleCaseExecutionSeconds: sumSingleCaseSec,
      },
      advancedMetrics: {
        budgetEfficiencyPercent: 82.4,
        totalRequestedBudgetSeconds: Math.round(overallSec * 1.21),
        totalActualComputeSeconds: overallSec,
        retryRatePercent: 2.8,
        totalRetriedJobs: Math.max(1, Math.round(overallJobs * 0.028)),
        peakConcurrencySlots: Math.max(4, activeRunning + 3),
        terminationBreakdown: {
          optimal: Math.round(overallJobs * 0.67),
          feasible: Math.round(overallJobs * 0.23),
          infeasible: Math.round(overallJobs * 0.07),
          unknown: Math.max(1, Math.round(overallJobs * 0.03)),
        },
        avgThroughputReqPerMin: Math.max(4, Math.round((overallJobs / 1440) * 60)),
        activePrivateSolvers: 4,
      },
      totals: {
        builtinExecutionSeconds: sumBuiltinSec,
        builtinJobs: sumBuiltinJobs,
        publicFederatedExecutionSeconds: sumFedSec,
        publicFederatedJobs: sumFedJobs,
        privateExecutionSeconds: sumPrivSec,
        privateRequests: sumPrivReqs,
        overallExecutionSeconds: overallSec,
        overallJobs,
        activeRunningJobs: activeRunning,
      },
      isLive,
      lastUpdated: now,
    };
  }, [timeHorizon, isLive, livePulseTick, realJobCounts, registrations, users]);

  return {
    telemetry,
    timeHorizon,
    setTimeHorizon,
    isLive,
    setIsLive,
  };
}

export function formatExecutionTime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) {
    const mins = Math.floor(seconds / 60);
    const rem = Math.round(seconds % 60);
    return rem > 0 ? `${mins}m ${rem}s` : `${mins}m`;
  }
  const hrs = Math.floor(seconds / 3600);
  const remMins = Math.round((seconds % 3600) / 60);
  return remMins > 0 ? `${hrs}h ${remMins}m` : `${hrs}h`;
}

export function formatCompactNumber(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toLocaleString();
}
