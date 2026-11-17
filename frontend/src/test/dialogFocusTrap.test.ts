import { describe, expect, it } from 'vitest';

// Every modal dialog keeps OpenBinding's keyboard contract (design §1, "Dialogs are accessible"; SPHERE's own dialogs have
// none): it renders outside the application, focus moves into it and stays there, Escape closes it and focus returns to
// what opened it. That contract lives in core/hooks/useFocusTrap, used by the Modal and by FocusTrapLayer. A file that draws
// a modal dialog (`aria-modal="true"`) must therefore use one of them, or be a dialog body that is only ever mounted inside
// one (SPHERE's ConfirmModal and AlertModal, which DialogHost and the editors wrap).

const sources = import.meta.glob(['/src/**/*.tsx', '!/src/**/*.test.*', '!/src/test/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const TRAPPED = /\buseFocusTrap\b|<FocusTrapLayer\b/;
/** Dialog bodies that draw no layer of their own; every file that mounts one must trap it. */
const BODIES: Record<string, RegExp> = {
  '/src/modules/core/components/confirm-modal/index.tsx': /<ConfirmModal\b/,
  '/src/modules/core/components/alert-modal/index.tsx': /<AlertModal\b/,
};

const modal = (text: string) => /aria-modal="true"/.test(text);

describe('modal dialogs and the focus trap', () => {
  it('finds the modal dialogs of the application', () => {
    expect(Object.entries(sources).filter(([, text]) => modal(text)).length).toBeGreaterThan(5);
  });

  it('draws every modal dialog inside the focus trap', () => {
    const untrapped = Object.entries(sources)
      .filter(([path, text]) => modal(text) && !(path in BODIES) && !TRAPPED.test(text))
      .map(([path]) => path);
    expect(untrapped).toEqual([]);
  });

  it('mounts the dialog bodies only where the focus trap wraps them', () => {
    const exposed = Object.entries(BODIES).flatMap(([body, use]) =>
      Object.entries(sources)
        .filter(([path, text]) => path !== body && use.test(text) && !TRAPPED.test(text))
        .map(([path]) => `${path} mounts ${body}`)
    );
    expect(exposed).toEqual([]);
  });
});
