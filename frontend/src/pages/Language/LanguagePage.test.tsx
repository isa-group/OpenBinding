import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import examples from '../../content/composition2yaml-examples.json';
import { compositionFragment } from '../../modules/core/utils/sphere/composition-fragment';
import { LanguagePage, SCHEMA_URL, SECTIONS, SPECIFICATION_URL } from './LanguagePage';

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/language']}>
      <LanguagePage />
    </MemoryRouter>
  );
}

describe('LanguagePage', () => {
  it('shows every example with what the gateway says of it, and opens one in the editor', () => {
    renderPage();

    expect(SECTIONS).toEqual(examples.sections);
    const list = screen
      .getByRole('heading', { level: 2, name: 'The language by example' })
      .closest('section') as HTMLElement;
    const cards = within(list).getAllByRole('article');
    expect(cards).toHaveLength(SECTIONS.length);
    for (const [index, example] of SECTIONS.entries()) {
      expect(within(cards[index]).getByRole('heading', { level: 3 })).toHaveTextContent(
        example.name
      );
      expect(cards[index]).toHaveTextContent(
        example.expect === 'valid' ? 'Valid' : `Refused: ${example.expect}`
      );
    }
    const refused = SECTIONS.find(example => example.expect === 'c2y_unknown_key');
    expect(refused?.yaml).toContain('presentation:');

    expect(
      screen.getByRole('link', { name: `Open “${SECTIONS[1].name}” in the editor` })
    ).toHaveAttribute('href', `/editor${compositionFragment(SECTIONS[1].yaml)}`);
    expect(screen.getByRole('link', { name: /Write in the editor/ })).toHaveAttribute(
      'href',
      '/editor'
    );
  });

  it('links to the specification and the schema, and says what is not in the language', () => {
    renderPage();

    expect(screen.getByRole('link', { name: /Read the specification/ })).toHaveAttribute(
      'href',
      SPECIFICATION_URL
    );
    expect(screen.getByRole('link', { name: /Download the schema/ })).toHaveAttribute(
      'href',
      SCHEMA_URL
    );
    expect(SCHEMA_URL).toMatch(/\/v1\/compositions\/schema$/);
    const outside = screen
      .getByRole('heading', { level: 2, name: 'What is not in the language' })
      .closest('section') as HTMLElement;
    expect(outside).toHaveTextContent('Presentation');
    expect(outside).toHaveTextContent('The alternatives');
    const versions = screen
      .getByRole('heading', { level: 2, name: 'Versions of the language' })
      .closest('section') as HTMLElement;
    expect(
      within(versions).getByText('syntaxVersion: "1.0"', { selector: 'code' })
    ).toBeInTheDocument();
  });
});
