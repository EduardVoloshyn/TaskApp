/**
 * TaskApp — schema migrations
 *
 * ── HOW TO USE ────────────────────────────────────────────────────────────────
 *
 *   1. In the Apps Script editor, pick `migrationStatus` from the function dropdown
 *      and press Run. It changes nothing; it prints what would happen.
 *   2. Pick `migrate` and press Run.
 *   3. Read the execution log (View → Logs, or the Executions panel).
 *
 * Both are safe to run twice. `migrate` applies only the steps the sheet has not had
 * yet, in order, and records the new version in the `meta` tab.
 *
 * ── ADDING A MIGRATION ────────────────────────────────────────────────────────
 *
 * Append an entry to MIGRATIONS below. Bump SCHEMA_VERSION in Code.gs to match the
 * highest `to`. Most schema changes are one line, because `reshapeTab_` reads by
 * header name and rewrites with whatever COLS now says:
 *
 *   { to: '2', name: 'add tasks.priority_order', run: function () { reshapeTab_(TAB.tasks, COLS.tasks) } }
 *
 * A migration must be idempotent — running it on an already-migrated sheet must be a
 * no-op, not an error. `reshapeTab_` satisfies that by construction, EXCEPT for
 * categories/priorities, whose row order is semantic: reshaping those preserves
 * whatever order the sheet already has, it does not reorder them.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────────
 *
 * A column inserted mid-schema shifts every later column, and a naive positional read
 * would misread every field after it on a sheet still carrying the old header. Mapping
 * by name (Code.gs's readTab_) stops the misreading; this file is what actually updates
 * the sheet, on purpose and visibly, rather than hoping a save eventually rewrites the
 * header.
 */

/**
 * Ordered list of steps. `to` is the schema version the sheet reaches once the step
 * has run. Never edit or reorder a released entry — append a new one.
 */
var MIGRATIONS = [
  {
    to: '2',
    name: 'add priorities.color',
    run: function () { reshapeTab_(TAB.priorities, COLS.priorities); }
  },
  {
    to: '3',
    name: 'add tasks.color, tasks.icon',
    run: function () { reshapeTab_(TAB.tasks, COLS.tasks); }
  }
];

/* ============================================================ entry points ==== */

/**
 * Run this from the editor. Applies every pending migration, in order.
 * @returns {Object} a summary, also written to the log
 */
