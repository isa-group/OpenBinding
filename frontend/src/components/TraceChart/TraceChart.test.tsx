import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TraceChart } from './TraceChart';
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  LineChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CartesianGrid: () => null, Line: () => null, Tooltip: () => null, XAxis: () => null, YAxis: () => null,
}));
afterEach(() => vi.useRealTimers());
describe('recorded convergence replay', () => {
  it('scrubs and replays actual events, including zero evaluation', () => {
    vi.useFakeTimers();
    render(<TraceChart trace={[{ eval_index: 0, elapsed_ms: 0, best_objective: 4 }, { eval_index: 2, elapsed_ms: 10, best_objective: 1 }]} />);
    expect(screen.getByText(/Event 2\/2/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Replay recorded events'));
    expect(screen.getByText(/Event 1\/2 · 0 evaluations/)).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByText(/Event 2\/2 · 2 evaluations/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Trace event'), { target: { value: '0' } });
    expect(screen.getByText(/Event 1\/2/)).toBeInTheDocument();
  });
  it('does not invent a time axis for evaluation-only evidence', () => {
    render(<TraceChart trace={[{ eval_index: 1, best_objective: 2 }]} />);
    expect(screen.getByRole('button', { name: 'Time' })).toBeDisabled();
    expect(screen.getByText(/Event 1\/1 · 1 evaluations/)).toBeInTheDocument();
  });
  it('rejects non-finite objectives rather than drawing invented events', () => {
    render(<TraceChart trace={[{ best_objective: NaN }, { best_objective: Infinity }]} />);
    expect(screen.getByText('No trace available')).toBeInTheDocument();
  });
});
