import { PALETTE } from '../model/refs.js'
import { append, el } from './dom.js'

/**
 * A generic filter-chip row: one toggle per item, plus a count. Used for both the Owner
 * filter and the Status filter in the board header — same mechanism, different item
 * lists. Owners carry no colour; Statuses do — an item's own `color` (when a known
 * token) tints its chip the same way it tints everything else in the app, so a status
 * chip reads as "the same thing" wherever it appears.
 *
 * Renders nothing at all when there are no items, so the header does not reserve space
 * for a filter with nothing to filter.
 *
 * @param {{ items: Array<{id: string, name: string, color?: string}>,
 *           hidden: Set<string>,
 *           counts: Record<string, number>,
 *           onToggle: (id: string) => void,
 *           onShowAll: () => void }} props
 * @returns {HTMLElement | null}
 */
export function filterBar({ items, hidden, counts, onToggle, onShowAll }) {
  if (items.length === 0) return null

  const bar = el('div', 'chips-bar')

  for (const item of items) {
    const off = hidden.has(item.id)
    const count = counts[item.id] ?? 0
    const colour = item.color && PALETTE.includes(item.color) ? item.color : null

    const classes = ['chip-toggle', off ? 'chip-toggle--off' : '', colour ? `chip-toggle--${colour}` : '']
      .filter(Boolean).join(' ')
    const chip = el('button', classes)
    chip.type = 'button'
    chip.setAttribute('aria-pressed', String(!off))
    chip.title = off ? `Показати «${item.name}»` : `Сховати «${item.name}»`
    chip.addEventListener('click', () => onToggle(item.id))

    append(
      chip,
      el('span', 'chip-toggle__name', undefined, item.name),
      el('span', `chip-toggle__count${off ? '' : ' chip-toggle__count--active'}`, undefined, String(count)),
    )
    append(bar, chip)
  }

  // Only meaningful while something is hidden, so it stays out of the way otherwise.
  if (hidden.size > 0) {
    const all = el('button', 'chip-toggle chip-toggle--all', undefined, 'Усі')
    all.type = 'button'
    all.title = 'Показати всі'
    all.addEventListener('click', onShowAll)
    append(bar, all)
  }

  return bar
}
