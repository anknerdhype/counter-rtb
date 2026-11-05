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

// Summen-Spalten fuer Abfragen, die pro Mitarbeiter und Tag eine Zeile liefern.
const SUM_COLUMNS = `
  SUM(count) FILTER (WHERE category = 'RTB')::int AS rtb,
  SUM(count) FILTER (WHERE category = 'C&C')::int AS cc,
  SUM(count)::int AS total
`;

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

    res.json({ employee, date, counts });
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

app.get('/api/history', async (req, res) => {
  try {
    const { employee, month } = req.query;

    // Datum als Text aus der Datenbank: keine Zeitzonen-Umrechnung moeglich.
    let query = `SELECT employee, TO_CHAR(date, 'YYYY-MM-DD') AS date, ${SUM_COLUMNS}
                 FROM counts WHERE count > 0`;
    const params = [];
    let paramIndex = 1;

    if (employee) {
      if (!EMPLOYEES.includes(employee)) {
        return res.status(400).json({ error: 'Unbekannter Mitarbeiter' });
      }
      query += ` AND employee = $${paramIndex++}`;
      params.push(employee);
    }

    if (month) {
      if (!isValidMonth(month)) {
        return res.status(400).json({ error: 'Ungueltiger Monat' });
      }
      query += ` AND TO_CHAR(date, 'YYYY-MM') = $${paramIndex++}`;
      params.push(month);
    }

    query += ' GROUP BY employee, date ORDER BY date DESC, employee ASC';

    const result = await pool.query(query, params);
    res.json(result.rows.map(r => ({ ...r, rtb: r.rtb || 0, cc: r.cc || 0 })));
  } catch (err) {
    console.error('Fehler bei GET /history:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

app.get('/api/export/csv', async (req, res) => {
  try {
    const { month } = req.query;

    let query = `SELECT employee, TO_CHAR(date, 'DD.MM.YYYY') AS datum, ${SUM_COLUMNS}
                 FROM counts WHERE count > 0`;
    const params = [];

    if (month) {
      if (!isValidMonth(month)) {
        return res.status(400).json({ error: 'Ungueltiger Monat' });
      }
      query += ` AND TO_CHAR(date, 'YYYY-MM') = $1`;
      params.push(month);
    }

    query += ' GROUP BY employee, date ORDER BY employee ASC, date ASC';

    const result = await pool.query(query, params);

    let csv = 'Mitarbeiter;Datum;RTB;C&C;Gesamt\n';
    for (const row of result.rows) {
      csv += `${row.employee};${row.datum};${row.rtb || 0};${row.cc || 0};${row.total}\n`;
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
