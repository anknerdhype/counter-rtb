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

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS counts (
      id SERIAL PRIMARY KEY,
      employee TEXT NOT NULL,
      date DATE NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(employee, date)
    )
  `);
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

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', date: todayString() });
});

app.get('/api/employees', (req, res) => {
  res.json(EMPLOYEES);
});

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
      'SELECT count FROM counts WHERE employee = $1 AND date = $2',
      [employee, date]
    );

    const count = result.rows.length > 0 ? result.rows[0].count : 0;
    res.json({ employee, date, count });
  } catch (err) {
    console.error('Fehler bei GET /api/count:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

app.post('/api/count/:employee/increment', async (req, res) => {
  try {
    const { employee } = req.params;
    const date = todayString();

    if (!EMPLOYEES.includes(employee)) {
      return res.status(400).json({ error: 'Unbekannter Mitarbeiter' });
    }

    // Eine einzige atomare Anweisung: entweder sie schreibt und liefert den
    // neuen Stand, oder sie schreibt gar nicht. Kein Zwischenzustand.
    const result = await pool.query(
      `INSERT INTO counts (employee, date, count) VALUES ($1, $2, 1)
       ON CONFLICT (employee, date) DO UPDATE SET count = counts.count + 1
       RETURNING count`,
      [employee, date]
    );

    res.json({ employee, date, count: result.rows[0].count });
  } catch (err) {
    console.error('Fehler bei POST /increment:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

app.post('/api/count/:employee/decrement', async (req, res) => {
  try {
    const { employee } = req.params;
    const date = todayString();

    if (!EMPLOYEES.includes(employee)) {
      return res.status(400).json({ error: 'Unbekannter Mitarbeiter' });
    }

    const updated = await pool.query(
      `UPDATE counts SET count = count - 1
       WHERE employee = $1 AND date = $2 AND count > 0
       RETURNING count`,
      [employee, date]
    );

    if (updated.rows.length > 0) {
      return res.json({ employee, date, count: updated.rows[0].count });
    }

    const current = await pool.query(
      'SELECT count FROM counts WHERE employee = $1 AND date = $2',
      [employee, date]
    );

    res.json({ employee, date, count: current.rows.length > 0 ? current.rows[0].count : 0 });
  } catch (err) {
    console.error('Fehler bei POST /decrement:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

app.get('/api/history', async (req, res) => {
  try {
    const { employee, month } = req.query;

    // Datum als Text aus der Datenbank: keine Zeitzonen-Umrechnung moeglich.
    let query = `SELECT employee, TO_CHAR(date, 'YYYY-MM-DD') AS date, count
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

    query += ' ORDER BY date DESC, employee ASC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Fehler bei GET /history:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

app.get('/api/export/csv', async (req, res) => {
  try {
    const { month } = req.query;

    let query = `SELECT employee, TO_CHAR(date, 'DD.MM.YYYY') AS datum, count
                 FROM counts WHERE count > 0`;
    const params = [];

    if (month) {
      if (!isValidMonth(month)) {
        return res.status(400).json({ error: 'Ungueltiger Monat' });
      }
      query += ` AND TO_CHAR(date, 'YYYY-MM') = $1`;
      params.push(month);
    }

    query += ' ORDER BY employee ASC, date ASC';

    const result = await pool.query(query, params);

    let csv = 'Mitarbeiter;Datum;Stückzahl\n';
    for (const row of result.rows) {
      csv += `${row.employee};${row.datum};${row.count}\n`;
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
