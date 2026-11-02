// The segment of the runs area (M2.6). Code that builds an address of the run list, the run launcher or a run takes the segment from here.
// The old segment (`jobs`) only survives as the moved addresses of routes/areas/runs.tsx.

/** The segment of the run list, the run launcher and the run page. */
export const RUNS_SEGMENT = 'runs';

/** The run history of the account (all projects). */
export const RUN_HISTORY_PATH = `/app/${RUNS_SEGMENT}`;
