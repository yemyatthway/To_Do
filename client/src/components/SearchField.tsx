interface SearchFieldProps {
  /** What a screen reader says the box searches. */
  label: string
  placeholder: string
  value: string
  onChange: (value: string) => void
}

export function SearchField({ label, placeholder, value, onChange }: SearchFieldProps) {
  return (
    <label className="admin-search panel-search">
      <span className="sr-only">{label}</span>
      <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-5-5" />
      </svg>
      <input className="field" type="search" placeholder={placeholder} value={value} autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(e) => onChange(e.target.value)} />
    </label>
  )
}
