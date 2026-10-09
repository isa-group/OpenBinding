import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { EngineRegistrationReport } from '../../api/client';
import { RegistrationReportView } from './EngineReportView';

const DIGEST = `sha256-${'ab12'.repeat(16)}`;

function registration(report: EngineRegistrationReport['report'], openapiDigest: string | null = DIGEST): EngineRegistrationReport {
  return { namespace: 'lucia', name: 'edge-solver', version: '0.3.1', digest: DIGEST, status: 'private', active: true, openapiDigest, openapi: null, engine: null, report };
}

describe('registration conformance report', () => {
  it('shows the verdict, the pinned digests and each check as a row', () => {
    render(<RegistrationReportView registration={registration({
      protocol: 'bim-engine/v1',
      protocolDigest: `sha256-${'cd34'.repeat(16)}`,
      status: 'failed',
      verifiedAt: '2026-09-25T11:55:00Z',
      checks: [
        { id: 'health', status: 'passed' },
        { name: 'openapi', result: 'failed', detail: 'Document is missing' },
        'a check the gateway wrote oddly',
      ],
    })} />);

    expect(screen.getByText('Conformance failed')).toBeInTheDocument();
    expect(screen.getByText('3 checks · verified Sep 25, 2026, 11:55 UTC')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy protocol bim-engine/v1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy openapi document digest' })).toBeInTheDocument();

    const table = screen.getByRole('region', { name: 'Conformance checks' });
    expect(within(table).getByRole('row', { name: /health passed —/ })).toBeInTheDocument();
    expect(within(table).getByRole('row', { name: /openapi failed Document is missing/ })).toBeInTheDocument();
    expect(within(table).getByRole('row', { name: /check 3 pending —/ })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('"checks"');
  });

  it('says so when the gateway has not recorded a report yet', () => {
    render(<RegistrationReportView registration={registration(null)} />);
    expect(screen.getByText(/has not recorded a conformance report for this registration yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy openapi document digest' })).toBeInTheDocument();
  });

  it('reads a passed report without individual checks', () => {
    render(<RegistrationReportView registration={registration({ protocol: 'bim-engine/v1', status: 'verified', checks: [], durationMs: 1234 }, null)} />);
    expect(screen.getByText('Conformance passed')).toBeInTheDocument();
    expect(screen.getByText('0 checks · 1,234 ms')).toBeInTheDocument();
    expect(screen.getByText('The report lists no individual checks.')).toBeInTheDocument();
  });
});
