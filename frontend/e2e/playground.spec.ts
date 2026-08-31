import { readFile } from 'node:fs/promises';
import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { unzipPackage, zipStore } from '../src/utils/bimZip';

const ENGINE = {
  namespace: 'bim.builtin',
  name: 'random-search',
  version: '1.0.0',
  digest: 'sha256-test',
};
const REGISTRATION = {
  namespace: 'bim.builtin',
  name: 'random-search-deployment',
  version: '1.0.0+builtin.test',
  digest: 'sha256-registration-test',
};

const VALID_ANALYSIS = {
  valid: true,
  compatibleModes: [{ engine: ENGINE, registration: REGISTRATION, mode: 'seeded', compatible: true }],
  diagnostics: [],
};

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function importedPackage(name: string): Buffer {
  return Buffer.from(zipStore({
    'instance.json': json({
      apiVersion: 'bim/v1',
      kind: 'Instance',
      metadata: { name },
      spec: {
        profile: 'qos-binding/v1',
        resources: {
          application: { application: 'application.json' },
          candidateCatalog: { catalog: 'candidates.json' },
          optimization: { optimization: 'optimization.json' },
        },
      },
    }),
    'application.json': json({
      apiVersion: 'qos-binding/v1',
      kind: 'Application',
      metadata: { name: `${name}-application` },
      spec: {
        tasks: { hello: 'http' },
        metrics: { latency: { unit: 'ms', domain: 'real', direction: 'minimize', scope: 'invocation', aggregation: 'sum' } },
        workflow: { task: 'hello' },
      },
    }),
    'candidates.json': json({
      apiVersion: 'qos-binding/v1',
      kind: 'CandidateCatalog',
      metadata: { name: `${name}-candidates` },
      spec: {
        metricBindings: { latency: { resource: 'application', id: 'latency' } },
        candidates: { candidate: { provides: 'http', metrics: { latency: 10 } } },
      },
    }),
    'optimization.json': json({
      apiVersion: 'qos-binding/v1',
      kind: 'Optimization',
      metadata: { name: `${name}-optimization` },
      spec: { mode: 'weighted', terms: [{ metric: { resource: 'application', id: 'latency' }, weight: 1 }] },
    }),
  }));
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(body),
  });
}

async function mockExamples(page: Page): Promise<void> {
  await page.route('**/v1/examples', (route) => fulfillJson(route, { examples: ['demo/01_simple_seq'] }));
}

async function workspaceName(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: /instance\.json/i }).click();
  return page.getByLabel('Name');
}

test.beforeEach(async ({ page }) => {
  await mockExamples(page);
});

