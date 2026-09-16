import type { Plane, Point } from './archive';

export function clipPolygon(polygon: Point[], plane: Pick<Plane, 'a' | 'b' | 'c'>): Point[] {
  const { a, b, c } = plane;
  const output: Point[] = [];
  polygon.forEach((p, i) => {
    const q = polygon[(i + 1) % polygon.length], dp = a * p[0] + b * p[1] - c, dq = a * q[0] + b * q[1] - c;
    if (dp <= 0) output.push(p);
    if ((dp <= 0) !== (dq <= 0)) { const t = dp / (dp - dq); output.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]); }
  });
  return output;
}
