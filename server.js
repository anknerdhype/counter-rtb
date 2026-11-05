const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');

process.env.TZ = 'Europe/Berlin';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const EMPLOYEES = ['Serkan', 'Julius', 'Hannes', 'Walid', 'Tobias', 'Andreas'];

// Kurzname in der URL -> Name in Datenbank und Anzeige.
// Kurznamen, weil "&" in URLs eine Sonderbedeutung hat.
const CATEGORIES = { rtb: 'RTB', cc: 'C&C' };

const DATABASE_URL = process.env.DATABASE_URL || '';
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: /sslmode=require/.test(DATABASE_URL) ? { rejectUnauthorized: false } : false
});

async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS counts (
        id SERIAL PRIMARY KEY,
        employee TEXT NOT NULL,
        date DATE NOT NULL,
        count INTEGER NOT NULL DEFAULT 0
      )
    `);

    // Umstellung auf zwei Zaehler. Bestehende Eintraege werden zu RTB.
    // Jede Anweisung ist wiederholbar, damit jeder Neustart gefahrlos ist.
    await client.query(`ALTER TABLE counts ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'RTB'`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS counts_employee_date_category_key ON counts (employee, date, category)`);
    await client.query(`ALTER TABLE counts DROP CONSTRAINT IF EXISTS counts_employee_date_key`);

    // Tagesnotiz je Mitarbeiter und Tag.
    await client.query(`
      CREATE TABLE IF NOT EXISTS notes (
        employee   TEXT        NOT NULL,
        date       DATE        NOT NULL,
        note       TEXT        NOT NULL DEFAULT '',
        rev        BIGINT      NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (employee, date)
      )
    `);
    await client.query(`ALTER TABLE notes ADD COLUMN IF NOT EXISTS rev BIGINT NOT NULL DEFAULT 0`);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Datum immer in deutscher Zeitzone bestimmen, unabhaengig von der Server-Zeitzone.
function todayString() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date());
}

function isValidDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isValidMonth(value) {
  return /^\d{4}-\d{2}$/.test(value);
}

// Liest Mitarbeiter und Zaehler aus der URL; sendet bei Fehler direkt 400.
function parseTarget(req, res) {
  const { employee, category } = req.params;
  if (!EMPLOYEES.includes(employee)) {
    res.status(400).json({ error: 'Unbekannter Mitarbeiter' });
    return null;
  }
  if (!Object.prototype.hasOwnProperty.call(CATEGORIES, category)) {
    res.status(400).json({ error: 'Unbekannter Zaehler' });
    return null;
  }
  return { employee, category, label: CATEGORIES[category] };
}

const NOTE_MAX_LENGTH = 2000;

// Eine Zeile pro Mitarbeiter und Tag: Summen beider Zaehler plus Notiz.
// Tage mit nur einer Notiz (ohne Stueckzahl) erscheinen ebenfalls.
// Filter werden als SQL-Bedingung auf "employee", "date" und "month" (YYYY-MM) uebergeben.
function dailyQuery(whereSql, dateFormat, orderSql) {
  return `
    WITH c AS (
      SELECT employee, date,
             SUM(count) FILTER (WHERE category = 'RTB')::int AS rtb,
             SUM(count) FILTER (WHERE category = 'C&C')::int AS cc,
             SUM(count)::int AS total
      FROM counts WHERE count > 0
      GROUP BY employee, date
    ),
    n AS (
      SELECT employee, date, note FROM notes WHERE note <> ''
    ),
    d AS (
      SELECT COALESCE(c.employee, n.employee) AS employee,
             COALESCE(c.date, n.date) AS date,
             COALESCE(c.rtb, 0) AS rtb,
             COALESCE(c.cc, 0) AS cc,
             COALESCE(c.total, 0) AS total,
             COALESCE(n.note, '') AS note
      FROM c FULL OUTER JOIN n ON c.employee = n.employee AND c.date = n.date
    )
    SELECT employee, TO_CHAR(date, '${dateFormat}') AS date, rtb, cc, total, note
    FROM d
    WHERE ${whereSql}
    ORDER BY ${orderSql}
  `;
}

// Baut die WHERE-Bedingung fuer Mitarbeiter-/Monatsfilter; sendet bei Fehler 400.
function buildFilters(query, res) {
  const { employee, month } = query;
  const conditions = ['TRUE'];
  const params = [];

  if (employee) {
    if (!EMPLOYEES.includes(employee)) {
      res.status(400).json({ error: 'Unbekannter Mitarbeiter' });
      return null;
    }
    params.push(employee);
    conditions.push(`employee = $${params.length}`);
  }

  if (month) {
    if (!isValidMonth(month)) {
      res.status(400).json({ error: 'Ungueltiger Monat' });
      return null;
    }
    params.push(month);
    conditions.push(`TO_CHAR(date, 'YYYY-MM') = $${params.length}`);
  }

  return { where: conditions.join(' AND '), params, month };
}

// CSV-Feld absichern: Anfuehrungszeichen bei Trennzeichen/Umbruechen, und
// Formeln verhindern (Excel wuerde "=..." sonst als Formel ausfuehren).
function csvField(value) {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[;"\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', date: todayString() });
});

app.get('/api/employees', (req, res) => {
  res.json(EMPLOYEES);
});

app.get('/api/categories', (req, res) => {
  res.json(Object.entries(CATEGORIES).map(([key, label]) => ({ key, label })));
});

