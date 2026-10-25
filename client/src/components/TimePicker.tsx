const HOURS = Array.from({ length: 12 }, (_, i) => i + 1)
const MINUTES = Array.from({ length: 60 }, (_, i) => i)
const PRESETS = [
  { label: 'Morning', value: '09:00' },
  { label: 'Noon', value: '12:00' },
  { label: 'Afternoon', value: '15:00' },
  { label: 'Evening', value: '18:00' },
  { label: 'Night', value: '21:00' },
]

const pad = (n: number) => String(n).padStart(2, '0')

function split(value: string) {
  const [h24, minute] = value.split(':').map(Number)
  return { hour: h24 % 12 || 12, minute, pm: h24 >= 12 }
}

function join(hour: number, minute: number, pm: boolean) {
  return `${pad((hour % 12) + (pm ? 12 : 0))}:${pad(minute)}`
}

function presetLabel(value: string) {
  const { hour, minute, pm } = split(value)
  return `${hour}${minute ? `:${pad(minute)}` : ''} ${pm ? 'PM' : 'AM'}`
}

/**
 * Hour and minute pickers (native lists, so phones show their scroll wheels) plus an AM/PM key
 * and one-tap presets. `value` is 24-hour "HH:MM", same as the rest of the sheet.
 */
export function TimePicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { hour, minute, pm } = split(value)

  return (
    <div className="time-picker">
      <div className="time-wheels" role="group" aria-label="Time">
        <label className="time-unit">
          <span className="sr-only">Hour</span>
          <select className="time-select" value={hour} onChange={(e) => onChange(join(Number(e.target.value), minute, pm))}>
            {HOURS.map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </select>
        </label>
        <span className="time-colon" aria-hidden="true">
          :
        </span>
        <label className="time-unit">
          <span className="sr-only">Minute</span>
          <select className="time-select" value={minute} onChange={(e) => onChange(join(hour, Number(e.target.value), pm))}>
            {MINUTES.map((m) => (
              <option key={m} value={m}>
                {pad(m)}
              </option>
            ))}
          </select>
        </label>
        <div className="segmented time-ampm" role="group" aria-label="AM or PM">
          <button type="button" aria-pressed={!pm} onClick={() => onChange(join(hour, minute, false))}>
            AM
          </button>
          <button type="button" aria-pressed={pm} onClick={() => onChange(join(hour, minute, true))}>
            PM
          </button>
        </div>
      </div>

      <div className="chips time-presets" role="group" aria-label="Quick times">
        {PRESETS.map((p) => (
          <button key={p.value} type="button" className="chip" aria-pressed={value === p.value} onClick={() => onChange(p.value)}>
            {p.label}
            <span className="preset-time">{presetLabel(p.value)}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
