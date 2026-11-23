import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { EnvironmentInEffect, UpstreamView } from '../../api/types';
import production from '../../../../test/fixtures/core/tomatometer.environment.production.json';
import upstream from '../../../../test/fixtures/core/tomatometer-email.upstream.json';
import { CompositionInEffect } from '.';

const inEffect = production.inEffect as unknown as EnvironmentInEffect;

describe('the composition in effect', () => {
  it('names the version and its adoption, each task’s candidate and plan, and the offering version read', () => {
    render(
      <MemoryRouter>
        <CompositionInEffect
          inEffect={inEffect}
          upstream={upstream as unknown as UpstreamView}
          versionHref="/v"
        />
      </MemoryRouter>
    );
    const section = screen.getByRole('region', { name: 'In effect' });
    expect(within(section).getByRole('link', { name: '1.0.0' })).toHaveAttribute('href', '/v');
    expect(section).toHaveTextContent('Adoption #3');
    expect(section).toHaveTextContent('“Back to Brevo”');
    const binding = within(section).getByRole('list', { name: 'Binding in effect' });
    expect(within(binding).getAllByRole('listitem')).toHaveLength(4);
    expect(binding).toHaveTextContent('dailySummaryemail.brevo.professional');
    expect(binding).toHaveTextContent('plan PROFESSIONAL');
    expect(section).toHaveTextContent(
      'Offering version 1.0.0, read when this version was evaluated.'
    );
    // Digest hygiene: the feed's ETag and the evaluation's basis are never printed.
    expect(section.textContent).not.toMatch(/sha256-/);
  });

  it('draws the badge it is given beside the heading', () => {
    render(
      <MemoryRouter>
        <CompositionInEffect inEffect={inEffect} badge={<span>2 upstream changes</span>} />
      </MemoryRouter>
    );
    expect(screen.getByRole('region', { name: 'In effect' })).toHaveTextContent(
      '2 upstream changes'
    );
  });
});
