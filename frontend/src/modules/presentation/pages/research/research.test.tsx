import { screen, within } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderModule } from '../../../../test/moduleKit';
import { researchCorpus } from '../../../../content/platform';
import ResearchPage from '.';

// The timeline's cards come in as they scroll into view (framer-motion's whileInView), which jsdom has no observer for.
beforeAll(() => {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    }
  );
});

describe('ResearchPage', () => {
  it('keeps the real sources on a timeline, the numbers and the provenance caveat', () => {
    renderModule(<ResearchPage />, { user: null, entry: '/research' });

    expect(screen.getByRole('heading', { level: 1, name: 'Research' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Sources represented in the executable corpus.' })
    ).toBeInTheDocument();
    expect(screen.getByText(/Authors retain authorship of the original work/)).toBeInTheDocument();
    const facts = within(screen.getByRole('list', { name: 'The executable corpus in numbers' }));
    expect(facts.getByText('6')).toBeInTheDocument();
    expect(facts.getByText('68+')).toBeInTheDocument();

    // The timeline is drawn twice, for wide and narrow screens; CSS shows one.
    const [wide, narrow] = screen.getAllByRole('list', { name: 'Source papers' });
    for (const timeline of [wide, narrow])
      expect(within(timeline).getAllByRole('listitem')).toHaveLength(researchCorpus.length);
    // Newest first.
    expect(within(wide).getAllByRole('heading', { level: 3 })[0]).toHaveTextContent(
      'A Web Service Composition Method Based on OpenAPI Semantic Annotations'
    );
    expect(
      within(wide).getByRole('link', {
        name: 'Declarative Composition and Peer-to-Peer Provisioning of Dynamic Web Services',
      })
    ).toHaveAttribute('href', 'https://doi.org/10.1109/ICDE.2002.994738');
    expect(within(wide).getByText('DOI 10.1109/ICDE.2002.994738')).toBeInTheDocument();
    expect(within(wide).getByText('Corpus · SELF-SERV travel')).toBeInTheDocument();
  });

  it('shows each funder, with a logo only where one exists, and what each project contributes', () => {
    renderModule(<ResearchPage />, { user: null, entry: '/research' });

    const funding = screen.getByRole('region', { name: 'Funding' });
    const sevilla = within(funding).getByRole('link', { name: /Universidad de Sevilla/ });
    expect(sevilla).toHaveAttribute('href', 'https://www.us.es');
    expect(within(sevilla).getByRole('img', { name: 'Universidad de Sevilla' })).toHaveAttribute(
      'src',
      '/brands/universidad-sevilla.svg'
    );
    expect(
      within(within(funding).getByRole('link', { name: /SCORE Lab/ })).queryByRole('img')
    ).not.toBeInTheDocument();
    expect(
      within(funding).getByText(
        /it does not imply that every entity funds every OpenBinding release/
      )
    ).toBeInTheDocument();
    expect(
      within(funding).getByRole('heading', { name: 'What each project contributes' })
    ).toBeInTheDocument();
    expect(within(funding).getByRole('link', { name: /SPACE/ })).toHaveAttribute(
      'href',
      'https://github.com/isa-group/SPACE'
    );
    expect(funding).toHaveAttribute('id', 'funding');
  });

  it('says research and funding are pending review when nothing has been reviewed', () => {
    renderModule(<ResearchPage data={{ research: [], facts: [], funding: [], related: [] }} />, {
      user: null,
      entry: '/research',
    });

    expect(
      screen.getByText('Entries for research appear once they’re reviewed.')
    ).toBeInTheDocument();
    expect(
      screen.getByText('Entries for funding appear once they’re reviewed.')
    ).toBeInTheDocument();
  });
});
