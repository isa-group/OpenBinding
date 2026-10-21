import { useEffect, useId, useRef, useState } from 'react';
import { Maximize2, Redo2, Undo2, ZoomIn, ZoomOut } from 'lucide-react';
import Modeler from 'bpmn-js/lib/Modeler';
import 'bpmn-js/dist/assets/diagram-js.css';
import 'bpmn-js/dist/assets/bpmn-font/css/bpmn.css';
import './BpmnModeler.css';

interface BpmnModelerProps {
  candidateXml: string;
  fallbackXml?: string;
  focusElement?: string | null;
  onValidXml: (xml: string) => void;
  onError: (message: string) => void;
}

interface SelectedElement {
  id: string;
  type: string;
  name: string;
}

interface ShapeLike {
  id: string;
  type: string;
  businessObject?: { name?: string };
}

/** The few services of the modeler this editor uses. bpmn-js types most of them loosely, so each is declared by what it is asked for. */
interface Services {
  canvas: { zoom(level?: number | 'fit-viewport'): number; scrollToElement(element: ShapeLike): void };
  commandStack: { canUndo(): boolean; canRedo(): boolean; undo(): void; redo(): void };
  elementRegistry: { get(id: string): ShapeLike | undefined };
  modeling: { updateProperties(element: ShapeLike, properties: Record<string, unknown>): void };
  selection: { select(element: ShapeLike): void };
}

interface ModelerEvents {
  on<Payload>(name: string, callback: (event: Payload) => void): void;
}

function serviceOf<Name extends keyof Services>(instance: Modeler, name: Name): Services[Name] {
  return (instance as unknown as { get(name: string): unknown }).get(name) as Services[Name];
}

/** Select an element of the diagram and bring it into view. A diagram that is not drawn yet, or an element that is gone, is not an error. */
function showElement(instance: Modeler, id: string) {
  try {
    const element = serviceOf(instance, 'elementRegistry').get(id);
    if (!element) return;
    serviceOf(instance, 'selection').select(element);
    serviceOf(instance, 'canvas').scrollToElement(element);
  } catch {
    // Diagnostics remain useful even when an element was removed meanwhile.
  }
}

