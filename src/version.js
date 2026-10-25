export const VERSION = '2.2'
export const RELEASED = '2026-10-25'

/**
 * The data-model schema this build expects. Bump alongside `COLS` in
 * `src/sync/schema.js` every time the Task/Status/Category/Priority/Owner shape
 * changes — see CLAUDE.md's "Changing the data model" checklist.
 */
export const REQUIRED_SCHEMA_VERSION = '4'

/**
 * True when the Sheet is still on an older schema than this build expects — the new
 * code is running but has not yet written to the Sheet (every save stamps
 * `meta.schema_version`), or the change needs doing by hand. Compares against
 * `sheetVersion`, read from the `meta` tab.
 *
 * @param {{ sheet_version?: string, schema_version?: string, sheetVersion?: string, schemaVersion?: string } | null} snapshot
 */
export function isSchemaOutdated(snapshot) {
  if (!snapshot) return false
  const actual = Number(snapshot.sheetVersion || snapshot.schemaVersion || 0)
  if (!actual) return false // an old backend reporting neither field — nothing to compare
  return actual < Number(REQUIRED_SCHEMA_VERSION)
}