// Beide Zaehlerstaende eines Mitarbeiters fuer einen Tag.
app.get('/api/count/:employee', async (req, res) => {
  try {
    const { employee } = req.params;
    const date = req.query.date || todayString();

    if (!EMPLOYEES.includes(employee)) {
      return res.status(400).json({ error: 'Unbekannter Mitarbeiter' });
    }
    if (!isValidDate(date)) {
      return res.status(400).json({ error: 'Ungueltiges Datum' });
    }

    const result = await pool.query(
      'SELECT category, count FROM counts WHERE employee = $1 AND date = $2',
      [employee, date]
    );

    const counts = {};
    for (const [key, label] of Object.entries(CATEGORIES)) {
      const row = result.rows.find(r => r.category === label);
      counts[key] = row ? row.count : 0;
    }

    const noteResult = await pool.query(
      'SELECT note FROM notes WHERE employee = $1 AND date = $2',
      [employee, date]
    );
    const note = noteResult.rows.length > 0 ? noteResult.rows[0].note : '';

    res.json({ employee, date, counts, note });
  } catch (err) {
    console.error('Fehler bei GET /api/count:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

app.post('/api/count/:employee/:category/increment', async (req, res) => {
  try {
    const target = parseTarget(req, res);
    if (!target) return;
    const date = todayString();

    // Eine einzige atomare Anweisung: entweder sie schreibt und liefert den
    // neuen Stand, oder sie schreibt gar nicht. Kein Zwischenzustand.
    const result = await pool.query(
      `INSERT INTO counts (employee, date, category, count) VALUES ($1, $2, $3, 1)
       ON CONFLICT (employee, date, category) DO UPDATE SET count = counts.count + 1
       RETURNING count`,
      [target.employee, date, target.label]
    );

    res.json({ employee: target.employee, category: target.category, date, count: result.rows[0].count });
  } catch (err) {
    console.error('Fehler bei POST /increment:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

app.post('/api/count/:employee/:category/decrement', async (req, res) => {
  try {
    const target = parseTarget(req, res);
    if (!target) return;
    const date = todayString();

    const updated = await pool.query(
      `UPDATE counts SET count = count - 1
       WHERE employee = $1 AND date = $2 AND category = $3 AND count > 0
       RETURNING count`,
      [target.employee, date, target.label]
    );

    let count = 0;
    if (updated.rows.length > 0) {
      count = updated.rows[0].count;
    } else {
      const current = await pool.query(
        'SELECT count FROM counts WHERE employee = $1 AND date = $2 AND category = $3',
        [target.employee, date, target.label]
      );
      count = current.rows.length > 0 ? current.rows[0].count : 0;
    }

    res.json({ employee: target.employee, category: target.category, date, count });
  } catch (err) {
    console.error('Fehler bei POST /decrement:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// Tagesnotiz fuer heute speichern (ersetzt den bisherigen Text komplett).
// Leerer Text loescht die Notiz.
//
// "rev" ist der Zeitpunkt (ms), zu dem der Text im Browser erfasst wurde.
// Gespeichert wird nur, wenn er nicht aelter ist als der vorhandene - so kann
// eine verspaetet ankommende Anfrage nie einen neueren Text ueberschreiben.
app.put('/api/note/:employee', async (req, res) => {
  try {
    const { employee } = req.params;
    const text = req.body && req.body.note;
    const rev = req.body && req.body.rev;

    if (!EMPLOYEES.includes(employee)) {
      return res.status(400).json({ error: 'Unbekannter Mitarbeiter' });
    }
    if (typeof text !== 'string') {
      return res.status(400).json({ error: 'Notiz fehlt' });
    }
    if (text.length > NOTE_MAX_LENGTH) {
      return res.status(400).json({ error: `Notiz zu lang (max. ${NOTE_MAX_LENGTH} Zeichen)` });
    }
    if (!Number.isSafeInteger(rev) || rev <= 0) {
      return res.status(400).json({ error: 'Ungueltige Version' });
    }

    const date = todayString();
    const note = text.trim() === '' ? '' : text;

    const result = await pool.query(
      `INSERT INTO notes (employee, date, note, rev, updated_at) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (employee, date) DO UPDATE
         SET note = EXCLUDED.note, rev = EXCLUDED.rev, updated_at = now()
         WHERE notes.rev <= EXCLUDED.rev`,
      [employee, date, note, rev]
    );

    res.json({ employee, date, saved: result.rowCount > 0 });
  } catch (err) {
    console.error('Fehler bei PUT /note:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

app.get('/api/history', async (req, res) => {
  try {
    const filters = buildFilters(req.query, res);
    if (!filters) return;

    // Datum als Text aus der Datenbank: keine Zeitzonen-Umrechnung moeglich.
    const result = await pool.query(
      dailyQuery(filters.where, 'YYYY-MM-DD', 'd.date DESC, employee ASC'),
      filters.params
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Fehler bei GET /history:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

app.get('/api/export/csv', async (req, res) => {
  try {
    // Export immer ueber alle Mitarbeiter, nur nach Monat filterbar.
    const filters = buildFilters({ month: req.query.month }, res);
    if (!filters) return;
    const { month } = filters;

    const result = await pool.query(
      dailyQuery(filters.where, 'DD.MM.YYYY', 'employee ASC, d.date ASC'),
      filters.params
    );

    let csv = 'Mitarbeiter;Datum;RTB;C&C;Gesamt;Notiz\n';
    for (const row of result.rows) {
      csv += [row.employee, row.date, row.rtb, row.cc, row.total, row.note].map(csvField).join(';') + '\n';
    }

    const filename = month ? `export_${month}.csv` : 'export_gesamt.csv';

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send('﻿' + csv);
  } catch (err) {
    console.error('Fehler bei GET /export/csv:', err.message);
    res.status(500).json({ error: 'Exportfehler' });
  }
});

async function start() {
  await initDatabase();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server laeuft auf Port ${PORT}`);
  });
}

start().catch(err => {
  console.error('Fehler beim Starten:', err);
  process.exit(1);
});
