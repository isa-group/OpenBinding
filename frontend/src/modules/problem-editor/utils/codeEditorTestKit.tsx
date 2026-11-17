import { useEffect, useRef } from 'react';

// Monaco needs a real browser: in the tests the code editor is a text area named as Monaco's is. It hands the screen a small
// stand-in of Monaco's editor and API, so the caret a screen places (`setSelection`) and the markers it sets
// (`setModelMarkers`) are written on the text area as `data-anchor`, `data-head` and `data-marks`. A position is the
// offset in the text plus one, on one line, which is all the screens read back.

interface Range {
  startColumn: number;
  endColumn: number;
}

export default function FakeCodeEditor({
  ariaLabel,
  value,
  language,
  onChange,
  onMount,
}: {
  ariaLabel: string;
  value?: string;
  language?: string;
  onChange?: (value: string | undefined) => void;
  onMount?: (editor: unknown, monaco: unknown) => void;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const mount = useRef(onMount);
  useEffect(() => {
    const model = {
      getValue: () => area.current?.value ?? '',
      getPositionAt: (offset: number) => ({ lineNumber: 1, column: offset + 1 }),
      isDisposed: () => false,
    };
    const editor = {
      getModel: () => model,
      setSelection: (range: Range) => {
        if (!area.current) return;
        area.current.dataset.anchor = String(range.startColumn - 1);
        area.current.dataset.head = String(range.endColumn - 1);
      },
      revealLineInCenter: () => undefined,
      focus: () => undefined,
    };
    const monaco = {
      editor: {
        setModelMarkers: (_model: unknown, _owner: string, markers: unknown[]) => {
          if (area.current) area.current.dataset.marks = String(markers.length);
        },
      },
    };
    mount.current?.(editor, monaco);
  }, []);
  return (
    <textarea
      ref={area}
      aria-label={ariaLabel}
      data-language={language}
      value={value ?? ''}
      onChange={event => onChange?.(event.target.value)}
    />
  );
}
