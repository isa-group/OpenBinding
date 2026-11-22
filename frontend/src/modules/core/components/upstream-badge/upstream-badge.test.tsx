import { readFileSync } from 'node:fs';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { EnvironmentUpstreamSummary, UpstreamSummary } from '../../api/types';
import composition from '../../../../test/fixtures/core/upstream.tomatometer.composition.json';
import production from '../../../../test/fixtures/core/upstream.tomatometer.environment.production.json';
import { UpstreamBadge } from '.';

const counts = (over: Partial<UpstreamSummary>): UpstreamSummary => ({
  open: 0,
  reviewed: 0,
  bindingInvalid: 0,
  worst: null,
  ...over,
});

const draw = (upstream: UpstreamSummary | EnvironmentUpstreamSummary | null, to?: string) =>
  render(
    <MemoryRouter>
      <p data-testid="host">
        <UpstreamBadge upstream={upstream} to={to} />
      </p>
    </MemoryRouter>
  );

describe('the upstream badge', () => {
  it('draws nothing without counts or with every count at zero', () => {
    draw(null);
    expect(screen.getByTestId('host')).toBeEmptyDOMElement();
    draw(counts({}));
    expect(screen.getAllByTestId('host')[1]).toBeEmptyDOMElement();
  });

  it('is amber with the open count when values changed, and names the worst category', () => {
    draw(counts({ open: 2, worst: 'values_changed' }));
    const pill = screen.getByText('2 upstream changes');
    expect(pill.className).toContain('amber');
    expect(pill).toHaveAttribute('title', '2 open upstream changes. The worst: values changed.');
  });

  it('is rose and recommends rebinding when any event says the binding is invalid', () => {
    draw(counts({ open: 1, reviewed: 1, bindingInvalid: 1, worst: 'binding_invalid' }));
    const pill = screen.getByText('Rebinding recommended');
    expect(pill.className).toContain('rose');
    expect(pill.getAttribute('title')).toContain('1 open upstream change, 1 reviewed');
  });

  it('is neutral with the reviewed count when only reviewed events remain', () => {
    draw(counts({ reviewed: 1, worst: 'values_changed' }));
    const pill = screen.getByText('1 reviewed');
    expect(pill.className).toContain('tp-surface');
  });

  it('says on an environment that a newer version resolved its change and is not adopted there', () => {
    draw({
      ...counts({}),
      resolvedBy: { version: { id: 'v', label: '1.2.0' } },
    } as EnvironmentUpstreamSummary);
    expect(screen.getByText('Resolved in 1.2.0, not adopted here')).toBeInTheDocument();
  });

  it('draws the gateway fixtures as they come, and leads where it is told', () => {
    draw(composition.upstream as UpstreamSummary, '/compositions/fixtures/tomatometer/operation');
    expect(screen.getByRole('link', { name: '1 upstream change' })).toHaveAttribute(
      'href',
      '/compositions/fixtures/tomatometer/operation'
    );
    draw(production.upstream as EnvironmentUpstreamSummary);
    expect(screen.getAllByText('1 upstream change')).toHaveLength(2);
  });

  it('never reads a number from text', () => {
    for (const file of ['index.tsx', 'badgeTones.ts']) {
      const source = readFileSync(
        `${process.cwd()}/src/modules/core/components/upstream-badge/${file}`,
        'utf8'
      );
      expect(source, file).not.toMatch(/parseFloat|parseInt|Number\(/);
    }
  });
});