test('a guided example opens its package directly in Playground', async ({ page }) => {
  await page.route('**/v1/examples/demo/01_simple_seq', (route) => route.fulfill({
    status: 200,
    contentType: 'application/vnd.bim+zip',
    headers: { 'access-control-allow-origin': '*' },
    body: importedPackage('guided-example'),
  }));
  await page.route('**/v1/analyze', (route) => fulfillJson(route, VALID_ANALYSIS));

  await page.goto('/examples');
  await page.getByRole('link', { name: 'Open package' }).first().click();

  await expect(page).toHaveURL(/\/playground\?example=demo%2F01_simple_seq$/);
  await expect(page.getByText('valid', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Name')).toHaveValue('guided-example');
});

test('BIM workspace analyzes and selects only compatible modes', async ({ page }) => {
  await page.route('**/v1/analyze', async (route) => {
    expect(route.request().headers()['content-type']).toContain('application/vnd.bim+zip');
    expect(Array.from(route.request().postDataBuffer()?.subarray(0, 4) || [])).toEqual([0x50, 0x4b, 0x03, 0x04]);
    await fulfillJson(route, VALID_ANALYSIS);
  });
  await page.goto('/playground');
  await expect(page.getByRole('heading', { name: 'BIM Instance Workspace' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'BIM resources' })).toContainText('Candidate catalogs');
  await page.getByRole('button', { name: 'Analyze' }).click();
  await expect(page.getByRole('combobox', { name: 'Compatible engine mode' })).toHaveValue([
    ENGINE.namespace,
    ENGINE.name,
    ENGINE.version,
    ENGINE.digest,
    REGISTRATION.namespace,
    REGISTRATION.name,
    REGISTRATION.version,
    REGISTRATION.digest,
    'seeded',
  ].join('|'));
  await page.getByRole('tab', { name: 'BPMN modeler' }).click();
  await expect(page.getByLabel('BPMN modeler')).toBeVisible();
});

test('a rejected BIM ZIP import is atomic and preserves the last valid workspace', async ({ page }) => {
  let analysisCalls = 0;
  await page.route('**/v1/analyze', async (route) => {
    analysisCalls += 1;
    await fulfillJson(route, analysisCalls === 1 ? VALID_ANALYSIS : {
      valid: false,
      compatibleModes: [],
      diagnostics: [{ code: 'invalid_import', message: 'The replacement package is invalid.', resource: 'application' }],
    });
  });
  await page.goto('/playground');
  const importInput = page.locator('input[type="file"][accept*="bim.zip"]');

  await importInput.setInputFiles({ name: 'accepted.bim.zip', mimeType: 'application/vnd.bim+zip', buffer: importedPackage('accepted-workspace') });
  await expect(page.getByText('valid', { exact: true })).toBeVisible();
  await expect(await workspaceName(page)).toHaveValue('accepted-workspace');

  await importInput.setInputFiles({ name: 'rejected.bim.zip', mimeType: 'application/vnd.bim+zip', buffer: importedPackage('must-not-replace') });
  await expect(page.getByRole('button', { name: /invalid_import The replacement package is invalid/i })).toBeVisible();
  await expect(page.getByLabel('Name')).toHaveValue('accepted-workspace');
  expect(analysisCalls).toBe(2);
});

test('invalid BPMN XML reports a diagnostic without replacing the last valid source or diagram', async ({ page }) => {
  await page.goto('/playground');
  await page.getByRole('tab', { name: 'BPMN XML', exact: true }).click();
  const xmlEditor = page.getByLabel('BPMN XML').getByRole('textbox');
  await xmlEditor.fill('<bpmn:definitions><broken>');
  await expect(page.getByRole('button', { name: /bpmn-editor BPMN XML was not applied/i })).toBeVisible();

  await page.getByRole('button', { name: /workflow\.bpmn/i }).click();
  await page.getByRole('button', { name: 'Expert source' }).click();
  const acceptedSource = page.getByLabel('workflow.bpmn expert source');
  await expect(acceptedSource).toContainText('<?xml version=');
  await expect(acceptedSource).not.toContainText('<broken>');

  await page.getByRole('tab', { name: 'BPMN modeler' }).click();
  await expect(page.locator('.djs-element[data-element-id="hello"]')).toBeVisible();
  await expect(page.getByLabel('BPMN modeler')).toContainText('Hello');
});

test('BPMN and JSON diagnostics navigate to the exact editor target', async ({ page }) => {
  await page.route('**/v1/analyze', (route) => fulfillJson(route, {
    valid: false,
    compatibleModes: [],
    diagnostics: [{
      code: 'unsupported_bpmn',
      message: 'The task is not executable.',
      resource: 'workflow',
      bpmnElement: 'hello',
    }, {
      code: 'missing_metric',
      message: 'latency is required.',
      resource: 'catalog',
      jsonPointer: '/spec/candidates/service-a/metrics/latency',
    }],
  }));
  await page.goto('/playground');
  await page.getByRole('tab', { name: 'BPMN modeler' }).click();
  await expect(page.locator('.djs-element[data-element-id="hello"]')).toBeAttached();
  await page.getByRole('button', { name: 'Analyze' }).click();

  await page.getByRole('button', { name: /unsupported_bpmn The task is not executable/i }).click();
  await expect(page.getByLabel('BPMN modeler')).toBeVisible();
  await expect(page.locator('.djs-element.selected[data-element-id="hello"]')).toBeVisible();

  await page.getByRole('button', { name: /missing_metric latency is required/i }).click();
  const candidateSource = page.getByLabel('candidates.json expert source');
  await expect(candidateSource).toBeVisible();
  await expect(candidateSource).toContainText('service-a');
  await expect(candidateSource.locator('.cm-selectionBackground')).toBeAttached();
});

test('Solve analyzes, snapshots, queues, polls, and renders the authoritative decision', async ({ page }) => {
  let polls = 0;
  await page.route('**/v1/analyze', (route) => fulfillJson(route, VALID_ANALYSIS));
  await page.route('**/v1/instances', async (route) => {
    expect(route.request().method()).toBe('POST');
    expect(Array.from(route.request().postDataBuffer()?.subarray(0, 4) || [])).toEqual([0x50, 0x4b, 0x03, 0x04]);
    await fulfillJson(route, { id: 'snapshot-1', irDigest: 'sha256-ir' }, 201);
  });
  await page.route('**/v1/jobs', async (route) => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers()['idempotency-key']).toBeTruthy();
    expect(route.request().postDataJSON()).toEqual({
      snapshot: 'snapshot-1',
      engine: ENGINE,
      registration: REGISTRATION,
      mode: 'seeded',
      options: {},
    });
    await fulfillJson(route, { id: 'job-1', status: 'queued', irDigest: 'sha256-ir' }, 202);
  });
  await page.route('**/v1/jobs/job-1', async (route) => {
    polls += 1;
    await fulfillJson(route, polls === 1 ? { id: 'job-1', status: 'running' } : {
      id: 'job-1',
      status: 'completed',
      result: {
        termination: 'FEASIBLE',
        solutions: [{
          decision: { kind: 'binding', binding: { hello: { resource: 'catalog', id: 'service-a' } } },
          metrics: { latency: 10 },
          objectives: { latency: 10 },
          penalties: {},
          violations: [],
        }],
      },
    });
  });

  await page.goto('/playground');
  await page.getByRole('button', { name: 'Solve' }).click();
  await expect(page.locator('.workspace-result-summary')).toContainText('FEASIBLE');
  await expect(page.getByRole('cell', { name: 'hello' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'service-a' })).toBeVisible();
  expect(polls).toBe(2);
});

