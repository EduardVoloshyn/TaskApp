/*
 * Generic CRUD over a reference list — Statuses, Categories, Priorities and Owners all
 * share the same { id, name, ...extra } shape and the same operations, so one module
 * serves all four instead of four near-duplicate files.
 *
 * For Categories and Priorities, list ORDER is semantic (it is the board's row/column
 * order), so these functions preserve array order exactly: `createRef` appends,
 * `updateRef` replaces in place, `deleteRef` removes without reordering the rest.
 */

/** Colour is always a token, never a free value — shared by Status rows and cards. */
export const PALETTE = ['slate', 'blue', 'red', 'amber', 'green', 'violet', 'teal', 'rose']

/**
 * The curated emoji offered by every icon picker (Statuses in Settings, and a task's
 * own icon) — one shared list so the same glyphs mean the same thing everywhere.
 */
export const ICON_CHOICES = [
  '🇯🇵', '🇺🇦', '🇬🇧', '🦜', '🐍', '📕', '📖', '📓', '📔', '📘', '📙', '📗', '📒', '📚',
  '🌍', '🧪', '🌱', '🔬', '🔭', '📐', '🧮', '🎹', '🎧', '🗣', '📜', '💡', '🏃', '🍽', '💤',
  '👤', '🎨', '🎁',
]

/** Not a security measure — an id only has to be unique within one small list. */
export function newRefId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/** @param {ReadonlyArray<{id: string}>} list @param {Object} spec */
export function createRef(list, spec) {
  return [...list, { ...spec, id: spec.id ?? newRefId() }]
}

/** @param {ReadonlyArray<{id: string}>} list @param {string} id @param {Object} patch */
export function updateRef(list, id, patch) {
  return list.map((item) => (item.id === id ? { ...item, ...patch, id: item.id } : item))
}

/** @param {ReadonlyArray<{id: string}>} list @param {string} id */
export function deleteRef(list, id) {
  return list.filter((item) => item.id !== id)
}

/** @param {ReadonlyArray<{id: string}>} list @param {string} id */
export function findRef(list, id) {
  return list.find((item) => item.id === id)
}

/**
 * Moves one item up or down by swapping it with its neighbour. A no-op at either edge
 * or for an unknown id — this is how the Settings editors let the user re-sort a
 * dictionary (Categories/Priorities' order is the board's row/column order; Owners and
 * Statuses order is cosmetic, but all four are sorted the same way for consistency).
 *
 * @param {ReadonlyArray<{id: string}>} list @param {string} id @param {'up'|'down'} direction
 */
export function moveRef(list, id, direction) {
  const index = list.findIndex((item) => item.id === id)
  if (index === -1) return list
  const target = direction === 'up' ? index - 1 : index + 1
  if (target < 0 || target >= list.length) return list
  const next = [...list]
  ;[next[index], next[target]] = [next[target], next[index]]
  return next
}
