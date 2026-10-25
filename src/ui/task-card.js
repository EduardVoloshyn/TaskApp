import { PALETTE } from '../model/refs.js'
import { isTaskCompleted, toPercent } from '../model/tasks.js'
import { append, el } from './dom.js'
import { progressBand } from './progress-bar.js'

/**
 * @param {Object} task
 * @param {{ statuses?: Array<{id: string, name: string, color: string}>,
 *           owner?: {name: string},
 *           editing?: boolean,
 *           todayIso: string }} options
 * @returns {HTMLElement}
 */
export function taskCard(task, { statuses = [], owner, editing = false, todayIso }) {
  // A task's own colour/icon are what style the card — independent of its Status,
  // which is shown as the progress strip across the top. Fall back rather than
  // trusting an unknown token: a hand-typed colour in the Sheet must not produce an
  // unstyled card.
  const colour = PALETTE.includes(task.color) ? task.color : 'slate'
  const completed = isTaskCompleted(task, statuses)

  const classes = [
    'task-card',
    `task-card--${colour}`,
    editing ? 'task-card--editable' : '',
    completed ? 'task-card--completed' : '',
  ].filter(Boolean).join(' ')

  const node = el('div', classes)
  node.dataset.taskId = task.id
  node.title = task.name

  // The same stage bands as the dialog's slider, read-only and hairline-thin, as the
  // card's first line. Replaces the row of per-status boxes: that showed which stage
  // a task had reached, this shows how far through it is, in the same picture the
  // editor uses. Skipped on a completed card, which collapses to one struck line.
  if (!completed) {
    const strip = progressBand(statuses, 'task-card__progress')
    strip.setPercent(toPercent(task.progress_percent))
    append(node, strip.node)
  }

  // Icon then a single space then the name, as one run of inline text — so the space
  // is a real space, not a flex gap that would vanish or drift with the layout.
  const heading = el('div', 'task-card__heading')
  if (task.icon) {
    append(heading, el('span', 'task-card__icon', undefined, task.icon))
    heading.appendChild(document.createTextNode(' '))
  }
  append(heading, el('span', `task-card__name${completed ? ' task-card__name--done' : ''}`, undefined, task.name))
  append(node, heading)

  // Completed: heading only, struck through and truncated — a glanceable "done" row.
  // Colour/editing/click behaviour above are untouched; only the content below the
  // heading collapses.
  if (completed) return node

  const ownerEl = owner && el('div', 'task-card__meta', undefined, owner.name)
  const overdue = Boolean(task.due_date) && task.due_date < todayIso
  const due = task.due_date &&
    el('div', `task-card__due${overdue ? ' task-card__due--overdue' : ''}`, undefined, shortDate(task.due_date, todayIso))
  if (due) due.title = task.due_date

  // Owner on the left, due date pushed to the far right of the same line
  // (margin-left: auto on .task-card__due).
  if (ownerEl || due) {
    append(node, append(el('div', 'task-card__meta-row'), ownerEl, due))
  }

  return node
}

/**
 * `2026-10-22` -> `22.10`, with the year kept only when it is not the current one.
 *
 * The full ISO date is nine characters of a narrow card, and on a board where almost
 * everything is due this month the year and month-prefix are the parts carrying no
 * information. Anything that does not look like an ISO date is passed through as-is
 * rather than mangled — the Sheet is hand-editable.
 */
export function shortDate(iso, todayIso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!match) return iso

  const [, year, month, day] = match
  return year === String(todayIso).slice(0, 4) ? `${day}.${month}` : `${day}.${month}.${year.slice(2)}`
}
