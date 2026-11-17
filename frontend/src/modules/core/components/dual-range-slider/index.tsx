// Adapted from SPHERE frontend/src/modules/pricing/components/dual-range-slider/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: each thumb is named after the filter (`label`), for assistive technology.

interface Props {
  min: number;
  max: number;
  value: [number, number];
  onChange: (value: [number, number]) => void;
  step?: number;
  formatLabel?: (v: number) => string;
  label?: string;
}

export default function DualRangeSlider({
  min,
  max,
  value,
  onChange,
  step = 1,
  formatLabel,
  label = 'Range',
}: Props) {
  const [lo, hi] = value;
  const fmt = formatLabel ?? ((v: number) => String(v));

  const pctLo = ((lo - min) / (max - min || 1)) * 100;
  const pctHi = ((hi - min) / (max - min || 1)) * 100;

  const handleChange = (which: 'lo' | 'hi', raw: number) => {
    const clamped = Math.min(max, Math.max(min, raw));
    if (which === 'lo') {
      onChange([Math.min(clamped, hi), hi]);
    } else {
      onChange([lo, Math.max(clamped, lo)]);
    }
  };

  return (
    <div className="select-none">
      {/* Slider area */}
      <div className="relative h-4">
        {/* Track background */}
        <div className="absolute top-1/2 right-0 left-0 h-1 -translate-y-1/2 rounded-full bg-tp-hairline" />

        {/* Active track */}
        <div
          className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-tp-primary"
          style={{ left: `${pctLo}%`, right: `${100 - pctHi}%` }}
        />

        {/* Low thumb */}
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={lo}
          aria-label={`${label}, lowest`}
          onChange={e => handleChange('lo', Number(e.target.value))}
          className="dual-range-low"
          style={{ zIndex: lo === hi ? 2 : 1 }}
        />

        {/* High thumb */}
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={hi}
          aria-label={`${label}, highest`}
          onChange={e => handleChange('hi', Number(e.target.value))}
          className="dual-range-high"
        />
      </div>

      {/* Value labels — below the track */}
      <div className="pointer-events-none mt-2 flex justify-between text-[10px] text-tp-steel">
        <span>{fmt(lo)}</span>
        <span>{fmt(hi)}</span>
      </div>
    </div>
  );
}
