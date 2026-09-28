/**
 * TaskApp — Sheet API  (P1)
 *
 * The JSON API the PWA talks to. Google Sheets is the system of record; this script is
 * the only thing that touches it.
 *
 * Two endpoints:
 *   GET  ?action=board   -> the whole board (tasks + reference lists) + a content hash
 *   POST {action:'save'} -> replace the whole board, guarded by that hash
 *
 * Design rules this file exists to enforce:
 *   - Whole-sheet reads and writes. Never per-row surgery, never a cached row index.
 *   - Every write holds LockService and flushes before releasing.
 *   - Every write is guarded by a content hash, which is what catches the owner
 *     hand-editing the Sheet — a conflict no version counter would ever notice.
 *   - Every cell is text on the way in and out. Sheets coerces "2026-01-01" to a date
 *     and "60" to a number given the chance, so the data range is formatted as plain text.
 *   - `categories` and `priorities` row order is semantic — it is the board's row/column
 *     order — so it is written back exactly as the client sends it, never re-sorted.
 *     The content hash still canonically sorts every tab's rows by `id` before hashing,
 *     purely for hash stability; that sort is never what gets written to the sheet.
 *   - category_id/priority_id are required on a task (the board is a Category × Priority
 *     matrix; every task needs both axes). Status/owner remain optional.
 *   - A task carries its own colour/icon, independent of its Status's — Status is shown
 *     client-side as a progress bar (stage N of the ordered Statuses list), not as a
 *     colour source. Both colour fields draw from the same 8-value PALETTE.
 *   - Referential integrity is soft: presence is required, existence is not. A task
 *     naming a status/category/priority/owner that no longer exists is never rejected
 *     or silently cleared — an unknown id is the client's problem to render (an
 *     "unassigned" row/column/badge), not this script's to fix up.
 *
 * CORS notes, carried over from the reference project:
 *   - A GET answers through a 302 to script.googleusercontent.com. fetch() follows it
 *     and the final response carries permissive CORS headers, so GETs work.
 *   - POST must be sent as Content-Type: text/plain. It is CORS-safelisted, so no
 *     preflight — and Apps Script cannot answer a preflight OPTIONS at all. The body
 *     is still JSON; we parse it ourselves.
 *   - There is no way to set a meaningful HTTP status. Every response is 200 and
 *     failures are reported in the body as {ok:false, code:'...'}. Clients must check
 *     the body, not the status.
 */

var SHARED_SECRET = 'CHANGE_ME_BEFORE_DEPLOY';

var SCHEMA_VERSION = '3';

var TAB = {
  tasks: 'tasks',
  statuses: 'statuses',
  categories: 'categories',
  priorities: 'priorities',
  owners: 'owners',
  settings: 'settings',
  meta: 'meta'
};

var COLS = {
  // v3: colour + icon, a task's own look — independent of its Status (Status is shown
  // client-side as a progress bar, not a colour/icon source, once a task has its own).
  tasks:      ['id', 'name', 'color', 'icon', 'status_id', 'category_id', 'priority_id', 'owner_id', 'due_date', 'notes'],
  statuses:   ['id', 'name', 'color', 'icon'],
  categories: ['id', 'name'],
  priorities: ['id', 'name', 'color'],   // v2: colour, same palette as statuses
  owners:     ['id', 'name'],
  settings:   ['key', 'value'],
  meta:       ['key', 'value']
};

// Colour is a palette token, never a free hex value. Anything outside this list is
// rejected/clamped, so a typo can't quietly produce an unstyled status.
var PALETTE = ['slate', 'blue', 'red', 'amber', 'green', 'violet', 'teal', 'rose'];

var LIMITS = {
  name: 120, notes: 1000, icon: 12,
  tasks: 2000, statuses: 40, categories: 40, priorities: 40, owners: 100
};

/* =============================================================== endpoints ==== */