/** `bpmn:ServiceTask` as `Service task`. */
function typeLabel(type: string): string {
  const words = type.replace(/^bpmn:/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The visual editor of the workflow diagram. bpmn-js draws the canvas and its palette; the toolbar above and the panel beside
 * it are ours, so they speak the same tokens as the rest of the page (see BpmnModeler.css for the palette and the canvas).
 */
export function BpmnModeler({ candidateXml, fallbackXml = '', focusElement, onValidXml, onError }: BpmnModelerProps) {
  const container = useRef<HTMLDivElement>(null);
  const modeler = useRef<Modeler | null>(null);
  const imported = useRef('');
  const importing = useRef(false);
  /** The element a diagnostic asked for: selected as soon as the diagram has been drawn, which may be after it was asked. */
  const wanted = useRef<string | null>(null);
  const onValid = useRef(onValidXml);
  const onFailure = useRef(onError);
  const nameId = useId();
  const [selected, setSelected] = useState<SelectedElement | null>(null);
  const [history, setHistory] = useState({ undo: false, redo: false });

  useEffect(() => {
    onValid.current = onValidXml;
    onFailure.current = onError;
  }, [onError, onValidXml]);

  useEffect(() => {
    if (!container.current) return;
    const instance = new Modeler({ container: container.current });
    const events = instance as unknown as ModelerEvents;
    modeler.current = instance;
    events.on('commandStack.changed', () => {
      const stack = serviceOf(instance, 'commandStack');
      setHistory({ undo: Boolean(stack.canUndo()), redo: Boolean(stack.canRedo()) });
      if (importing.current) return;
      void instance.saveXML({ format: true }).then(({ xml }) => {
        if (!xml) return;
        imported.current = xml;
        onValid.current(xml);
      }).catch((error) => onFailure.current(String(error)));
    });
    events.on<{ newSelection: ShapeLike[] }>('selection.changed', (event) => {
      const element = event.newSelection[0];
      setSelected(element && element.type !== 'bpmn:Process' && element.type !== 'label'
        ? { id: element.id, type: element.type, name: element.businessObject?.name ?? '' }
        : null);
    });
    return () => {
      modeler.current = null;
      instance.destroy();
    };
  }, []);

  useEffect(() => {
    const instance = modeler.current;
    if (!instance || !candidateXml || candidateXml === imported.current) return;
    let cancelled = false;
    const previousXml = imported.current || (fallbackXml !== candidateXml ? fallbackXml : '');
    importing.current = true;
    void instance.importXML(candidateXml).then(() => {
      if (cancelled || modeler.current !== instance) return;
      imported.current = candidateXml;
      onValid.current(candidateXml);
      const bounds = container.current?.getBoundingClientRect();
      if (bounds?.width && bounds.height) {
        try {
          serviceOf(instance, 'canvas').zoom('fit-viewport');
        } catch {
          // The XML is valid even if a just-mounted canvas cannot fit its viewport yet.
        }
      }
      if (wanted.current) showElement(instance, wanted.current);
    }).catch(async (error) => {
      if (cancelled || modeler.current !== instance) return;
      onFailure.current(`BPMN XML was not applied: ${error instanceof Error ? error.message : String(error)}`);
      if (!previousXml) return;
      try {
        await instance.importXML(previousXml);
        imported.current = previousXml;
      } catch (restoreError) {
        onFailure.current(`The last valid BPMN diagram could not be restored: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`);
      }
    }).finally(() => {
      if (!cancelled && modeler.current === instance) importing.current = false;
    });
    return () => { cancelled = true; };
  }, [candidateXml, fallbackXml]);

  useEffect(() => {
    wanted.current = focusElement ?? null;
    const instance = modeler.current;
    if (instance && focusElement) showElement(instance, focusElement);
  }, [focusElement]);

  const zoomBy = (step: number) => {
    const instance = modeler.current;
    if (!instance) return;
    try {
      const canvas = serviceOf(instance, 'canvas');
      canvas.zoom(Math.max(0.2, Math.min(4, canvas.zoom() + step)));
    } catch {
      // The canvas is not ready yet.
    }
  };
  const fit = () => {
    const instance = modeler.current;
    if (!instance) return;
    try {
      serviceOf(instance, 'canvas').zoom('fit-viewport');
    } catch {
      // The canvas is not ready yet.
    }
  };
  const step = (direction: 'undo' | 'redo') => {
    const instance = modeler.current;
    if (!instance) return;
    try {
      serviceOf(instance, 'commandStack')[direction]();
    } catch {
      // There is nothing to undo or redo.
    }
  };
  const rename = (name: string) => {
    const instance = modeler.current;
    if (!instance || !selected) return;
    const element = serviceOf(instance, 'elementRegistry').get(selected.id);
    if (!element) return;
    serviceOf(instance, 'modeling').updateProperties(element, { name });
    setSelected({ ...selected, name });
  };

  return (
    <div className="wb-bpmn">
      <div className="wb-bpmn-bar" role="toolbar" aria-label="Diagram tools">
        <div className="wb-bpmn-group">
          <button type="button" onClick={() => step('undo')} disabled={!history.undo} aria-label="Undo diagram edit"><Undo2 aria-hidden="true" />Undo</button>
          <button type="button" onClick={() => step('redo')} disabled={!history.redo} aria-label="Redo diagram edit"><Redo2 aria-hidden="true" />Redo</button>
        </div>
        <div className="wb-bpmn-group">
          <button type="button" onClick={() => zoomBy(-0.2)} aria-label="Zoom out"><ZoomOut aria-hidden="true" /></button>
          <button type="button" onClick={() => zoomBy(0.2)} aria-label="Zoom in"><ZoomIn aria-hidden="true" /></button>
          <button type="button" onClick={fit} aria-label="Fit the diagram to the view"><Maximize2 aria-hidden="true" />Fit</button>
        </div>
        <span className="wb-bpmn-hint">Drag shapes from the palette on the left; select one to rename it.</span>
      </div>
      <div className="wb-bpmn-stage">
        <div className="bpmn-modeler" ref={container} aria-label="Editable BPMN diagram" />
        <aside className="wb-bpmn-panel" aria-label="Selected element">
          <span className="wb-bpmn-eyebrow">Selected</span>
          {selected ? (
            <>
              <strong>{typeLabel(selected.type)}</strong>
              <code>{selected.id}</code>
              <label htmlFor={nameId}>Name</label>
              <input id={nameId} value={selected.name} onChange={(event) => rename(event.target.value)} />
            </>
          ) : (
            <p>Select a task, gateway or event to see what it is and rename it.</p>
          )}
        </aside>
      </div>
    </div>
  );
}
