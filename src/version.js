export const VERSION = '1.1'
export const RELEASED = '2026-10-07'

/**
 * The data-model schema this build expects. Bump alongside `SCHEMA_VERSION` in
 * apps-script/Code.gs every time the Task/Status/Category/Priority/Owner shape changes
 * — see CLAUDE.md's "Changing the data model" checklist.
 */
export const REQUIRED_SCHEMA_VERSION = '3'

/**
 * True when the Sheet has not actually been migrated to the schema this build expects
 * — i.e. the deploy happened but `migrate()` was never run in the Apps Script editor
 * (or the deployed Code.gs itself predates this build). Compares against `sheet_version`
 * (the Sheet's own recorded version) when the backend reports one, falling back to
 * `schema_version` (what the deployed script *declares*, not necessarily what's been
 * applied) for an older backend that doesn't send `sheet_version` yet.
 *
 * @param {{ sheet_version?: string, schema_version?: string, sheetVersion?: string, schemaVersion?: string } | null} snapshot
 */
export function isSchemaOutdated(snapshot) {
  if (!snapshot) return false
  const actual = Number(snapshot.sheetVersion || snapshot.schemaVersion || 0)
  if (!actual) return false // an old backend reporting neither field — nothing to compare
  return actual < Number(REQUIRED_SCHEMA_VERSION)
}
