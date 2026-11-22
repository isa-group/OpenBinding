import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { EnvironmentInEffect, UpstreamEventView } from '../../../api/types';
import production from '../../../../../test/fixtures/core/tomatometer.environment.production.json';
import valuesChanged from '../../../../../test/fixtures/core/upstream.tomatometer.event.values-changed.json';
import bindingInvalid from '../../../../../test/fixtures/core/upstream.tomatometer.event.binding-invalid.json';
import { MODE_SECTIONS } from '../presets';
import { OperationsMode } from './operations';

describe('the operations mode', () => {
  it('shows the composition in effect and the adoption history the page mounts', () => {
    expect(MODE_SECTIONS.operations).toEqual(['inEffect', 'events', 'adoptions']);
    render(
      <MemoryRouter>
        <OperationsMode
          sections={MODE_SECTIONS.operations}
          operation={{
            inEffect: production.inEffect as unknown as EnvironmentInEffect,
            adoptions: <p>the history</p>,
            margins: <p>the margins</p>,
          }}
        />
      </MemoryRouter>
    );
    expect(screen.getByRole('region', { name: 'Composition in effect' })).toHaveTextContent(
      '1.0.0'
    );
    expect(screen.getByText('the margins')).toBeInTheDocument();
    expect(screen.getByText('the history')).toBeInTheDocument();
  });

  it('says nothing is adopted, and offers Adopt through the page’s callback', () => {
    const onAdopt = vi.fn();
    render(
      <OperationsMode
        sections={['inEffect']}
        operation={{ inEffect: null, onAdopt, margins: <p>m</p> }}
      />
    );
    expect(screen.getByText(/Nothing is adopted here yet/)).toBeInTheDocument();
    expect(screen.queryByText('m')).toBeNull();
    screen.getByRole('button', { name: 'Adopt a version…' }).click();
    expect(onAdopt).toHaveBeenCalled();
  });

  it('leaves the upstream section out without open events, and lists two with links and the badge', () => {
    const inEffect = production.inEffect as unknown as EnvironmentInEffect;
    const { rerender } = render(
      <MemoryRouter>
        <OperationsMode
          sections={MODE_SECTIONS.operations}
          operation={{ inEffect, events: { items: [], eventHref: () => '/x' } }}
        />
      </MemoryRouter>
    );
    expect(screen.queryByRole('region', { name: 'Upstream changes' })).toBeNull();
    const items = [bindingInvalid, valuesChanged] as unknown as UpstreamEventView[];
    rerender(
      <MemoryRouter>
        <OperationsMode
          sections={MODE_SECTIONS.operations}
          operation={{
            inEffect,
            badge: <span>the badge</span>,
            events: {
              items,
              eventHref: event => `/operation?event=${event.id}`,
              allHref: '/operation',
            },
          }}
        />
      </MemoryRouter>
    );
    const section = screen.getByRole('region', { name: 'Upstream changes' });
    expect(section).toHaveTextContent('Rebinding recommended');
    expect(section).toHaveTextContent('Values changed');
    expect(screen.getByRole('link', { name: 'brevo 2026-10 → 2027-01' })).toHaveAttribute(
      'href',
      `/operation?event=${bindingInvalid.id}`
    );
    expect(screen.getByText('the badge')).toBeInTheDocument();
  });
});
