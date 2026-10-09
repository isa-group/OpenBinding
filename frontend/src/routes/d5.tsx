import { lazy } from 'react';
import { live, pending } from './define';
import type { RouteDefinition } from './types';

// D5 · Execution (4 screens)

const JobsPage = lazy(() => import('../pages/Platform/JobsPage').then((module) => ({ default: module.JobsPage })));

export const d5Routes: RouteDefinition[] = [
  pending('job-launch', '/app/:org/:project/jobs/new'),
  live('job-list', '/app/:org/:project/jobs', <JobsPage />),
  live('job-detail', '/app/:org/:project/jobs/:job', <JobsPage />, { paramAliases: { job: 'jobId' } }),
  pending('job-history', '/app/jobs'),
];
