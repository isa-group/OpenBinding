declare module 'bpmn-js/lib/Modeler' {
  interface Canvas {
    zoom(level: 'fit-viewport'): void;
    scrollToElement(element: unknown): void;
  }

  interface ElementRegistry {
    get(id: string): unknown;
  }

  interface Selection {
    select(element: unknown): void;
  }

  export default class Modeler {
    constructor(options: { container: HTMLElement | string });
    importXML(xml: string): Promise<{ warnings: unknown[] }>;
    saveXML(options?: { format?: boolean }): Promise<{ xml?: string }>;
    get(service: 'canvas'): Canvas;
    get(service: 'elementRegistry'): ElementRegistry;
    get(service: 'selection'): Selection;
    get(service: string): unknown;
    on(event: string, callback: () => void): void;
    destroy(): void;
  }
}
