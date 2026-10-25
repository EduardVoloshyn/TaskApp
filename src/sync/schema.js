/*
 * The Sheet's shape, mirrored client-side.
 *
 * The single source of truth for the Sheet's layout. Adding a column here is enough to
 * start reading and writing it: reads map by header name, so the Sheet returns empty
 * for a column it lacks, and the next save adds the header. Renaming or removing one is
 * a manual change to the Sheet — there is no migration runner.
 *
 * Column ORDER matters — it is the physical left-to-right order of the written range —
 * and so does TABS order, which is the order ranges come back from a batchGet.
 */

export const TABS = ['tasks', 'statuses', 'categories', 'priorities', 'owners', 'settings', 'meta']

export const COLS = {
  tasks: ['id', 'name', 'color', 'icon', 'status_id', 'category_id', 'priority_id', 'owner_id', 'due_date', 'notes', 'progress_percent'],
  statuses: ['id', 'name', 'color', 'icon', 'start_percent'],
  categories: ['id', 'name'],
  priorities: ['id', 'name', 'color'],
  owners: ['id', 'name'],
  settings: ['key', 'value'],
  meta: ['key', 'value'],
}

/**
 * Tasks are stored in a deterministic order (due date first, blanks last, then name),
 * Sorted before writing, because the written order is what the next read returns and
 * therefore what the next content hash is computed over.
 */
export function sortTasks(rows) {
  return rows.slice().sort((a, b) => {
    const ad = a.due_date || '9999-99-99'
    const bd = b.due_date || '9999-99-99'
    if (ad !== bd) return ad < bd ? -1 : 1
    if (a.name !== b.name) return a.name < b.name ? -1 : 1
    return 0
  })
}

/** settings travels as an object but is stored as rows, keys sorted (normaliseSettings_). */
export function settingsToRows(settings) {
  return Object.keys(settings || {})
    .sort()
    .map((key) => ({ key, value: settings[key] == null ? '' : String(settings[key]) }))
}

export function rowsToSettings(rows) {
  const out = {}
  for (const row of rows) if (row.key) out[row.key] = row.value
  return out
}