function migrate() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    Logger.log('Could not acquire the lock — is another run in progress?');
    return { ok: false, code: 'locked' };
  }

  try {
    var from = sheetVersion_();
    var pending = pendingMigrations_(from);

    if (pending.length === 0) {
      Logger.log('Nothing to do. Sheet is already at version %s.', from);
      return { ok: true, from: from, to: from, applied: [] };
    }

    Logger.log('Migrating from version %s — %s step(s) to apply.', from, pending.length);
    var applied = [];

    for (var i = 0; i < pending.length; i++) {
      var step = pending[i];
      Logger.log('  → %s: %s', step.to, step.name);
      step.run();
      // Recorded after each step, so a failure halfway leaves an accurate version and
      // a re-run resumes rather than repeating what already succeeded.
      setSheetVersion_(step.to);
      SpreadsheetApp.flush();
      applied.push(step.to + ' ' + step.name);
    }

    var to = sheetVersion_();
    Logger.log('Done. Sheet is now at version %s.', to);
    return { ok: true, from: from, to: to, applied: applied };
  } catch (err) {
    Logger.log('FAILED: %s', err);
    Logger.log('The sheet is at version %s. Fix the cause and run migrate() again.', sheetVersion_());
    throw err;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Run this first. Reports what `migrate` would do, and what each tab is missing.
 * Changes nothing.
 */
function migrationStatus() {
  var current = sheetVersion_();
  var pending = pendingMigrations_(current);

  Logger.log('Sheet version : %s', current);
  Logger.log('Code expects  : %s', SCHEMA_VERSION);
  Logger.log('Pending steps : %s', pending.length);
  for (var i = 0; i < pending.length; i++) {
    Logger.log('   %s — %s', pending[i].to, pending[i].name);
  }

  Logger.log('');
  Logger.log('Tab headers:');
  var tabs = [
    ['tasks', COLS.tasks], ['statuses', COLS.statuses], ['categories', COLS.categories],
    ['priorities', COLS.priorities], ['owners', COLS.owners],
    ['settings', COLS.settings], ['meta', COLS.meta]
  ];

  for (var t = 0; t < tabs.length; t++) {
    var name = tabs[t][0];
    var expected = tabs[t][1];
    var header = tabHeader_(name);

    if (header === null) {
      Logger.log('   %-10s MISSING TAB', name);
      continue;
    }
    var missing = expected.filter(function (c) { return header.indexOf(c) === -1; });
    var extra = header.filter(function (h) { return h && expected.indexOf(h) === -1; });

    Logger.log('   %-10s %s%s%s', name, header.join(', '),
      missing.length ? '   MISSING: ' + missing.join(', ') : '',
      extra.length ? '   (extra, left alone: ' + extra.join(', ') + ')' : '');
  }

  return { version: current, expected: SCHEMA_VERSION, pending: pending.length };
}

/* ================================================================= helpers ==== */

/**
 * Rewrites a tab with the given schema, preserving the values already there and their
 * existing order — this is safe for categories/priorities specifically because it does
 * not touch row order, only column shape.
 *
 * @param {string} name
 * @param {string[]} cols
 */
function reshapeTab_(name, cols) {
  var rows = readTab_(name, cols);
  writeTab_(name, cols, rows);
  Logger.log('     %s: %s row(s) rewritten with [%s]', name, rows.length, cols.join(', '));
}

/**
 * Adds a settings key if it is absent. Never overwrites — a value the owner has
 * already edited by hand must survive a migration.
 *
 * @param {string} key
 * @param {string} value
 */
function ensureSetting_(key, value) {
  var rows = readTab_(TAB.settings, COLS.settings);
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].key === key) {
      Logger.log('     settings.%s already set, left alone', key);
      return;
    }
  }
  rows.push({ key: key, value: value });
  rows.sort(function (a, b) { return a.key < b.key ? -1 : a.key > b.key ? 1 : 0; });
  writeTab_(TAB.settings, COLS.settings, rows);
  Logger.log('     settings.%s added', key);
}

/**
 * Creates a tab with just its header if it does not exist. Leaves an existing tab
 * completely alone, including its data — this only guarantees presence.
 *
 * @param {string} name
 * @param {string[]} cols
 */
function ensureTab_(name, cols) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);

  if (sh) {
    // Present already: make sure the header carries every column, without touching rows.
    reshapeTab_(name, cols);
    return;
  }

  sh = ss.insertSheet(name);
  sh.getRange(1, 1, 1, cols.length).setValues([cols]);
  sh.setFrozenRows(1);
  Logger.log('     %s: tab created with [%s]', name, cols.join(', '));
}

/** @returns {string[] | null} the tab's header row, or null if the tab is absent */
function tabHeader_(name) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) return null;
  var width = Math.min(sh.getLastColumn(), sh.getMaxColumns());
  if (width < 1) return [];
  return sh.getRange(1, 1, 1, width).getValues()[0]
    .map(function (h) { return String(h === null ? '' : h).trim(); });
}

/**
 * The sheet's own idea of its version, from the `meta` tab.
 *
 * Defaults to '1' rather than to SCHEMA_VERSION: a sheet with no recorded version
 * predates versioning, so it needs every migration, and assuming it is current would
 * skip them all silently.
 */
function sheetVersion_() {
  var rows = readTab_(TAB.meta, COLS.meta);
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].key === 'schema_version' && rows[i].value) return String(rows[i].value);
  }
  return '1';
}

function setSheetVersion_(version) {
  var rows = readTab_(TAB.meta, COLS.meta);
  var found = false;

  for (var i = 0; i < rows.length; i++) {
    if (rows[i].key === 'schema_version') { rows[i].value = String(version); found = true; }
    if (rows[i].key === 'updated_at') rows[i].value = new Date().toISOString();
  }
  if (!found) rows.push({ key: 'schema_version', value: String(version) });

  writeTab_(TAB.meta, COLS.meta, rows);
}

/**
 * Steps not yet applied. Compares numerically, so '10' sorts after '9' rather than
 * before it as string comparison would.
 *
 * @param {string} current
 */
function pendingMigrations_(current) {
  var at = Number(current);
  return MIGRATIONS
    .filter(function (m) { return Number(m.to) > at; })
    .sort(function (a, b) { return Number(a.to) - Number(b.to); });
}
