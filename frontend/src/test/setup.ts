import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// `waitFor` and every `findBy*` query poll within this window, and Testing Library defaults it to
// 1000 ms. That is the budget a React render, its effects and a resolved mock have to meet together,
// and it is the budget the suite was really failing on: 21 of the 25 failures left after the worker
// count was capped were `Unable to find role=...`, which reads like a content failure and is why the
// 15 s `testTimeout` looked responsible when it governed only 2 of them. No test here sets its own.
// A poll returns as soon as the node appears, so a wider window costs a passing test nothing; it is
// paid once, by a test that genuinely fails. 5 s is five times the default and still far inside the
// test budget, so an element that never appears is reported as the element error it is, naming the
// role it could not find, instead of exhausting the test and arriving as an opaque timeout.
configure({ asyncUtilTimeout: 5000 });

afterEach(() => cleanup());

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Object.defineProperty(globalThis, 'ResizeObserver', { value: ResizeObserverStub, configurable: true });

Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }),
});
