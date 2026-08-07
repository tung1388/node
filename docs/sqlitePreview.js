// =====================================================================
// docs/sqlitePreview.js
// ---------------------------------------------------------------------
// In-browser SQLite viewer for previewing .sqlite/.db files stored
// through the app - lets you browse tables or run a read-only query
// without downloading the file first.
//
// This is the prototype's first external dependency: sql.js (a WASM
// build of SQLite), loaded lazily from jsDelivr's npm CDN - only when
// someone actually opens a SQLite file, so every other use of the app
// stays dependency-free. sql.js's browser build is a classic global
// script (sets window.initSqlJs), not an ES module, hence the manual
// <script> injection instead of a normal import().
// =====================================================================

const SQL_JS_VERSION = "1.10.3";
const SQL_JS_BASE = `https://cdn.jsdelivr.net/npm/sql.js@${SQL_JS_VERSION}/dist/`;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}

let sqlJsPromise = null;
function loadSqlJs() {
  if (!sqlJsPromise) {
    sqlJsPromise = loadScript(`${SQL_JS_BASE}sql-wasm.js`).then(() =>
      window.initSqlJs({ locateFile: (file) => `${SQL_JS_BASE}${file}` })
    );
  }
  return sqlJsPromise;
}

export function isSqliteFile(entry) {
  return entry.type === "application/vnd.sqlite4" || /\.(sqlite3?|db3?)$/i.test(entry.name || "");
}

/**
 * Renders a table/query browser for `bytes` (raw decrypted SQLite file)
 * into `container`. Returns the opened sql.js Database instance so the
 * caller can close it (frees WASM memory) once the preview is dismissed.
 *
 * `onSave(bytes)` is optional - if provided, a "Save changes" button
 * appears that exports the current in-memory database (via db.export())
 * and hands the bytes to it. This module has yes idea how to encrypt or
 * upload anything (deliberately - it doesn't import crypto.js/github.js
 * or know about sessions/manifests); the caller (app.js) supplies that
 * logic so this stays a plain "SQLite in a box" viewer.
 */
export async function renderSqlitePreview(bytes, container, { onSave } = {}) {
  container.innerHTML = '<p class="hint">Loading SQLite engine…</p>';
  let SQL;
  try {
    SQL = await loadSqlJs();
  } catch (err) {
    container.innerHTML = `<p class="error">Couldn't load the SQLite engine: ${err.message}</p>`;
    return null;
  }

  let db;
  try {
    db = new SQL.Database(bytes);
  } catch (err) {
    container.innerHTML = `<p class="error">Not a valid SQLite file: ${err.message}</p>`;
    return null;
  }

  const tableNames = (db.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")[0]?.values || []).map(
    (row) => row[0]
  );

  container.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "sqlite-preview";

  const toolbar = document.createElement("div");
  toolbar.className = "sqlite-toolbar";

  const select = document.createElement("select");
  for (const name of tableNames) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  }

  const queryInput = document.createElement("input");
  queryInput.type = "text";
  queryInput.placeholder = "...or run a read-only SQL query";

  const runBtn = document.createElement("button");
  runBtn.textContent = "Run";
  runBtn.className = "secondary";

  toolbar.append(select, queryInput, runBtn);

  let saveStatus, performSave;
  if (onSave) {
    saveStatus = document.createElement("span");
    saveStatus.className = "hint";

    performSave = async () => {
      saveStatus.textContent = "Saving…";
      try {
        // db.export() serializes the CURRENT in-memory state (including
        // any INSERT/UPDATE/DELETE just run) back to bytes - that's the
        // only way changes here become more than a demo, since sql.js
        // otherwise only ever edits an in-memory copy.
        await onSave(db.export());
        saveStatus.textContent = `Auto-saved at ${new Date().toLocaleTimeString()}.`;
      } catch (err) {
        saveStatus.textContent = `Save failed: ${err.message}`;
      }
    };
    toolbar.append(saveStatus);
  }

  const resultsEl = document.createElement("div");
  resultsEl.className = "sqlite-results";

  function renderResult(result) {
    resultsEl.innerHTML = "";
    if (!result || !result.columns.length) {
      resultsEl.innerHTML = '<p class="hint">No rows.</p>';
      return;
    }
    const ROW_CAP = 200;
    const table = document.createElement("table");
    const headRow = document.createElement("tr");
    for (const col of result.columns) {
      const th = document.createElement("th");
      th.textContent = col;
      headRow.appendChild(th);
    }
    table.appendChild(headRow);
    for (const row of result.values.slice(0, ROW_CAP)) {
      const tr = document.createElement("tr");
      for (const cell of row) {
        const td = document.createElement("td");
        td.textContent = cell === null ? "NULL" : String(cell);
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }
    resultsEl.appendChild(table);
    if (result.values.length > ROW_CAP) {
      const note = document.createElement("p");
      note.className = "hint";
      note.textContent = `Showing first ${ROW_CAP} of ${result.values.length} rows.`;
      resultsEl.appendChild(note);
    }
  }

  // Matches statements that change schema - CREATE/DROP/ALTER affect zero
  // rows, so db.getRowsModified() alone would miss them.
  const SCHEMA_STATEMENT = /^\s*(create|drop|alter)\b/i;

  function runQuery(sql) {
    if (!sql.trim()) return;
    try {
      renderResult(db.exec(sql)[0]);
      // Two independent checks, because neither alone covers everything:
      // rowsModified catches INSERT/UPDATE/DELETE *however they're
      // wrapped* (e.g. a leading WITH RECURSIVE ... CTE means the
      // statement doesn't start with "insert" at all), while the keyword
      // check catches CREATE/DROP/ALTER, which change nothing rows-wise.
      const isWrite = db.getRowsModified() > 0 || SCHEMA_STATEMENT.test(sql);
      if (onSave && isWrite) performSave(); // fire-and-forget - status shown via saveStatus
    } catch (err) {
      resultsEl.innerHTML = `<p class="error">${err.message}</p>`;
    }
  }

  select.onchange = () => runQuery(`SELECT * FROM "${select.value}"`);
  runBtn.onclick = () => runQuery(queryInput.value);
  queryInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") runQuery(queryInput.value);
  });

  wrap.append(toolbar, resultsEl);
  container.appendChild(wrap);

  if (tableNames.length) {
    select.value = tableNames[0];
    runQuery(`SELECT * FROM "${tableNames[0]}"`);
  } else {
    resultsEl.innerHTML = '<p class="hint">No tables found in this database.</p>';
  }

  return db;
}