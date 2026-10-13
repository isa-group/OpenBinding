// Prints the outcome of a run of playwright.live.config.ts from the JSON report, in lines that are easy to parse:
//   E2E_FAILED project=<name> spec=<file> title="<title>" error="<first line of the error>"
//   E2E_SUMMARY passed=<n> failed=<n> skipped=<n>
// It is the only part of the result the controller can read (the report itself stays in a volume it cannot open).
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const ansi = /\u001b\[[0-9;]*m/g;

let report;
try {
  report = JSON.parse(readFileSync(file, 'utf8'));
} catch (error) {
  console.log(`E2E_SUMMARY passed=0 failed=0 skipped=0 error="no readable report at ${file}: ${error.message}"`);
  process.exit(0);
}

const failures = [];
const visit = (suite) => {
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      if (test.status !== 'unexpected') continue;
      const results = test.results ?? [];
      const message = (results.at(-1)?.error?.message ?? 'no error message').replace(ansi, '').split('\n').find((line) => line.trim()) ?? '';
      failures.push({ project: test.projectName, spec: spec.file, title: spec.title, message: message.trim().slice(0, 300) });
    }
  }
  for (const child of suite.suites ?? []) visit(child);
};
for (const suite of report.suites ?? []) visit(suite);
for (const failure of failures) {
  console.log(`E2E_FAILED project=${failure.project} spec=${failure.spec} title=${JSON.stringify(failure.title)} error=${JSON.stringify(failure.message)}`);
}
for (const error of report.errors ?? []) {
  console.log(`E2E_ERROR ${JSON.stringify(String(error.message ?? error).replace(ansi, '').split('\n')[0].slice(0, 300))}`);
}

const stats = report.stats ?? {};
const passed = (stats.expected ?? 0) + (stats.flaky ?? 0);
console.log(`E2E_SUMMARY passed=${passed} failed=${stats.unexpected ?? 0} skipped=${stats.skipped ?? 0}`);
