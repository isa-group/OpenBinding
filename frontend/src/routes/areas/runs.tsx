import { lazy } from 'react';
import { live } from '../define';
import { moved, type MovedRoute } from '../moved';
import type { RouteDefinition } from '../types';

// Area: runs. Launching and following runs, and the generator lab.

const JobLaunch = lazy(() => import('../../pages/Jobs/JobLaunch').then((module) => ({ default: module.JobLaunch })));
const JobList = lazy(() => import('../../pages/Jobs/JobList').then((module) => ({ default: module.JobList })));
const JobDetail = lazy(() => import('../../pages/Jobs/JobDetail').then((module) => ({ default: module.JobDetail })));
const JobHistory = lazy(() => import('../../pages/Jobs/JobHistory').then((module) => ({ default: module.JobHistory })));
const GeneratorLab = lazy(() => import('../../pages/Generator/GeneratorLab').then((module) => ({ default: module.GeneratorLab })));

export const routes: RouteDefinition[] = [
  live('job-launch', '/app/:org/:project/runs/new', <JobLaunch />),
  live('job-list', '/app/:org/:project/runs', <JobList />),
  live('job-detail', '/app/:org/:project/runs/:job', <JobDetail />),
  live('job-history', '/app/runs', <JobHistory />),
  live('gen-lab', '/app/generator', <GeneratorLab />),
];

const movedAddresses: MovedRoute[] = [
  // The addresses of the run history, the run list, the launcher and a run before the segment became `runs` (slice 14). The query and the
  // hash go on. The static `new` outranks `:job`, so every redirect is one hop.
  moved('job-history-moved', '/app/jobs', '/app/runs'),
  moved('job-list-moved', '/app/:org/:project/jobs', '/app/:org/:project/runs'),
  moved('job-launch-moved', '/app/:org/:project/jobs/new', '/app/:org/:project/runs/new'),
  moved('job-moved', '/app/:org/:project/jobs/:job', '/app/:org/:project/runs/:job'),
];

// The registry reads `moved` from every area module.
export { movedAddresses as moved };
