import { PALETTE } from '../model/refs.js'
import { statusProgress } from '../model/tasks.js'
import { append, el } from './dom.js'

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
  // which is shown separately as the progress bar below. Fall back rather than
  // trusting an unknown token: a hand-typed colour in the Sheet must not produce an
  // unstyled card.
  const colour = PALETTE.includes(task.color) ? task.color : 'slate'

  const classes = ['task-card', `task-card--${colour}`, editing ? 'task-card--editable' : '']
    .filter(Boolean)
    .join(' ')

  const node = el('div', classes)
  node.dataset.taskId = task.id
  node.title = task.name

  // Icon then a single space then the name, as one run of inline text — so the space
  // is a real space, not a flex gap that would vanish or drift with the layout.
  const heading = el('div', 'task-card__heading')
  if (task.icon) {
    append(heading, el('span', 'task-card__icon', undefined, task.icon))
    heading.appendChild(document.createTextNode(' '))
  }
  append(heading, el('span', 'task-card__name', undefined, task.name))
  append(node, heading)

  const bar = statusBar(statuses, task)
  const ownerEl = owner && el('div', 'task-card__meta', undefined, owner.name)
  const overdue = Boolean(task.due_date) && task.due_date < todayIso
  const due = task.due_date &&
    el('div', `task-card__due${overdue ? ' task-card__due--overdue' : ''}`, undefined, task.due_date)

  // Progress bar and owner share the left side of one line; the due date is pushed to
  // the far right of that same line (margin-left: auto on .task-card__due).
  if (bar || ownerEl || due) {
    append(node, append(el('div', 'task-card__status-row'), bar, ownerEl, due))
  }

  if (task.notes) append(node, el('div', 'task-card__notes', undefined, '📝'))

  return node
}

/**
 * Status as a row of small boxes — one per defined status, filled up to the task's
 * current stage — rather than a name, so progress reads at a glance across a whole
 * board of cards. Renders nothing when no statuses are defined yet.
 */
function statusBar(statuses, task) {
  if (statuses.length === 0) return null

  const progress = statusProgress(statuses, task)
  const bar = el('div', 'task-card__status-bar')
  bar.title = progress.some((s) => s.filled)
    ? progress.filter((s) => s.filled).at(-1).name
    : 'Без статусу'

  for (const s of progress) {
    // Each box can need a different token's colour than the card itself, so the colour
    // is set as a nested var() reference on a per-box custom property rather than via a
    // combinatorial set of modifier classes.
    const token = s.filled ? (PALETTE.includes(s.color) ? s.color : 'slate') : null
    const style = token ? { '--status-box-bg': `var(--${token}-line)` } : undefined
    const box = el('div', `task-card__status-box${s.filled ? ' task-card__status-box--filled' : ''}`, style)
    box.title = s.name
    append(bar, box)
  }

  return bar
}
