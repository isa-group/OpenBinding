// Adapted from SPHERE frontend/src/modules/pricing/components/slider-filter/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the histogram bars use the muted token instead of SPHERE's palette module, and the sliders the primary token
// instead of the undefined `sphere-primary-500` class.

import { useEffect, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

export default function SliderFilter({
  label,
  min,
  max,
  data,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  data: { value: string; count: number }[];
  onChange: (range: number[]) => void;
}) {
  const [marks, setMarks] = useState(data.map(d => d.value));
  const [range, setRange] = useState<number[]>([0, max]);

  const calculateInterval = () => {
    const selectedMarks = marks.filter(value => {
      const numericValue = parseFloat(value.replace('+', ''));
      return numericValue >= range[0] && numericValue <= range[1];
    });

    if (selectedMarks.length === 0) return `${min} — ${max}`;

    const lowerLimit = selectedMarks[0].split('-')[0];
    const upperLimit =
      selectedMarks[selectedMarks.length - 1].split('-')[1] ||
      `${selectedMarks[selectedMarks.length - 1]}`;

    return `${lowerLimit} — ${upperLimit}`;
  };

  const getNearestMark = (value: number) => {
    return marks.reduce((previous, current) =>
      Math.abs(parseFloat(current.replace('+', '')) - value) <
      Math.abs(parseFloat(previous.replace('+', '')) - value)
        ? current
        : previous
    );
  };

  const handleRangeChange = (side: 'start' | 'end', value: number) => {
    const nearestValue = parseFloat(getNearestMark(value).replace('+', ''));

    const nextRange: number[] =
      side === 'start'
        ? [nearestValue, Math.max(nearestValue, range[1])]
        : [Math.min(range[0], nearestValue), nearestValue];

    setRange(nextRange);
    onChange(nextRange);
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- SPHERE's code, kept as copied
    setMarks(data.map(d => d.value));
    setRange([range[0], max]);
  }, [data]);

  return (
    <div className="mx-auto w-full max-w-[500px] p-4">
      <h3 className="mb-2 text-xl font-semibold">{label}</h3>

      <ResponsiveContainer width="100%" height={100}>
        <BarChart data={data}>
          <XAxis dataKey="value" hide />
          <YAxis hide />
          <Tooltip
            labelFormatter={(value: string) => `[${value}]`}
            formatter={(value: string) => `${value} pricings`}
          />
          <Bar dataKey="count" fill="var(--color-tp-muted)" />
        </BarChart>
      </ResponsiveContainer>

      <div className="mt-2 flex justify-center">
        <p className="text-[15px] font-bold">{calculateInterval()}</p>
      </div>

      <div className="mt-4 flex flex-col gap-3">
        <label className="text-sm font-medium text-slate-700">
          Min
          <input
            type="range"
            min={0}
            max={marks.length > 0 ? parseFloat(marks[marks.length - 1].replace('+', '')) : max}
            step={1}
            value={range[0]}
            onChange={e => handleRangeChange('start', Number(e.target.value))}
            className="mt-2 w-full accent-tp-primary"
          />
        </label>
        <label className="text-sm font-medium text-slate-700">
          Max
          <input
            type="range"
            min={0}
            max={marks.length > 0 ? parseFloat(marks[marks.length - 1].replace('+', '')) : max}
            step={1}
            value={range[1]}
            onChange={e => handleRangeChange('end', Number(e.target.value))}
            className="mt-2 w-full accent-tp-primary"
          />
        </label>
      </div>
    </div>
  );
}