function doGet(e) {
  var t0 = Date.now();
  var p = (e && e.parameter) || {};
  try {
    if (p.secret !== SHARED_SECRET) return out_({ ok: false, code: 'unauthorized' }, t0);

    switch (p.action || 'board') {
      case 'ping':
        return out_({ ok: true, schema_version: SCHEMA_VERSION }, t0);

      case 'board':
        return out_(readBoard_(), t0);

      // Read-only: lets a client see whether the sheet needs migrating. The
      // migration itself lives in Migrations.gs and is run by hand from the editor.
      case 'status':
        return out_({
          ok: true,
          schema_version: SCHEMA_VERSION,
          sheet_version: sheetVersion_(),
          migration_needed: pendingMigrations_(sheetVersion_()).length > 0
        }, t0);

      default:
        return out_({ ok: false, code: 'bad_request',
                      message: 'unknown action: ' + p.action }, t0);
    }
  } catch (err) {
    return out_({ ok: false, code: 'internal', message: String(err) }, t0);
  }
}

function doPost(e) {
  var t0 = Date.now();
  try {
    var raw = (e && e.postData && e.postData.contents) || '';
    var body;
    try {
      body = JSON.parse(raw);
    } catch (parseErr) {
      return out_({ ok: false, code: 'bad_request', message: 'body is not valid JSON' }, t0);
    }

    if (body.secret !== SHARED_SECRET) return out_({ ok: false, code: 'unauthorized' }, t0);

    switch (body.action || 'save') {
      case 'save':
        return out_(saveBoard_(body), t0);

      default:
        return out_({ ok: false, code: 'bad_request',
                      message: 'unknown action: ' + body.action }, t0);
    }
  } catch (err) {
    return out_({ ok: false, code: 'internal', message: String(err) }, t0);
  }
}

/* ==================================================================== read ==== */

function readBoard_() {
  var tasks = readTab_(TAB.tasks, COLS.tasks);
  var statuses = readTab_(TAB.statuses, COLS.statuses);
  var categories = readTab_(TAB.categories, COLS.categories);
  var priorities = readTab_(TAB.priorities, COLS.priorities);
  var owners = readTab_(TAB.owners, COLS.owners);
  var settings = readTab_(TAB.settings, COLS.settings);

  // sheetVersion_/pendingMigrations_ live in Migrations.gs, same Apps Script project —
  // reported on every read (not just ?action=status) so the client can warn the moment
  // it loads, rather than only when someone thinks to check separately.
  var sheetVer = sheetVersion_();

  return {
    ok: true,
    tasks: tasks,
    statuses: statuses,
    categories: categories,
    priorities: priorities,
    owners: owners,
    settings: kv_(settings),
    meta: kv_(readTab_(TAB.meta, COLS.meta)),
    hash: hash_(tasks, statuses, categories, priorities, owners, settings),
    schema_version: SCHEMA_VERSION,
    sheet_version: sheetVer,
    migration_needed: pendingMigrations_(sheetVer).length > 0
  };
}

/**
 * Reads a tab, mapping columns **by header name**, never by position.
 *
 * Inserting a column in the middle of a schema once shifted every later column: a sheet
 * still carrying the old header had one field read as another, with data silently lost.
 * Mapping by name also makes migration free: a column the sheet does not have yet reads
 * as empty, and the new header lands on the next save.
 */
function readTab_(name, cols) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) return [];

  var last = sh.getLastRow();
  if (last < 2) return [];

  var width = Math.min(sh.getLastColumn(), sh.getMaxColumns());
  if (width < 1) return [];

  var all = sh.getRange(1, 1, last, width).getValues();
  var header = all[0].map(function (h) { return String(h === null ? '' : h).trim(); });

  // Where each schema column actually lives, or -1 when the sheet lacks it.
  var indexOf = {};
  for (var c = 0; c < cols.length; c++) indexOf[cols[c]] = header.indexOf(cols[c]);

  // A sheet with no recognisable header would otherwise read as entirely empty, which
  // would look like data loss. Fall back to position and say so in the log.
  if (indexOf[cols[0]] === -1) {
    Logger.log('WARNING: %s has no "%s" header; falling back to positional columns', name, cols[0]);
    for (var f = 0; f < cols.length; f++) indexOf[cols[f]] = f < width ? f : -1;
  }

  var rows = [];
  for (var r = 1; r < all.length; r++) {
    var o = {};
    var empty = true;
    for (var k = 0; k < cols.length; k++) {
      var at = indexOf[cols[k]];
      var v = at >= 0 && at < width ? all[r][at] : '';
      o[cols[k]] = (v === null || v === undefined) ? '' : String(v).trim();
      if (o[cols[k]] !== '') empty = false;
    }
    if (!empty) rows.push(o);   // skip blank rows left behind by manual editing
  }
  return rows;
}

