import { useEffect, useRef } from 'react';
import Modeler from 'bpmn-js/lib/Modeler';
import 'bpmn-js/dist/assets/diagram-js.css';
import 'bpmn-js/dist/assets/bpmn-font/css/bpmn.css';

interface BpmnModelerProps {
  candidateXml: string;
  fallbackXml?: string;
  focusElement?: string | null;
  onValidXml: (xml: string) => void;
  onError: (message: string) => void;
}

export function BpmnModeler({ candidateXml, fallbackXml = '', focusElement, onValidXml, onError }: BpmnModelerProps) {
  const container = useRef<HTMLDivElement>(null);
  const modeler = useRef<Modeler | null>(null);
  const imported = useRef('');
  const importing = useRef(false);
  const onValid = useRef(onValidXml);
  const onFailure = useRef(onError);

  useEffect(() => {
    onValid.current = onValidXml;
    onFailure.current = onError;
  }, [onError, onValidXml]);

  useEffect(() => {
    if (!container.current) return;
    const instance = new Modeler({ container: container.current });
    modeler.current = instance;
    instance.on('commandStack.changed', () => {
      if (importing.current) return;
      void instance.saveXML({ format: true }).then(({ xml }) => {
        if (!xml) return;
        imported.current = xml;
        onValid.current(xml);
      }).catch((error) => onFailure.current(String(error)));
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
          const canvas = instance.get('canvas');
          canvas.zoom('fit-viewport');
        } catch {
          // The XML is valid even if a just-mounted canvas cannot fit its viewport yet.
        }
      }
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
    const instance = modeler.current;
    if (!instance || !focusElement) return;
    try {
      const registry = instance.get('elementRegistry');
      const canvas = instance.get('canvas');
      const selection = instance.get('selection');
      const element = registry.get(focusElement);
      if (element) {
        selection.select(element);
        canvas.scrollToElement(element);
      }
    } catch {
      // Diagnostics remain useful even when an element was removed meanwhile.
    }
  }, [focusElement]);

  return <div className="bpmn-modeler" ref={container} aria-label="Editable BPMN diagram" />;
}
