import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ParamAliases } from './ParamAliases';

function Params() {
  const params = useParams();
  return <output>{JSON.stringify(params)}</output>;
}

describe('ParamAliases', () => {
  it('adds the legacy parameter names next to the new ones', () => {
    render(
      <MemoryRouter initialEntries={['/app/acme/atlas/cases/checkout']}>
        <Routes>
          <Route
            path="/app/:org/:project/cases/:case"
            element={<ParamAliases aliases={{ case: 'caseSlug' }}><Params /></ParamAliases>}
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(JSON.parse(screen.getByRole('status').textContent ?? '')).toEqual({
      org: 'acme', project: 'atlas', case: 'checkout', caseSlug: 'checkout',
    });
  });

  it('leaves a missing optional parameter undefined', () => {
    render(
      <MemoryRouter initialEntries={['/app/acme/atlas/jobs']}>
        <Routes>
          <Route
            path="/app/:org/:project/jobs"
            element={<ParamAliases aliases={{ job: 'jobId' }}><Params /></ParamAliases>}
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(JSON.parse(screen.getByRole('status').textContent ?? '')).toEqual({ org: 'acme', project: 'atlas' });
  });
});