function kv_(rows) {
  var o = {};
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].key) o[rows[i].key] = rows[i].value;
  }
  return o;
}

/* =================================================================== write ==== */

/**
 * Replaces tasks, all four reference tabs and settings in one go. Either the whole
 * payload is valid and written, or nothing changes.
 */
function saveBoard_(body) {
  // Validate before taking the lock — no point holding a mutex to reject a payload.
  var statuses = normaliseStatuses_(body.statuses);
  var categories = normaliseRefList_(body.categories, 'categories', LIMITS.categories);
  var priorities = normaliseRefList_(body.priorities, 'priorities', LIMITS.priorities, { withColor: true });
  var owners = normaliseRefList_(body.owners, 'owners', LIMITS.owners);
  var tasks = normaliseTasks_(body.tasks);
  var settings = normaliseSettings_(body.settings);

  var errors = statuses.errors.concat(
    categories.errors, priorities.errors, owners.errors, tasks.errors, settings.errors);
  if (errors.length) {
    return { ok: false, code: 'invalid', errors: errors.slice(0, 20),
             error_count: errors.length };
  }

  var lock = LockService.getScriptLock();
  var lockStart = Date.now();
  if (!lock.tryLock(15000)) {
    return { ok: false, code: 'locked', lock_wait_ms: Date.now() - lockStart };
  }
  var lockWaitMs = Date.now() - lockStart;

  try {
    // The guard. Compare against what is on the Sheet right now.
    var currentHash = hash_(
      readTab_(TAB.tasks, COLS.tasks),
      readTab_(TAB.statuses, COLS.statuses),
      readTab_(TAB.categories, COLS.categories),
      readTab_(TAB.priorities, COLS.priorities),
      readTab_(TAB.owners, COLS.owners),
      readTab_(TAB.settings, COLS.settings));

    if (body.hash !== currentHash) {
      return { ok: false, code: 'stale', hash: currentHash,
               message: 'the Sheet changed since you last read it; re-read and reapply' };
    }

    // categories/priorities: written in the client-given order (see file header) —
    // that order IS the board's row/column order, not just a display nicety.
    writeTab_(TAB.tasks, COLS.tasks, tasks.rows);
    writeTab_(TAB.statuses, COLS.statuses, statuses.rows);
    writeTab_(TAB.categories, COLS.categories, categories.rows);
    writeTab_(TAB.priorities, COLS.priorities, priorities.rows);
    writeTab_(TAB.owners, COLS.owners, owners.rows);
    writeTab_(TAB.settings, COLS.settings, settings.rows);
    writeTab_(TAB.meta, COLS.meta, [
      { key: 'schema_version', value: SCHEMA_VERSION },
      { key: 'updated_at', value: new Date().toISOString() }
    ]);

    // Flush before releasing, or the mutex protects nothing.
    SpreadsheetApp.flush();

    return {
      ok: true,
      written: {
        tasks: tasks.rows.length, statuses: statuses.rows.length,
        categories: categories.rows.length, priorities: priorities.rows.length,
        owners: owners.rows.length, settings: settings.rows.length
      },
      // Computed from what we just wrote, not by re-reading.
      hash: hash_(tasks.rows, statuses.rows, categories.rows, priorities.rows, owners.rows, settings.rows),
      lock_wait_ms: lockWaitMs
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Clears the old data range and writes the new one in a single setValues.
 * The range is forced to plain-text format first so Sheets cannot reinterpret
 * "2026-01-01" as a date or "60" as a number.
 *
 * Rows are written in the order given — the caller decides whether that order is
 * semantic (categories/priorities) or incidental (everything else).
 */
function writeTab_(name, cols, rows) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);

  sh.getRange(1, 1, 1, cols.length).setValues([cols]);

  // Clear the full previous extent, not just the new width: a schema that gained a
  // column would otherwise leave the old rightmost values stranded beside the new ones.
  var last = sh.getLastRow();
  var previousWidth = Math.max(cols.length, Math.min(sh.getLastColumn(), sh.getMaxColumns()));
  if (last > 1) sh.getRange(2, 1, last - 1, previousWidth).clearContent();

  if (!rows.length) return;

  var values = rows.map(function (r) {
    return cols.map(function (c) { return r[c] != null ? String(r[c]) : ''; });
  });

  var target = sh.getRange(2, 1, values.length, cols.length);
  target.setNumberFormat('@');
  target.setValues(values);
}

/* ============================================================== validation ==== */

function normaliseTasks_(input) {
  var rows = [], errors = [];

  if (!Array.isArray(input)) return { rows: rows, errors: ['tasks must be an array'] };
  if (input.length > LIMITS.tasks) {
    return { rows: rows, errors: ['too many tasks: ' + input.length] };
  }

  var seen = {};

  for (var i = 0; i < input.length; i++) {
    var t = input[i] || {};
    var where = 'tasks[' + i + ']';

    var id = str_(t.id);
    if (!id) { errors.push(where + ': missing id'); continue; }
    if (seen[id]) { errors.push(where + ': duplicate id ' + id); continue; }
    seen[id] = true;

    var name = str_(t.name);
    if (!name) errors.push(where + ': name is required');
    else if (name.length > LIMITS.name) errors.push(where + ': name too long');

    // A task's own colour/icon (independent of its Status). Clamped rather than
    // rejected, same reasoning as normaliseStatuses_ — a hand-typed colour must not
    // make the whole payload unsaveable.
    var color = str_(t.color) || 'slate';
    if (PALETTE.indexOf(color) === -1) color = 'slate';

    var icon = str_(t.icon);
    if (icon.length > LIMITS.icon) errors.push(where + ': icon too long');

    // category_id/priority_id are required on the task itself (the board is a
    // Category × Priority matrix; a task needs both axes to have a home). This is
    // separate from referential integrity below: the id must be present, but is not
    // checked for existence, so a category deleted after the fact does not retroactively
    // invalidate every task that already named it.
    var categoryId = str_(t.category_id);
    if (!categoryId) errors.push(where + ': category_id is required');

    var priorityId = str_(t.priority_id);
    if (!priorityId) errors.push(where + ': priority_id is required');

    var dueDate = str_(t.due_date);
    if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
      errors.push(where + ': due_date must be YYYY-MM-DD, got "' + dueDate + '"');
    }

    var notes = str_(t.notes);
    if (notes.length > LIMITS.notes) errors.push(where + ': notes too long');

    // Status/owner remain optional; category/priority are opaque strings once present,
    // not checked against the other tabs (soft referential integrity — see file header).
    // A row deleted from a reference tab must not make every task naming it unsaveable.
    rows.push({
      id: id, name: name, color: color, icon: icon,
      status_id: str_(t.status_id), category_id: categoryId,
      priority_id: priorityId, owner_id: str_(t.owner_id),
      due_date: dueDate, notes: notes
    });
  }

  // Stable order: by due date (blank last), then name. Keeps the Sheet readable and
  // makes the content hash independent of client-side ordering.
  rows.sort(function (a, b) {
    var ad = a.due_date || '9999-99-99';
    var bd = b.due_date || '9999-99-99';
    return (ad < bd ? -1 : ad > bd ? 1 : 0) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  });

  return { rows: rows, errors: errors };
}

