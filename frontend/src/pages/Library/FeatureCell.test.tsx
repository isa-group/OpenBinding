import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { FeatureSlot } from '../../utils/featureRange';
import { FeatureCell } from './FeatureCell';

/** The cell with the document it edits kept beside it: what the cell writes is what is printed. */
function Harness({ start, disabled = false }: { start?: FeatureSlot; disabled?: boolean }) {
  const [value, setValue] = useState<FeatureSlot | undefined>(start);
  return (
    <>
      <FeatureCell feature="latency" candidate="fast" value={value} disabled={disabled} required onChange={(next) => setValue(next === null ? undefined : next)} />
      <output aria-label="document">{value === undefined ? 'nothing' : JSON.stringify(value)}</output>
    </>
  );
}

const written = () => screen.getByLabelText('document').textContent;
const modes = () => screen.getByRole('group', { name: 'latency for fast: value or range' });
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('FeatureCell', () => {
  it('starts as a single value, with a named switch between value and range', () => {
    render(<Harness start={120} />);

    const group = modes();
    expect(within(group).getByRole('button', { name: 'Value' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(group).getByRole('button', { name: 'Range' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByLabelText('latency for fast')).toHaveValue('120');
    expect(screen.queryByLabelText('latency for fast min')).not.toBeInTheDocument();
  });

  it('keeps the number as a point when it becomes a range', () => {
    render(<Harness start={120} />);

    fireEvent.click(within(modes()).getByRole('button', { name: 'Range' }));

    expect(written()).toBe('{"min":120,"max":120}');
    expect(within(modes()).getByRole('button', { name: 'Range' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('latency for fast min')).toHaveValue('120');
    expect(screen.getByLabelText('latency for fast max')).toHaveValue('120');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('writes the range as it is typed', () => {
    render(<Harness start={{ min: 120, max: 120 }} />);

    type('latency for fast max', '180');
    expect(written()).toBe('{"min":120,"max":180}');
    type('latency for fast min', '0.5');
    expect(written()).toBe('{"min":0.5,"max":180}');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('flags min above max on both fields, keeps what was typed in the document and says why', () => {
    render(<Harness start={{ min: 1, max: 5 }} />);

    type('latency for fast min', '9');

    expect(written()).toBe('{"min":9,"max":5}');
    expect(screen.getByRole('alert')).toHaveTextContent('Min can’t be greater than max.');
    const min = screen.getByLabelText('latency for fast min');
    const max = screen.getByLabelText('latency for fast max');
    expect(min).toHaveAttribute('aria-invalid', 'true');
    expect(max).toHaveAttribute('aria-invalid', 'true');
    expect(min).toHaveAccessibleDescription('Min can’t be greater than max.');

    type('latency for fast min', '2');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(min).not.toHaveAttribute('aria-invalid');
  });

  it('does not order an end that has no limit', () => {
    render(<Harness start={{ min: 1, max: 5 }} />);

    fireEvent.click(screen.getByLabelText('latency for fast: no upper limit'));
    type('latency for fast min', '9000');

    expect(written()).toBe('{"min":9000,"max":null}');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('turns an end into null with “No lower limit”, shows infinity and gives the number back when unticked', () => {
    render(<Harness start={{ min: 5, max: 10 }} />);
    const min = screen.getByLabelText('latency for fast min');

    fireEvent.click(screen.getByLabelText('latency for fast: no lower limit'));
    expect(written()).toBe('{"min":null,"max":10}');
    expect(min).toBeDisabled();
    expect(min).toHaveValue('−∞');
    expect(screen.getByLabelText('latency for fast max')).toHaveValue('10');

    fireEvent.click(screen.getByLabelText('latency for fast: no lower limit'));
    expect(written()).toBe('{"min":5,"max":10}');
    expect(min).toBeEnabled();
    expect(min).toHaveValue('5');
  });

  it('accepts a range with no limits at all', () => {
    render(<Harness start={{ min: 5, max: 10 }} />);

    fireEvent.click(screen.getByLabelText('latency for fast: no lower limit'));
    fireEvent.click(screen.getByLabelText('latency for fast: no upper limit'));

    expect(written()).toBe('{"min":null,"max":null}');
    expect(screen.getByLabelText('latency for fast max')).toHaveValue('+∞');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('leaves an end that was not typed out of the document and asks for it', () => {
    render(<Harness start={{ min: 5, max: 10 }} />);

    type('latency for fast max', '');
    expect(written()).toBe('{"min":5}');
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a number or tick “No upper limit”.');
    expect(screen.getByLabelText('latency for fast max')).toHaveAttribute('aria-invalid', 'true');

    type('latency for fast max', 'abc');
    expect(written()).toBe('{"min":5}');
    expect(screen.getByRole('alert')).toHaveTextContent('Max must be a finite number.');
    expect(screen.getByLabelText('latency for fast max')).toHaveValue('abc');

    type('latency for fast max', '1e999');
    expect(written()).toBe('{"min":5}');
    expect(screen.getByRole('alert')).toHaveTextContent('Max must be a finite number.');
  });

  it('opens an empty cell as a range that needs both ends', () => {
    render(<Harness />);

    fireEvent.click(within(modes()).getByRole('button', { name: 'Range' }));

    expect(written()).toBe('{}');
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a number or tick “No lower limit”.');
    fireEvent.click(within(modes()).getByRole('button', { name: 'Value' }));
    expect(written()).toBe('nothing');
    expect(screen.getByLabelText('latency for fast')).toHaveValue('');
  });

  it('goes back to a single value without asking when nothing is lost', () => {
    render(<Harness start={{ min: 7, max: 7 }} />);

    fireEvent.click(within(modes()).getByRole('button', { name: 'Value' }));

    expect(written()).toBe('7');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByLabelText('latency for fast')).toHaveValue('7');
  });

  it('asks before dropping a limit, keeps the min when it converts and leaves the range when it is refused', () => {
    render(<Harness start={{ min: 120, max: 180 }} />);

    fireEvent.click(within(modes()).getByRole('button', { name: 'Value' }));
    const question = screen.getByRole('alertdialog', { name: 'Convert latency for fast to a single value' });
    expect(question).toHaveTextContent('Convert to 120? This drops the upper limit (180).');
    expect(written()).toBe('{"min":120,"max":180}');

    fireEvent.click(within(question).getByRole('button', { name: 'Keep range' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(written()).toBe('{"min":120,"max":180}');

    fireEvent.click(within(modes()).getByRole('button', { name: 'Value' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Convert' }));
    expect(written()).toBe('120');
    expect(screen.getByLabelText('latency for fast')).toHaveValue('120');
  });

  it('keeps the finite end of an open range and empties the cell when there is none', () => {
    const { unmount } = render(<Harness start={{ min: null, max: 200 }} />);
    fireEvent.click(within(modes()).getByRole('button', { name: 'Value' }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Convert to 200? This drops the lower limit (no limit).');
    fireEvent.click(screen.getByRole('button', { name: 'Convert' }));
    expect(written()).toBe('200');
    unmount();

    render(<Harness start={{ min: null, max: null }} />);
    fireEvent.click(within(modes()).getByRole('button', { name: 'Value' }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('A single value can’t hold a range with no limits. Convert and leave it empty?');
    fireEvent.click(screen.getByRole('button', { name: 'Convert' }));
    expect(written()).toBe('nothing');
  });

  it('closes the question with Escape and is reachable with the keyboard', () => {
    render(<Harness start={{ min: 1, max: 2 }} />);
    const toValue = within(modes()).getByRole('button', { name: 'Value' });
    toValue.focus();
    expect(toValue).toHaveFocus();

    fireEvent.click(toValue);
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(written()).toBe('{"min":1,"max":2}');
    // Every control is a native one, so Tab, Space and Enter work without more.
    expect(within(modes()).getAllByRole('button').every((button) => button.tagName === 'BUTTON')).toBe(true);
    expect(screen.getByLabelText('latency for fast: no lower limit')).toHaveAttribute('type', 'checkbox');
  });

  it('is read-only when the draft is', () => {
    render(<Harness start={{ min: 1, max: null }} disabled />);

    expect(within(modes()).getByRole('button', { name: 'Value' })).toBeDisabled();
    expect(within(modes()).getByRole('button', { name: 'Range' })).toBeDisabled();
    expect(screen.getByLabelText('latency for fast min')).toBeDisabled();
    expect(screen.getByLabelText('latency for fast: no upper limit')).toBeDisabled();
  });

  it('uses the screen’s own field for the single value when it has one', () => {
    function Custom() {
      const [value, setValue] = useState<FeatureSlot | undefined>(10);
      return (
        <FeatureCell
          feature="latency" candidate="fast" value={value} onChange={(next) => setValue(next === null ? undefined : next)}
          valueInput={({ value: current, onChange }) => <input aria-label="fast QoS latency" type="number" value={current ?? ''} onChange={(event) => onChange(event.target.value === '' ? null : Number(event.target.value))} />}
        />
      );
    }
    render(<Custom />);

    expect(screen.getByLabelText('fast QoS latency')).toHaveValue(10);
    fireEvent.click(within(modes()).getByRole('button', { name: 'Range' }));
    expect(screen.queryByLabelText('fast QoS latency')).not.toBeInTheDocument();
    expect(screen.getByLabelText('latency for fast min')).toHaveValue('10');
  });
});
