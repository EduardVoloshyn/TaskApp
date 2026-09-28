import { buildBoard } from '../model/tasks.js'
import { PALETTE } from '../model/refs.js'
import { append, el } from './dom.js'
import { taskCard } from './task-card.js'

/**
 * The main view: a Category (rows) × Priority (columns) matrix. One delegated click
 * listener on the grid container, since the whole tree is rebuilt on every render —
 * per-card listeners would be constantly re-bound.
 *
 * @param {{ tasks: Array, categories: Array, priorities: Array,
 *           statuses: Array, ownerById: Map,
 *           editing: boolean, todayIso: string,
 *           onOpenTask: (id: string) => void,
 *           onCreateTask: (slot: { categoryId: string, priorityId: string }) => void }} props
 * @returns {HTMLElement}
 */
export function board({
  tasks, categories, priorities, statuses, ownerById, editing, todayIso, onOpenTask, onCreateTask,
}) {
  const { rows, cols, cellsByKey } = buildBoard(tasks, categories, priorities)

  const grid = el('div', 'board', {
    'grid-template-columns': `12rem repeat(${cols.length}, minmax(11rem, 1fr))`,
    'grid-template-rows': `auto repeat(${rows.length}, minmax(4rem, auto))`,
  })

  append(grid, el('div', 'board__corner'))
  for (const col of cols) {
    // A priority's colour is optional and only ever a known token — the orphan column
    // and a priority with no colour set both simply render uncoloured.
    const colour = col.color && PALETTE.includes(col.color) ? col.color : null
    const className = `board__col-label${colour ? ` board__col-label--${colour}` : ''}`
    append(grid, el('div', className, undefined, col.name))
  }

  for (const row of rows) {
    append(grid, el('div', 'board__row-label', undefined, row.name))

    for (const col of cols) {
      const cell = el('div', 'board__cell')
      cell.dataset.categoryId = row.id
      cell.dataset.priorityId = col.id

      const cellTasks = cellsByKey.get(`${row.id}|${col.id}`) || []
      for (const task of cellTasks) {
        append(
          cell,
          taskCard(task, {
            statuses,
            owner: ownerById.get(task.owner_id),
            editing,
            todayIso,
          }),
        )
      }

      append(grid, cell)
    }
  }

  if (editing) attachEditing(grid, onOpenTask, onCreateTask)

  return grid
}

/**
 * A tap on a card opens it; a tap on empty cell space proposes a new task there.
 * A plain `click` listener rather than pointer tracking — there is nothing to drag.
 */
function attachEditing(grid, onOpenTask, onCreateTask) {
  grid.addEventListener('click', (e) => {
    const card = e.target.closest ? e.target.closest('.task-card') : null
    if (card) {
      onOpenTask?.(card.dataset.taskId)
      return
    }

    const cell = e.target.closest ? e.target.closest('.board__cell') : null
    if (cell) {
      onCreateTask?.({ categoryId: cell.dataset.categoryId, priorityId: cell.dataset.priorityId })
    }
  })
}