test('exported BIM ZIP imports back with the same canonical workspace content', async ({ page }) => {
  await page.route('**/v1/analyze', (route) => fulfillJson(route, VALID_ANALYSIS));
  await page.goto('/playground');
  const name = await workspaceName(page);
  await name.fill('roundtrip-workspace');

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export .bim.zip' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('roundtrip-workspace.bim.zip');
  const downloadedPath = await download.path();
  expect(downloadedPath).not.toBeNull();
  const exported = await readFile(downloadedPath!);
  const exportedBuffer = exported.buffer.slice(exported.byteOffset, exported.byteOffset + exported.byteLength) as ArrayBuffer;
  const exportedFiles = await unzipPackage(exportedBuffer);
  expect(JSON.parse(exportedFiles['instance.json']).metadata.name).toBe('roundtrip-workspace');

  await name.fill('temporary-change');
  await page.locator('input[type="file"][accept*="bim.zip"]').setInputFiles({
    name: download.suggestedFilename(),
    mimeType: 'application/vnd.bim+zip',
    buffer: exported,
  });
  await expect(page.getByLabel('Name')).toHaveValue('roundtrip-workspace');

  const secondDownloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export .bim.zip' }).click();
  const secondDownload = await secondDownloadPromise;
  const secondPath = await secondDownload.path();
  expect(secondPath).not.toBeNull();
  expect(await readFile(secondPath!)).toEqual(exported);
});
