import { useEffect, useId, useRef, useState } from 'react';
import { formatNumber as fmt, shortId, type ArchiveResponse, type ArchiveQuery, type Point } from '../../analysis/archive';
import { useTheme } from '../../contexts/theme';
import { clipPolygon } from '../../analysis/constraints';

const LEFT = 65, TOP = 30, WIDTH = 575, HEIGHT = 370;

export function ArchiveChart({ data, query, select, change }: {
  data: ArchiveResponse; query: ArchiveQuery; select: (id: string) => void; change: (value: Partial<ArchiveQuery>) => void;
}) {
  const { theme } = useTheme();
  const canvas = useRef<HTMLCanvasElement>(null), svg = useRef<SVGSVGElement>(null);
  const hatch = useId().replaceAll(':', ''), clipId = `${hatch}-clip`;
  const [drag, setDrag] = useState<Point | null>(null);
  const [constraintsOn, setConstraintsOn] = useState(true), [clipOn, setClipOn] = useState(false);
  const budgets = query.view === 'budgets' && data.budgets?.available ? data.budgets : null;
  const geometry = data.geometry?.state === 'complete' ? data.geometry : null;
  const power = geometry?.kind === 'power';
  const interval = power && geometry.axes?.length === 2;
  const bounds = power ? [0, 0, 1, 1] : budgets?.bounds ?? data.plot.bounds;
  const axes = power ? geometry.axes ?? [] : budgets?.axes ?? data.plot.axes;
  const px = (x: number) => LEFT + (x - bounds[0]) / (bounds[2] - bounds[0]) * WIDTH;
  const py = (y: number) => TOP + HEIGHT - (y - bounds[1]) / (bounds[3] - bounds[1]) * HEIGHT;
  const polygon = (points: Point[]) => points.map(([x, y]) => `${px(x)},${py(y)}`).join(' ');
  const selectedCell = geometry?.cells?.find(cell => cell.ids.includes(query.selected ?? ''));
  function line(a: number, b: number, c: number): Point[] {
    const points: Point[] = [];
    if (b) for (const x of [bounds[0], bounds[2]]) { const y = (c-a*x)/b; if (y >= bounds[1] && y <= bounds[3]) points.push([x, y]); }
    if (a) for (const y of [bounds[1], bounds[3]]) { const x = (c-b*y)/a; if (x >= bounds[0] && x <= bounds[2]) points.push([x, y]); }
    return [...new Map(points.map(p => [JSON.stringify(p), p])).values()].slice(0, 2);
  }
  useEffect(() => {
    const context = canvas.current?.getContext('2d');
    if (!context || !canvas.current) return;
    context.clearRect(0, 0, 700, 470);
    if (budgets || power) return;
    const styles = getComputedStyle(canvas.current);
    const teal = styles.getPropertyValue('--color-dialect').trim() || '#0e7b75';
    const red = styles.getPropertyValue('--color-error').trim() || '#b93f36';
    const muted = styles.getPropertyValue('--color-text-tertiary').trim() || '#77827c';
    const resolution = data.plot.resolution ?? 64;
    for (const bin of data.plot.bins) {
      context.globalAlpha = Math.min(.85, .2 + Math.log1p(bin.count) / 10);
      context.fillStyle = bin.infeasible > bin.feasible ? red : bin.feasible ? teal : muted;
      context.fillRect(LEFT + bin.x / resolution * WIDTH, TOP + HEIGHT - (bin.y + 1) / resolution * HEIGHT,
        WIDTH / resolution + .3, HEIGHT / resolution + .3);
    }
    context.globalAlpha = 1;
  }, [data.plot, budgets, power, theme]);
  function location(event: React.PointerEvent<SVGSVGElement> | React.MouseEvent<SVGSVGElement>): Point {
    const rect = svg.current!.getBoundingClientRect();
    return [bounds[0] + ((event.clientX - rect.left) / rect.width * 700 - LEFT) / WIDTH * (bounds[2] - bounds[0]),
      bounds[1] + (TOP + HEIGHT - (event.clientY - rect.top) / rect.height * 470) / HEIGHT * (bounds[3] - bounds[1])];
  }
  function chooseBudget(point: Point) {
    if (!budgets) return;
    const chosenKeys = new Set(axes.map(i => data.dimensions[i].key));
    const requirements = (query.requirements ?? []).filter(r => !chosenKeys.has(r.dimension));
    axes.forEach((axis, i) => requirements.push({ dimension: data.dimensions[axis].key, space: 'raw', value: point[i] * budgets.signs[i] }));
    change({ requirements, page: 0 });
  }
  function choosePriorities(point: Point) {
    if (!power || !geometry || axes.length < 2) return;
    let u = Math.max(0, Math.min(1, point[0])), v = axes.length === 3 ? Math.max(0, Math.min(1, point[1])) : 0;
    if (u + v > 1) { const total = u + v; u /= total; v /= total; }
    const weights = { ...data.weights }, mass = geometry.mass ?? 1;
    weights[data.dimensions[axes[0]].key] = u * mass;
    weights[data.dimensions[axes[1]].key] = (axes.length === 3 ? v : 1-u) * mass;
    if (axes.length === 3) weights[data.dimensions[axes[2]].key] = (1-u-v) * mass;
    change({ weights, page: 0 });
  }
  const description = budgets ? budgets.detail : power ? geometry?.meaning : 'Fixed normalized objective losses; smaller is better. A projection does not establish full-dimensional dominance.';
  return <figure className="analysis-chart">
    <div className="analysis-chart-tools">
      <strong>{budgets ? 'Which budgets can these bindings meet?' : power ? 'Where does each binding win?' : 'Returned binding space'}</strong>
      {!budgets && !power && <div className="analysis-actions">
        <button aria-label="Pan left" onClick={() => change({ viewport: bounds.map((v, i) => i % 2 === 0 ? v-(bounds[2]-bounds[0])*.2 : v), page: 0 })}>←</button>
        <button aria-label="Pan right" onClick={() => change({ viewport: bounds.map((v, i) => i % 2 === 0 ? v+(bounds[2]-bounds[0])*.2 : v), page: 0 })}>→</button>
        <button aria-label="Pan up" onClick={() => change({ viewport: bounds.map((v, i) => i % 2 === 1 ? v+(bounds[3]-bounds[1])*.2 : v), page: 0 })}>↑</button>
        <button aria-label="Pan down" onClick={() => change({ viewport: bounds.map((v, i) => i % 2 === 1 ? v-(bounds[3]-bounds[1])*.2 : v), page: 0 })}>↓</button>
        <button onClick={() => change({ viewport: bounds.map((v, i) => {
          const lo = bounds[i % 2], hi = bounds[i % 2 + 2]; return (lo + hi) / 2 + (v - (lo + hi) / 2) * .7;
        }), page: 0 })}>Zoom in</button>
        <button onClick={() => change({ viewport: null, page: 0 })}>Reset view</button>
      </div>}
    </div>
    {!budgets && !power && <div className="analysis-actions"><label><input type="checkbox" checked={constraintsOn} onChange={e => setConstraintsOn(e.target.checked)} />Model constraint boundaries</label>
      {geometry?.kind === 'voronoi' && <label><input type="checkbox" checked={clipOn} onChange={e => setClipOn(e.target.checked)} />Clip proximity cells to supported hard constraints</label>}</div>}
    <div className="analysis-plot">
      <canvas ref={canvas} width={700} height={470} aria-hidden="true" />
      <svg ref={svg} viewBox="0 0 700 470" role="group" aria-label={budgets ? 'Budget attainment map' : power ? 'Weighted-sum preference map' : 'Binding objective map'}
        onPointerDown={event => { if (event.button === 0) setDrag(location(event)); }}
        onPointerCancel={() => setDrag(null)}
        onPointerUp={event => {
          const point = location(event);
          if (point[0] < bounds[0] || point[0] > bounds[2] || point[1] < bounds[1] || point[1] > bounds[3]) { setDrag(null); return; }
          if (budgets) chooseBudget(point);
          else if (power) choosePriorities(point);
          else if (drag && Math.abs(px(point[0]) - px(drag[0])) > 8 && Math.abs(py(point[1]) - py(drag[1])) > 8) {
            change({ viewport: [Math.min(drag[0], point[0]), Math.min(drag[1], point[1]), Math.max(drag[0], point[0]), Math.max(drag[1], point[1])], page: 0 });
          }
          setDrag(null);
        }}>
        <title>{description}</title>
        <defs>
          <pattern id={hatch} width="9" height="9" patternUnits="userSpaceOnUse"><path d="M0 9L9 0" className="analysis-unknown-line" /></pattern>
          <clipPath id={clipId}><rect x={LEFT} y={TOP} width={WIDTH} height={HEIGHT} /></clipPath>
        </defs>
        {budgets && <rect x={LEFT} y={TOP} width={WIDTH} height={HEIGHT} fill={`url(#${hatch})`} />}
        {Array.from({ length: 6 }, (_, i) => {
          const x = bounds[0] + i / 5 * (bounds[2] - bounds[0]), y = bounds[1] + i / 5 * (bounds[3] - bounds[1]);
          return <g key={i} className="analysis-grid"><path d={`M${px(x)} ${TOP}V${TOP+HEIGHT}M${LEFT} ${py(y)}H${LEFT+WIDTH}`} />
            <text x={px(x)} y={TOP+HEIGHT+22} textAnchor="middle">{fmt(x * (power ? geometry.mass ?? 1 : budgets?.signs[0] ?? 1))}</text>
            {!interval && <text x={LEFT-9} y={py(y)+4} textAnchor="end">{fmt(y * (power ? geometry.mass ?? 1 : budgets?.signs[1] ?? 1))}</text>}</g>;
        })}
        <g clipPath={`url(#${clipId})`}>
          {budgets?.corners.map((corner, i) => <rect key={corner.id} className="analysis-achieved"
            x={px(corner.x)} y={py(bounds[3])} width={Math.max(0, px(budgets.corners[i+1]?.x ?? bounds[2])-px(corner.x))}
            height={Math.max(0, py(corner.y)-py(bounds[3]))}><title>Achieved: witness {shortId(corner.id)}</title></rect>)}
          {budgets?.tiles.map(tile => <rect key={`${tile.x},${tile.y}`} className="analysis-achieved"
            x={LEFT+tile.x/64*WIDTH} y={TOP+HEIGHT-(tile.y+1)/64*HEIGHT} width={WIDTH/64+.2} height={HEIGHT/64+.2}><title>Achieved: witness {shortId(tile.witness)}</title></rect>)}
          {budgets?.excluded.map((plane, i) => {
            const box: Point[] = [[bounds[0], bounds[1]], [bounds[2], bounds[1]], [bounds[2], bounds[3]], [bounds[0], bounds[3]]];
            return <polygon key={i} points={polygon(clipPolygon(box, { a: -plane.a, b: -plane.b, c: -plane.c }))} className="analysis-excluded"><title>Excluded by {plane.label}</title></polygon>;
          })}
          {!budgets && geometry?.cells?.map((cell, i) => <polygon key={cell.ids[0] ?? i} points={polygon(clipOn && constraintsOn && !power ? cell.restrictedPolygon ?? cell.polygon : cell.polygon)}
            className={`analysis-cell ${cell.ids.includes(query.selected ?? '') ? 'selected' : ''}`}
            onPointerDown={event => { if (!power) event.stopPropagation(); }}
            onPointerUp={event => { if (!power) { event.stopPropagation(); select(cell.ids[0]); } }}>
            <title>{cell.ids.map(shortId).join(', ')} · {cell.count} bindings · area {fmt(cell.area)} · {geometry.meaning}</title>
          </polygon>)}
          {!budgets && !power && constraintsOn && data.plot.constraints?.planes.map((plane, i) => {
            const segment = line(plane.a, plane.b, plane.c);
            const box: Point[] = [[bounds[0], bounds[1]], [bounds[2], bounds[1]], [bounds[2], bounds[3]], [bounds[0], bounds[3]]];
            return <g key={i} className="analysis-constraint-overlay">
              {plane.hard && <polygon points={polygon(clipPolygon(box, { a: -plane.a, b: -plane.b, c: -plane.c }))} className="analysis-excluded" />}
              {segment.length === 2 && <polyline points={polygon(segment)} className={`analysis-constraint-line ${plane.hard ? 'hard' : 'soft'}`}><title>{plane.label} · {plane.hard ? 'hard' : 'soft; no exclusion'}</title></polyline>}
            </g>;
          })}
          {!budgets && !power && data.plot.points.map(point => <circle key={point.id} cx={px(point.x)} cy={py(point.y)}
            r={point.id === query.selected ? 7 : point.paretoRank === 1 ? 4.5 : 3.5}
            className={`analysis-point ${point.feasible === false ? 'infeasible' : point.feasible === null ? 'unknown' : 'feasible'} ${point.paretoRank === 1 ? 'front' : ''} ${point.id === query.selected ? 'selected' : ''}`}
            onPointerDown={event => event.stopPropagation()} onPointerUp={event => { event.stopPropagation(); select(point.id); }}>
            <title>{shortId(point.id)} · {point.feasible === true ? 'Feasible' : point.feasible === false ? 'Hard-infeasible' : 'Unknown feasibility'} · {fmt(point.x)}, {fmt(point.y)}</title>
          </circle>)}
          {budgets && budgets.selected.every(v => v !== null) && <g className="analysis-budget-marker">
            <path d={`M${px(budgets.selected[0]!)} ${TOP}V${TOP+HEIGHT}M${LEFT} ${py(budgets.selected[1]!)}H${LEFT+WIDTH}`} />
            <circle cx={px(budgets.selected[0]!)} cy={py(budgets.selected[1]!)} r="7" /></g>}
          {power && axes.length === 3 && <path className="analysis-simplex" d={`M${px(0)} ${py(0)}L${px(1)} ${py(0)}L${px(0)} ${py(1)}Z`} />}
        </g>
        <text className="analysis-axis-label" x={LEFT+WIDTH/2} y="453" textAnchor="middle">{power ? 'Priority: ' : ''}{data.dimensions[axes[0]]?.label ?? 'Objective'}{budgets ? ` (${data.dimensions[axes[0]]?.direction === 'maximize' ? 'at least' : 'at most'})` : ''}</text>
        {!interval && <text className="analysis-axis-label" transform={`translate(15 ${TOP+HEIGHT/2}) rotate(-90)`} textAnchor="middle">{power ? 'Priority: ' : ''}{data.dimensions[axes[1]]?.label ?? 'Objective'}</text>}
      </svg>
    </div>
    <figcaption><p>{description}</p><p>{budgets ? 'Teal: achieved · hatch: unknown · red: excluded by a supported bound. Click to set budgets, or use the requirement inputs.' : power ? 'Click to set priorities, or use the priority inputs. Boundaries may have tied winners; empty cells are valid trade-offs that weighted sum never selects.' : `Teal: feasible · red: hard-infeasible · gray: unknown · orange ring: selected. ${data.plot.aggregated ? `${data.plot.count.toLocaleString()} bindings aggregated into density tiles; highlighted bindings remain individual points.` : `${data.plot.count.toLocaleString()} bindings shown.`} Drag a rectangle to inspect its exact table; zoom does not change recommendations.`}</p>
      {power && <p>The displayed priorities share {fmt((geometry.mass ?? 1)*100)}% of total priority. Other priorities remain fixed and contribute to every score.</p>}
      {power && selectedCell?.polygon.length === 0 && <p>This binding never wins in this weighted-sum slice.</p>}
      {interval && <p>The horizontal winning intervals divide the displayed priority mass between {data.dimensions[axes[0]]?.label} and {data.dimensions[axes[1]]?.label}. Height has no meaning.</p>}
      {!budgets && !power && constraintsOn && <><p>{data.plot.constraints?.meaning}</p>{!!data.plot.constraints?.skipped.length && <details><summary>Constraints not projected</summary>{data.plot.constraints.skipped.map(reason => <p key={reason}>{reason}</p>)}</details>}</>}
      {selectedCell && <p><strong>Selected cell area: {fmt(clipOn && constraintsOn && !power ? selectedCell.restrictedArea : selectedCell.area)}</strong> · shared by {selectedCell.count} binding{selectedCell.count === 1 ? '' : 's'}. {power ? 'Priority coverage in this slice.' : clipOn ? 'Coverage after supported hard-constraint clipping.' : 'Coverage of the fixed normalized square.'} Area is not a quality ranking.</p>}
    </figcaption>
  </figure>;
}

export function ParallelCoordinates({ data, selected, select }: { data: ArchiveResponse; selected?: string; select: (id: string) => void }) {
  const active = data.dimensions.flatMap((d, i) => d.constant ? [] : [i]);
  if (active.length < 2) return null;
  const rows = data.rows.filter(row => row.normalized);
  return <details><summary>Compare all objectives on this table page</summary><svg viewBox="0 0 700 260" className="analysis-parallel" aria-label="Parallel coordinates for the current table page">
    {active.map((j, i) => <g key={j}><path d={`M${40+i*620/(active.length-1)} 25V220`} /><text x={40+i*620/(active.length-1)} y="244" textAnchor="middle">{data.dimensions[j].label}</text></g>)}
    {rows.map(row => <polyline key={row.id} className={row.id === selected ? 'selected' : ''}
      points={active.map((j, i) => `${40+i*620/(active.length-1)},${220-row.normalized![j]*195}`).join(' ')}
      onClick={() => select(row.id)}><title>{shortId(row.id)} · normalized losses; lower is better</title></polyline>)}
  </svg><p>Only the current table page is drawn. All objectives use fixed archive normalization.</p></details>;
}
