/** A point on the clock face: `deg` degrees clockwise from 12 o'clock, `r` from the centre. */
function point(deg: number, r: number) {
  const rad = (deg * Math.PI) / 180
  return [Math.sin(rad) * r, -Math.cos(rad) * r] as const
}

/** An arc along the face: `span` degrees clockwise from `start` (a task's time and length). */
export function arcPath(start: number, span: number, r: number) {
  const [x0, y0] = point(start, r)
  const [x1, y1] = point(start + span, r)
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${span > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`
}
