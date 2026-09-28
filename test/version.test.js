import { eq, test } from './harness.js'
import { REQUIRED_SCHEMA_VERSION, isSchemaOutdated } from '../src/version.js'

/*
 * Detects a Sheet that hasn't been migrated to the schema this build expects — the
 * consequence of shipping a data-model change without running Migrations.gs's
 * migrate() (see CLAUDE.md's "Changing the data model" checklist).
 */

test('no snapshot yet is never outdated', () => {
  eq(isSchemaOutdated(null), false)
})

test('a sheet_version equal to what is required is not outdated', () => {
  eq(isSchemaOutdated({ sheetVersion: REQUIRED_SCHEMA_VERSION }), false)
})

test('a sheet_version behind what is required is outdated', () => {
  eq(isSchemaOutdated({ sheetVersion: String(Number(REQUIRED_SCHEMA_VERSION) - 1) }), true)
})

test('falls back to schema_version when sheet_version is missing (older backend)', () => {
  eq(isSchemaOutdated({ schemaVersion: String(Number(REQUIRED_SCHEMA_VERSION) - 1) }), true)
  eq(isSchemaOutdated({ schemaVersion: REQUIRED_SCHEMA_VERSION }), false)
})

test('neither field present (very old backend) is not treated as outdated — nothing to compare', () => {
  eq(isSchemaOutdated({}), false)
})
