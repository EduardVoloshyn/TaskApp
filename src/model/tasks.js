/*
 * Pure task mutations and board grouping. No DOM, no network — every function takes a
 * list and returns a new one, so the whole editing/grouping model is testable in
 * isolation.
 */

/** Not a security measure — an id only has to be unique within one small board. */
export function newId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/**
 * @param {{ name: string, color?: string, icon?: string, status_id?: string,
 *           category_id?: string, priority_id?: string, owner_id?: string,
 *           due_date?: string, notes?: string, id?: string }} spec
 */
export function createTask(spec) {
  return {
    id: spec.id ?? newId(),
    name: (spec.name ?? '').trim(),
    // A task's own colour/icon are independent of its Status's — Status drives the
    // progress strip; colour/icon are the card's own look.
    color: (spec.color ?? '').trim(),
    icon: (spec.icon ?? '').trim(),
    status_id: (spec.status_id ?? '').trim(),
    category_id: (spec.category_id ?? '').trim(),
    priority_id: (spec.priority_id ?? '').trim(),
    owner_id: (spec.owner_id ?? '').trim(),
    due_date: (spec.due_date ?? '').trim(),
    notes: (spec.notes ?? '').trim(),
    // A fraction 0..1, mirroring a Status's start_percent. Stored rather than derived
    // because the user can nudge it within the current stage.
    progress_percent: toFraction(spec.progress_percent),
  }
}

/** A duplicate gets a fresh id; every other field — including colour/icon — is copied verbatim. */
export function duplicateTask(task) {
  return { ...task, id: newId() }
}

/** @param {ReadonlyArray<{id: string}>} tasks @param {string} id */
export function findTask(tasks, id) {
  return tasks.find((t) => t.id === id)
}

function replace(tasks, id, fn) {
  return tasks.map((t) => (t.id === id ? fn(t) : t))
}

/** Field edits from the task dialog. */
export function updateTask(tasks, id, patch) {
  return replace(tasks, id, (t) => {
    const next = { ...t }
    if (patch.name !== undefined) next.name = String(patch.name).trim()
    if (patch.color !== undefined) next.color = String(patch.color).trim()
    if (patch.icon !== undefined) next.icon = String(patch.icon).trim()
    if (patch.status_id !== undefined) next.status_id = String(patch.status_id).trim()
    if (patch.category_id !== undefined) next.category_id = String(patch.category_id).trim()
    if (patch.priority_id !== undefined) next.priority_id = String(patch.priority_id).trim()
    if (patch.owner_id !== undefined) next.owner_id = String(patch.owner_id).trim()
    if (patch.due_date !== undefined) next.due_date = String(patch.due_date).trim()
    if (patch.notes !== undefined) next.notes = String(patch.notes).trim()
    if (patch.progress_percent !== undefined) next.progress_percent = toFraction(patch.progress_percent)
    return next
  })
}

export function deleteTask(tasks, id) {
  return tasks.filter((t) => t.id !== id)
}

/**
 * Whether a task can actually be rendered and saved.
 *
 * The API enforces the same rule, so a task failing this can never reach the Sheet — it
 * can only sit in the local cache blocking every future save.
 *
 * @param {any} task
 * @returns {boolean}
 */
export function isUsableTask(task) {
  if (!task || typeof task !== 'object') return false
  if (typeof task.id !== 'string' || !task.id) return false
  return String(task.name ?? '').trim().length > 0
}

/**
 * Splits a list into what can be kept and what cannot.
 * @param {ReadonlyArray<any>} tasks
 */
export function partitionUsable(tasks) {
  const usable = []
  const dropped = []
  for (const task of tasks || []) (isUsableTask(task) ? usable : dropped).push(task)
  return { usable, dropped }
}

/* ---------------------------------------------------------------- progress ---- */

/**
 * Progress is stored as a fraction 0..1 (same unit as a Status's `start_percent`) and
 * shown as a whole percent. Keeping one conversion point stops the two units drifting
 * apart across the dialog, the card and the Sheet.
 */
export function toFraction(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

export function toPercent(fraction) {
  return Math.round(toFraction(fraction) * 100)
}

export function fromPercent(percent) {
  const n = Number(percent)
  return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) / 100 : 0
}

