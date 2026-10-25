/** One block per task (a bar when there are too many to tell apart), filled for done ones. */
export function Segments({ done, total }: { done: number; total: number }) {
  if (total > 12) {
    return (
      <div className="bar">
        <span style={{ width: `${Math.round((done / total) * 100)}%`, background: 'var(--okFill)' }} />
      </div>
    )
  }
  const count = Math.max(total, 1)
  return (
    <div className="segments">
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className={i < done ? 'filled' : ''} />
      ))}
    </div>
  )
}
