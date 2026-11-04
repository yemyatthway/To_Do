import { tr } from '../i18n'
const HOURS = Array.from({ length: 12 }, (_, i) => i + 1)
const MINUTES = Array.from({ length: 60 }, (_, i) => i)

const pad = (n: number) => String(n).padStart(2, '0')

function split(value: string) {
  const [h24, minute] = value.split(':').map(Number)
  return { hour: h24 % 12 || 12, minute, pm: h24 >= 12 }
}

function join(hour: number, minute: number, pm: boolean) {
  return `${pad((hour % 12) + (pm ? 12 : 0))}:${pad(minute)}`
}

/**
 * Hour and minute pickers (native lists, so phones show their scroll wheels) plus an AM/PM key.
 * `value` is 24-hour "HH:MM", same as the rest of the sheet.
 */
export function TimePicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { hour, minute, pm } = split(value)

  return (
    <div className="time-picker">
      <div className="time-wheels" role="group" aria-label={tr('Time')}>
        <label className="time-unit">
          <span className="sr-only">{tr('Hour')}</span>
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
          <span className="sr-only">{tr('Minute')}</span>
          <select className="time-select" value={minute} onChange={(e) => onChange(join(hour, Number(e.target.value), pm))}>
            {MINUTES.map((m) => (
              <option key={m} value={m}>
                {pad(m)}
              </option>
            ))}
          </select>
        </label>
        <div className="segmented time-ampm" role="group" aria-label={tr('AM or PM')}>
          <button type="button" aria-pressed={!pm} onClick={() => onChange(join(hour, minute, false))}>
            {tr('AM')}
          </button>
          <button type="button" aria-pressed={pm} onClick={() => onChange(join(hour, minute, true))}>
            {tr('PM')}
          </button>
        </div>
      </div>
    </div>
  )
}
