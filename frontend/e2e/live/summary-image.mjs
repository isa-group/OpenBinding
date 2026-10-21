// Renders the outcome of a run as one image, $E2E_RESULTS_DIR/screenshots/_summary.png, from the same report.json as summary.mjs.
// The log reaching the controller is a window of about 8 KB of mixed logs and the block of this service may fall outside it; the
// controller can always list and see the images of the volume (lab_screenshot path screenshots/_summary.png).
// Whatever goes wrong here is only logged: the exit code is always 0, so `done` is still created.
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { chromium } from '@playwright/test';
import { aggregate } from './summary.mjs';

const MAX_FAILURES = 30;
const MAX_ERROR_CHARS = 300;
const MAX_GROUPS = 40;

const escape = (text) => String(text ?? '').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);

export function summaryHtml(summary, now = new Date()) {
  const { failures, ordered, problemCount, passed, failed, skipped } = summary;
  const clean = failed === 0 && problemCount === 0;
  const headline = `${passed} passed, ${failed} failed, ${problemCount} visual problems`;
  const failureRows = failures.slice(0, MAX_FAILURES).map((failure) =>
    `<li><b>${escape(failure.project)}</b> ${escape(failure.title)}<pre>${escape(failure.message.slice(0, MAX_ERROR_CHARS))}</pre></li>`).join('');
  const groupRows = ordered.slice(0, MAX_GROUPS).map((group) =>
    `<li>VQA_GROUP viewport=${escape(group.viewport)} page=${escape(group.page)} kind="${escape(group.kind)}" count=${group.count}</li>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body { margin: 0; padding: 24px; font: 16px/1.4 sans-serif; background: #fff; color: #111; }
h1 { margin: 0 0 8px; font-size: 56px; color: ${clean ? '#0a7a2f' : '#b00020'}; }
h2 { margin: 24px 0 8px; font-size: 24px; }
pre { margin: 4px 0 12px; white-space: pre-wrap; word-break: break-word; font-size: 14px; color: #600; }
ul { padding-left: 24px; } code, li.vqa { font-family: monospace; font-size: 14px; }
</style></head><body>
<h1>${escape(headline)}</h1>
<div>${now.toISOString()} UTC</div>
<div><code>E2E_SUMMARY passed=${passed} failed=${failed} skipped=${skipped}</code></div>
${failures.length ? `<h2>Failed tests (${failures.length})</h2><ul>${failureRows}</ul>` : ''}
${failures.length > MAX_FAILURES ? `<div>${failures.length - MAX_FAILURES} more failed tests not shown</div>` : ''}
${problemCount ? `<h2><code>VQA_TOTAL problems=${problemCount} groups=${ordered.length}</code></h2><ul>${groupRows}</ul>` : ''}
${ordered.length > MAX_GROUPS ? `<div>${ordered.length - MAX_GROUPS} smaller groups not shown</div>` : ''}
</body></html>`;
}

async function main(file, results) {
  const summary = aggregate(JSON.parse(readFileSync(file, 'utf8')));
  const out = `${results}/screenshots/_summary.png`;
  mkdirSync(dirname(out), { recursive: true });
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 600 } });
    await page.setContent(summaryHtml(summary));
    await page.screenshot({ path: out, fullPage: true });
  } finally {
    await browser.close();
  }
  console.log(`e2e: summary image written to ${out}`);
}

main(process.argv[2], process.env.E2E_RESULTS_DIR ?? '/results').catch((error) => {
  console.log(`e2e: summary image not written: ${error?.message ?? error}`);
}).finally(() => { process.exitCode = 0; });
