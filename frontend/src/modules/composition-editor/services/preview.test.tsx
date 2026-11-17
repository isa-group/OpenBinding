import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { CompositionRenderer } from '../../core/components/composition-renderer/CompositionRenderer';
import { readDocument } from '../../core/utils/composition/document';
import { previewModel } from './preview';

const DOCUMENT = readDocument({
  syntaxVersion: '1.0',
  composition: 'shop',
  version: '1.2.0',
  kind: 'application',
  workflow: { seq: ['pick', 'ship'] },
  binding: { pick: { local: true }, ship: { candidate: 'c_ship' } },
  values: { cost: { value: 10, unit: 'EUR/month' } },
});

describe('the preview of a draft', () => {
  it('is the version the draft would be, with the values it declares', () => {
    if (!DOCUMENT) throw new Error('not a document');
    const model = previewModel(DOCUMENT);
    expect(model.version).toMatchObject({ label: '1.2.0', syntaxVersion: '1.0', derivation: null });
    expect(model.status.values).toBe('declared');
    expect(model.values).toEqual([
      { name: 'cost', value: 10, unit: 'EUR/month', status: 'declared' },
    ]);
  });

  it('draws its binding and values in the catalog, not "No version yet"', () => {
    if (!DOCUMENT) throw new Error('not a document');
    render(
      <MemoryRouter>
        <CompositionRenderer model={previewModel(DOCUMENT)} mode="catalog" />
      </MemoryRouter>
    );
    expect(screen.queryByText(/No version yet/)).not.toBeInTheDocument();
    expect(screen.getAllByText('c_ship').length).toBeGreaterThan(0);
    expect(screen.getByText('Not published', { exact: false })).toBeInTheDocument();
  });
});