function normaliseStatuses_(input) {
  var rows = [], errors = [];
  if (input === undefined || input === null) return { rows: rows, errors: errors };
  if (!Array.isArray(input)) return { rows: rows, errors: ['statuses must be an array'] };
  if (input.length > LIMITS.statuses) {
    return { rows: rows, errors: ['too many statuses: ' + input.length] };
  }

  var seen = {};
  for (var i = 0; i < input.length; i++) {
    var s = input[i] || {};
    var where = 'statuses[' + i + ']';

    var id = str_(s.id);
    if (!id) { errors.push(where + ': missing id'); continue; }
    if (seen[id]) { errors.push(where + ': duplicate id ' + id); continue; }
    seen[id] = true;

    var name = str_(s.name);
    if (!name) errors.push(where + ': name is required');
    else if (name.length > LIMITS.name) errors.push(where + ': name too long');

    // Clamped rather than rejected: a hand-typed colour in the Sheet must not make the
    // whole payload unsaveable, and event-block-style rendering already falls back to
    // 'slate' for anything it doesn't recognise.
    var color = str_(s.color) || 'slate';
    if (PALETTE.indexOf(color) === -1) color = 'slate';

    var icon = str_(s.icon);
    if (icon.length > LIMITS.icon) errors.push(where + ': icon too long');

    rows.push({ id: id, name: name, color: color, icon: icon });
  }

  // Order preserved as received — kept for consistency with the other reference lists,
  // though status order carries no layout meaning today.
  return { rows: rows, errors: errors };
}

