// A soft three-note chime made with Web Audio (no sound file). Browsers only allow sound after a
// tap, so the context is created ("primed") when the user presses Start and reused at the end.
let ctx: AudioContext | null = null

export function primeChime() {
  try {
    ctx ??= new AudioContext()
    if (ctx.state === 'suspended') ctx.resume().catch(() => undefined)
  } catch {
    ctx = null
  }
}

export function playChime() {
  if (!ctx) return
  const start = ctx.currentTime + 0.05
  // A gentle rising triad, repeated twice: E5, G#5, B5.
  ;[0, 1].forEach((round) => {
    ;[659.25, 830.61, 987.77].forEach((freq, i) => {
      const t = start + round * 1.1 + i * 0.18
      const osc = ctx!.createOscillator()
      const gain = ctx!.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0, t)
      gain.gain.linearRampToValueAtTime(0.18, t + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.2)
      osc.connect(gain)
      gain.connect(ctx!.destination)
      osc.start(t)
      osc.stop(t + 1.3)
    })
  })
}
