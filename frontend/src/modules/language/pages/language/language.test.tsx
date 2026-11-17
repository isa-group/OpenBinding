import { fireEvent, render, screen, within } from '@testing-library/react';
import { HelmetProvider } from 'react-helmet-async';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import examples from '../../../../content/composition2yaml-examples.json';
import { compositionFragment } from '../../../core/utils/sphere/composition-fragment';
import { SCHEMA_URL, SECTIONS, SPECIFICATION_URL, sectionId } from '../../utils/reference';
import LanguagePage from '.';

function renderPage() {
  return render(
    <HelmetProvider>
      <MemoryRouter initialEntries={['/language']}>
        <LanguagePage />
      </MemoryRouter>
    </HelmetProvider>
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
      expect(
        within(cards[index]).getByRole('heading', { level: 3, name: example.name })
      ).toBeInTheDocument();
      expect(cards[index]).toHaveTextContent(
        example.expect === 'valid' ? 'Valid' : `Refused: ${example.expect}`
      );
      // The source, in the YAML panel.
      expect(cards[index]).toHaveTextContent(example.yaml.split('\n')[0]);
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

  it('indexes every section, as links at lg and a select below', () => {
    renderPage();

    const index = screen.getByRole('navigation', { name: 'Sections' });
    const links = within(index).getAllByRole('link');
    expect(links).toHaveLength(SECTIONS.length + 3);
    expect(links[0]).toHaveAttribute('href', '#lang-versions');
    expect(within(index).getByRole('link', { name: SECTIONS[2].name })).toHaveAttribute(
      'href',
      `#${sectionId(SECTIONS[2].name)}`
    );
    for (const link of links) {
      const target = document.getElementById(link.getAttribute('href')!.slice(1));
      expect(target, link.textContent ?? '').not.toBeNull();
    }

    const select = screen.getByRole('combobox', { name: 'Jump to a section' });
    expect(within(select).getAllByRole('option')).toHaveLength(SECTIONS.length + 3);
    const target = document.getElementById(sectionId(SECTIONS[3].name)) as HTMLElement;
    let scrolled = false;
    target.scrollIntoView = () => {
      scrolled = true;
    };
    fireEvent.change(select, { target: { value: sectionId(SECTIONS[3].name) } });
    expect(scrolled).toBe(true);
    expect(window.location.hash).toBe(`#${sectionId(SECTIONS[3].name)}`);
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