/**
 * Categories/Priorities/Owners share the same shape (id, name, optionally colour) and
 * the same rule: order is preserved exactly as received, never re-sorted — for
 * categories/priorities that order IS the board's row/column order.
 *
 * @param {Object} [opts] @param {boolean} [opts.withColor] Priorities carry a colour
 *   token too (same 8-value palette as statuses); Categories/Owners do not.
 */
function normaliseRefList_(input, label, limit, opts) {
  opts = opts || {};
  var rows = [], errors = [];
  if (input === undefined || input === null) return { rows: rows, errors: errors };
  if (!Array.isArray(input)) return { rows: rows, errors: [label + ' must be an array'] };
  if (input.length > limit) {
    return { rows: rows, errors: ['too many ' + label + ': ' + input.length] };
  }

  var seen = {};
  for (var i = 0; i < input.length; i++) {
    var r = input[i] || {};
    var where = label + '[' + i + ']';

    var id = str_(r.id);
    if (!id) { errors.push(where + ': missing id'); continue; }
    if (seen[id]) { errors.push(where + ': duplicate id ' + id); continue; }
    seen[id] = true;

    var name = str_(r.name);
    if (!name) errors.push(where + ': name is required');
    else if (name.length > LIMITS.name) errors.push(where + ': name too long');

    var row = { id: id, name: name };
    if (opts.withColor) {
      // Clamped rather than rejected — same reasoning as normaliseStatuses_: a
      // hand-typed colour in the Sheet must not make the whole payload unsaveable.
      var color = str_(r.color) || 'slate';
      if (PALETTE.indexOf(color) === -1) color = 'slate';
      row.color = color;
    }
    rows.push(row);
  }

  return { rows: rows, errors: errors };
}

function normaliseSettings_(input) {
  var rows = [], errors = [];
  if (input === undefined || input === null) return { rows: rows, errors: errors };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { rows: rows, errors: ['settings must be an object'] };
  }

  var keys = Object.keys(input).sort();
  for (var i = 0; i < keys.length; i++) {
    rows.push({ key: keys[i], value: str_(input[keys[i]]) });
  }

  return { rows: rows, errors: errors };
}

function str_(v) { return (v === null || v === undefined) ? '' : String(v).trim(); }

/* ==================================================================== hash ==== */

/**
 * Content hash over everything the client can write.
 *
 * Every tab's rows are canonically sorted by `id` here, purely so the hash is
 * independent of incidental array ordering from the client. That canonical order is
 * used ONLY for hashing — it is never what gets written back to categories/priorities,
 * whose actual write preserves the client-given (semantic) order. See writeTab_ calls
 * in saveBoard_.
 */
function hash_(tasks, statuses, categories, priorities, owners, settings) {
  var parts = [
    'k', canon_(tasks, COLS.tasks),
    's', canon_(byId_(statuses), COLS.statuses),
    'c', canon_(byId_(categories), COLS.categories),
    'p', canon_(byId_(priorities), COLS.priorities),
    'o', canon_(byId_(owners), COLS.owners),
    'g', canon_(settings, COLS.settings)
  ].join('');

  var bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.MD5, parts, Utilities.Charset.UTF_8);

  return bytes.map(function (b) {
    return ((b < 0 ? b + 256 : b) + 0x100).toString(16).slice(1);
  }).join('');
}

/** A copy of the list sorted by id, for hashing only — never for writing. */
function byId_(rows) {
  return (rows || []).slice().sort(function (a, b) {
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function canon_(rows, cols) {
  if (!rows || !rows.length) return '';
  return rows.map(function (r) {
    return cols.map(function (c) {
      return (r[c] === null || r[c] === undefined) ? '' : String(r[c]);
    }).join('');
  }).join('');
}

/* =================================================================== output ==== */

function out_(payload, t0) {
  payload.server_ms = Date.now() - t0;
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
