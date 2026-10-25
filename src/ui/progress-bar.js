import { PALETTE } from '../model/refs.js'
import { toPercent } from '../model/tasks.js'
import { append, el } from './dom.js'

/*
 * The painted stage bands, shared by the task dialog's slider and the read-only strip
 * across the top of a card. One implementation, so the two can never disagree about
 * where a stage begins — which is the whole point of showing them in both places.
 *
 * The caller supplies the box: this fills it. The slider insets its box by half a
 * thumb; the card's is the full card width.
 */

/**
 * Two layers: the stages ahead as pale bands, and the same bands saturated, clipped to
 * how far along the task is. The caller's box must be opaque — the pale bands use the
 * very palette tokens that tint a card, so over a tinted background the track dissolves
 * into it and the bar looks like it simply stops.
 *
 * @param {ReadonlyArray<{id: string, color: string, start_percent?: number}>} statuses
 * @param {string} [className] the band's own class, so each caller sizes its own box
 * @returns {{ node: HTMLElement, setPercent: (percent: number) => void }}
 */
export function progressBand(statuses, className = 'progress__band') {
  const node = el('div', className)
  const fill = segments(statuses, ' progress__segments--fill')
  append(node, segments(statuses, ''), fill)

  return {
    node,
    // Clipped rather than resized: resizing would rescale the bands inside, so the
    // colour boundaries would slide as the value changed.
    setPercent: (percent) => fill.style.setProperty('--progress-clip', `${100 - percent}%`),
  }
}

/**
 * One div per stage, placed at the percentage it starts on.
 *
 * Positioned absolutely rather than laid out with flex: a flex row packs from the left
 * and so ignores where the first stage actually starts, which shifted the whole colour
 * map left (and ended it short) on any board whose first stage does not begin at 0.
 */
function segments(statuses, modifier) {
  const row = el('div', `progress__segments${modifier}`)

  if (statuses.length === 0) {
    append(row, el('div', 'progress__seg progress__seg--slate', { left: '0', width: '100%' }))
    return row
  }

  statuses.forEach((s, i) => {
    const start = toPercent(s.start_percent)
    const end = i + 1 < statuses.length ? toPercent(statuses[i + 1].start_percent) : 100
    const span = Math.max(0, end - start)
    if (span === 0) return // a stage starting where the next one does has no band to draw

    const token = PALETTE.includes(s.color) ? s.color : 'slate'
    append(
      row,
      // The 2px shortfall is the gap between bands; absolute placement has no flex gap.
      el('div', `progress__seg progress__seg--${token}`, {
        left: `${start}%`,
        width: `calc(${span}% - 2px)`,
      }),
    )
  })
  return row
}