/**
 * The whole-percent range a task may sit in, given its status.
 *
 * A status owns the span from its own `start_percent` up to just below the next
 * status's — list order is the stage sequence, so "the next status" is literally the
 * next entry. The LAST status is the exception: nothing follows it, so it runs to 100%,
 * which is also the only way a task can ever read as fully done.
 *
 * A task with no status (or one naming a deleted status) is unconstrained: there is no
 * stage to bound it, and refusing to show a value would look like data loss.
 *
 * `Math.max(min, …)` guards a misconfigured sequence where a later status starts lower
 * than an earlier one — the range collapses to a single value instead of inverting.
 *
 * @param {ReadonlyArray<{id: string, start_percent?: number}>} statuses
 * @param {string} statusId
 * @returns {{ min: number, max: number }} whole percents, both inclusive
 */
export function progressBounds(statuses, statusId) {
  const index = statuses.findIndex((s) => s.id === statusId)
  if (index === -1) return { min: 0, max: 100 }

  const min = toPercent(statuses[index].start_percent)
  if (index === statuses.length - 1) return { min, max: 100 }

  return { min, max: Math.max(min, toPercent(statuses[index + 1].start_percent) - 1) }
}

/** The value progress snaps to when a task is moved into a status. */
export function progressForStatus(statuses, statusId) {
  const status = statuses.find((s) => s.id === statusId)
  return status ? toFraction(status.start_percent) : 0
}

/** Pulls a fraction into the range its status allows. */
export function clampProgress(fraction, statuses, statusId) {
  const { min, max } = progressBounds(statuses, statusId)
  return fromPercent(Math.min(max, Math.max(min, toPercent(fraction))))
}

/**
 * A task counts as "completed" when its status is the LAST entry in the Settings
 * Statuses list — purely derived from existing data, nothing new to store or migrate.
 * List order is what "last stage" means, the same order progressBounds walks.
 *
 * @param {Object} task
 * @param {ReadonlyArray<{id: string}>} statuses
 * @returns {boolean}
 */
export function isTaskCompleted(task, statuses) {
  if (!task || !task.status_id || statuses.length === 0) return false
  return task.status_id === statuses.at(-1).id
}

/** Row/column ids used for tasks whose reference has been deleted or was never set. */
export const ORPHAN_CATEGORY_ID = ''
export const ORPHAN_PRIORITY_ID = ''
export const ORPHAN_ROW = { id: ORPHAN_CATEGORY_ID, name: 'Без категорії' }
export const ORPHAN_COL = { id: ORPHAN_PRIORITY_ID, name: 'Без пріоритету' }

/**
 * Groups tasks into a Category (rows) × Priority (columns) matrix.
 *
 * Category and priority are required fields on a task (enforced in the task dialog and
 * server-side), so in the normal case every task has a real home and no orphan row/
 * column is needed. The orphan bucket still exists as a fallback, and is only added to
 * the grid when at least one task actually needs it — e.g. its category or priority was
 * deleted from Settings after the task was created (soft referential integrity: the
 * board must never look like data loss just because a reference list changed, but it
 * also should not permanently show two empty "Без …" rows nobody asked for).
 *
 * @param {ReadonlyArray<Object>} tasks
 * @param {ReadonlyArray<{id: string, name: string}>} categories
 * @param {ReadonlyArray<{id: string, name: string}>} priorities
 * @returns {{ rows: Array, cols: Array, cellsByKey: Map<string, Array> }}
 */
export function buildBoard(tasks, categories, priorities) {
  const categoryIds = new Set(categories.map((c) => c.id))
  const priorityIds = new Set(priorities.map((p) => p.id))

  const isOrphanCategory = (id) => !id || !categoryIds.has(id)
  const isOrphanPriority = (id) => !id || !priorityIds.has(id)

  const needsOrphanRow = tasks.some((t) => isOrphanCategory(t.category_id))
  const needsOrphanCol = tasks.some((t) => isOrphanPriority(t.priority_id))

  const rows = needsOrphanRow ? [...categories, ORPHAN_ROW] : categories
  const cols = needsOrphanCol ? [...priorities, ORPHAN_COL] : priorities

  const cellsByKey = new Map()
  const keyOf = (categoryId, priorityId) => `${categoryId}|${priorityId}`
  for (const row of rows) for (const col of cols) cellsByKey.set(keyOf(row.id, col.id), [])

  for (const task of tasks) {
    const categoryId = isOrphanCategory(task.category_id) ? ORPHAN_CATEGORY_ID : task.category_id
    const priorityId = isOrphanPriority(task.priority_id) ? ORPHAN_PRIORITY_ID : task.priority_id
    cellsByKey.get(keyOf(categoryId, priorityId)).push(task)
  }

  return { rows, cols, cellsByKey }
}
