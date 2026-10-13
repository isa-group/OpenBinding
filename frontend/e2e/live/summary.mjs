// Prints the outcome of a run of playwright.live.config.ts from the JSON report, in lines that are easy to parse:
//   E2E_FAILED project=<name> spec=<file> title="<title>" error="<first line of the error>"
//   E2E_FAILED_DETAIL project=<name> title="<title>" error="<every error of the test, on one line, at most 1200 characters>"
//   VQA_PROBLEMS_BEGIN
//   VQA_TOTAL problems=<n> groups=<n>
//   VQA_GROUP viewport=<size> page=<screen> kind="<kind of problem>" count=<n> examples=["<up to 3 examples>"]   (one per group, at most 40)
//   VQA_GROUPS_OMITTED groups=<n> problems=<n>   (only when there are more than 40 groups; the smallest ones)
//   VQA_PROBLEMS_END
//   E2E_SUMMARY passed=<n> failed=<n> skipped=<n>
// It is the only part of the result the controller can read (the report itself stays in a volume it cannot open), and it reads the
// last lines of the log, so everything that explains a failure is repeated here, below the `list` reporter, in a bounded number of
// lines (MAX_FAILURES * 2 + MAX_GROUPS + 3 + MAX_RUN_ERRORS, about 70). Every finding is counted in a group, so none is hidden.
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const ansi = /\u001b\[[0-9;]*m/g;
const MAX_FAILURES = 10;
const MAX_GROUPS = 40;
const MAX_EXAMPLES = 3;
const EXAMPLE_CHARS = 110;
const MAX_RUN_ERRORS = 5;
const DETAIL_CHARS = 1200;

const plain = (text) => String(text ?? '').replace(ansi, '');
const oneLine = (text) => plain(text).replace(/\s+/g, ' ').trim();

let report;
try {
  report = JSON.parse(readFileSync(file, 'utf8'));
} catch (error) {
  console.log(`E2E_SUMMARY passed=0 failed=0 skipped=0 error="no readable report at ${file}: ${error.message}"`);
  process.exit(0);
}

const failures = [];
const problems = [];
const visit = (suite) => {
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      const results = test.results ?? [];
      // Every attempt may have printed findings (a retry prints them again: the set below keeps one copy).
      for (const result of results) {
        for (const chunk of result.stdout ?? []) {
          for (const line of plain(chunk.text).split('\n')) {
            if (line.startsWith('VQA_PROBLEM ')) problems.push(line.trimEnd());
          }
        }
      }
      if (test.status !== 'unexpected') continue;
      const last = results.at(-1);
      // A test with `expect.soft` reports each failed assertion in `errors`; `error` is only the first of them.
      const errors = (last?.errors?.length ? last.errors : last?.error ? [last.error] : []).map((item) => item.message ?? item.value ?? '');
      const first = (errors[0] ?? 'no error message');
      failures.push({
        project: test.projectName,
        spec: spec.file,
        title: spec.title,
        message: plain(first).split('\n').find((line) => line.trim())?.trim().slice(0, 300) ?? '',
        detail: oneLine(errors.length ? errors.join(' || ') : first).slice(0, DETAIL_CHARS),
      });
    }
  }
  for (const child of suite.suites ?? []) visit(child);
};
for (const suite of report.suites ?? []) visit(suite);

for (const failure of failures.slice(0, MAX_FAILURES)) {
  console.log(`E2E_FAILED project=${failure.project} spec=${failure.spec} title=${JSON.stringify(failure.title)} error=${JSON.stringify(failure.message)}`);
  console.log(`E2E_FAILED_DETAIL project=${failure.project} title=${JSON.stringify(failure.title)} error=${JSON.stringify(failure.detail)}`);
}
if (failures.length > MAX_FAILURES) console.log(`E2E_FAILED_OMITTED ${failures.length - MAX_FAILURES} more failed tests, see the list above`);

for (const error of (report.errors ?? []).slice(0, MAX_RUN_ERRORS)) {
  console.log(`E2E_ERROR ${JSON.stringify(oneLine(error.message ?? error).slice(0, 300))}`);
}

// All the findings of the visual QA, together: they were printed screen by screen, far above this point. They are grouped by
// (viewport, page, kind of problem) so that a kind with many findings cannot push another kind out of the bounded number of lines.
const unique = [...new Set(problems.map((line) => line.trimEnd()))];
if (unique.length) {
  const groups = new Map();
  for (const line of unique) {
    const match = line.match(/^VQA_PROBLEM viewport=(\S*) page=(\S*) (.*)$/s);
    let text = match ? match[3] : line;
    try { text = JSON.parse(text); } catch { /* not a JSON string: keep it as printed */ }
    text = oneLine(text);
    const colon = text.indexOf(': ');
    // "touch target under 24px: a.app-brand ..." is the kind "touch target under 24px"; the rest is the example.
    const kind = (colon > 0 && colon <= 60 ? text.slice(0, colon) : text.slice(0, 60)).trim();
    const example = colon > 0 && colon <= 60 ? text.slice(colon + 2) : text;
    const key = JSON.stringify([match?.[1] ?? '?', match?.[2] ?? '?', kind]);
    const group = groups.get(key) ?? { viewport: match?.[1] ?? '?', page: match?.[2] ?? '?', kind, count: 0, examples: [] };
    group.count += 1;
    if (group.examples.length < MAX_EXAMPLES) group.examples.push(example.slice(0, EXAMPLE_CHARS));
    groups.set(key, group);
  }
  // The biggest first, so that what is left out of the bounded list is the smallest.
  const ordered = [...groups.values()].sort((a, b) => b.count - a.count);
  console.log('VQA_PROBLEMS_BEGIN');
  console.log(`VQA_TOTAL problems=${unique.length} groups=${ordered.length}`);
  for (const group of ordered.slice(0, MAX_GROUPS)) {
    console.log(`VQA_GROUP viewport=${group.viewport} page=${group.page} kind=${JSON.stringify(group.kind)} count=${group.count} examples=${JSON.stringify(group.examples)}`);
  }
  if (ordered.length > MAX_GROUPS) {
    const rest = ordered.slice(MAX_GROUPS);
    console.log(`VQA_GROUPS_OMITTED groups=${rest.length} problems=${rest.reduce((sum, group) => sum + group.count, 0)}, see the VQA_PROBLEM lines above`);
  }
  console.log('VQA_PROBLEMS_END');
}

const stats = report.stats ?? {};
const passed = (stats.expected ?? 0) + (stats.flaky ?? 0);
console.log(`E2E_SUMMARY passed=${passed} failed=${stats.unexpected ?? 0} skipped=${stats.skipped ?? 0}`);
