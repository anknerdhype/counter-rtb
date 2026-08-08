const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');

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

function todayString() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

app.get('/api/employees', (req, res) => {
  res.json(EMPLOYEES);
});

app.get('/api/count/:employee', async (req, res) => {
  const { employee } = req.params;
  const date = req.query.date || todayString();

  if (!EMPLOYEES.includes(employee)) {
    return res.status(400).json({ error: 'Unbekannter Mitarbeiter' });
  }

  const result = await pool.query(
    'SELECT count FROM counts WHERE employee = $1 AND date = $2',
    [employee, date]
  );

  const count = result.rows.length > 0 ? result.rows[0].count : 0;
  res.json({ employee, date, count });
});

app.post('/api/count/:employee/increment', async (req, res) => {
  const { employee } = req.params;
  const date = todayString();

  if (!EMPLOYEES.includes(employee)) {
    return res.status(400).json({ error: 'Unbekannter Mitarbeiter' });
  }

  await pool.query(
    `INSERT INTO counts (employee, date, count) VALUES ($1, $2, 1)
     ON CONFLICT (employee, date) DO UPDATE SET count = counts.count + 1`,
    [employee, date]
  );

  const result = await pool.query(
    'SELECT count FROM counts WHERE employee = $1 AND date = $2',
    [employee, date]
  );

  res.json({ employee, date, count: result.rows[0].count });
});

app.post('/api/count/:employee/decrement', async (req, res) => {
  const { employee } = req.params;
  const date = todayString();

  if (!EMPLOYEES.includes(employee)) {
    return res.status(400).json({ error: 'Unbekannter Mitarbeiter' });
  }

  await pool.query(
    `UPDATE counts SET count = count - 1 WHERE employee = $1 AND date = $2 AND count > 0`,
    [employee, date]
  );

  const result = await pool.query(
    'SELECT count FROM counts WHERE employee = $1 AND date = $2',
    [employee, date]
  );

  const count = result.rows.length > 0 ? result.rows[0].count : 0;
  res.json({ employee, date, count });
});

app.get('/api/history', async (req, res) => {
  const { employee, month } = req.query;

  let query = 'SELECT employee, date, count FROM counts WHERE count > 0';
  const params = [];
  let paramIndex = 1;

  if (employee) {
    query += ` AND employee = $${paramIndex++}`;
    params.push(employee);
  }

  if (month) {
    query += ` AND TO_CHAR(date, 'YYYY-MM') = $${paramIndex++}`;
    params.push(month);
  }

  query += ' ORDER BY date DESC, employee ASC';

  const result = await pool.query(query, params);

  const rows = result.rows.map(row => ({
    employee: row.employee,
    date: row.date.toISOString().split('T')[0],
    count: row.count
  }));

  res.json(rows);
});

app.get('/api/export/csv', async (req, res) => {
  const { month } = req.query;

  let query = 'SELECT employee, date, count FROM counts WHERE count > 0';
  const params = [];
  let paramIndex = 1;

  if (month) {
    query += ` AND TO_CHAR(date, 'YYYY-MM') = $${paramIndex++}`;
    params.push(month);
  }

  query += ' ORDER BY employee ASC, date ASC';

  const result = await pool.query(query, params);

  let csv = 'Mitarbeiter;Datum;Stueckzahl\n';

  for (const row of result.rows) {
    const d = row.date;
    const dateFormatted = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
    csv += `${row.employee};${dateFormatted};${row.count}\n`;
  }

  const filename = month ? `export_${month}.csv` : 'export_gesamt.csv';

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('﻿' + csv);
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
