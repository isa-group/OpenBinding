export const LIMIT_LABELS: Readonly<Record<string, string>> = {
  tasksLimit: 'Solve jobs',
  solverTimeLimit: 'Solver time',
  federatedTasksLimit: 'Federated solve jobs',
  concurrentTasksLimit: 'Running at once',
  federatedEnginesLimit: 'Registered engines',
  apiKeysLimit: 'API keys',
};

export const MONTHLY_LIMITS: ReadonlySet<string> = new Set([
  'tasksLimit',
  'solverTimeLimit',
  'federatedTasksLimit',
]);

/** Whether a limit is something that gets spent, rather than a ceiling. */
export function isBalance(limitId: string): boolean {
  return limitId in LIMIT_LABELS;
}
