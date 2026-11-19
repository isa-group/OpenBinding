import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { EnvironmentInEffect } from '../../../api/types';
import production from '../../../../../test/fixtures/core/tomatometer.environment.production.json';
import { MODE_SECTIONS } from '../presets';
import { OperationsMode } from './operations';

describe('the operations mode', () => {
  it('shows the composition in effect and the adoption history the page mounts', () => {
    expect(MODE_SECTIONS.operations).toEqual(['inEffect', 'adoptions']);
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
});
