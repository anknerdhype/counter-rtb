const API = window.location.origin + '/api';
const CATEGORY_KEYS = ['rtb', 'cc'];

let currentEmployee = null;
const counts = { rtb: 0, cc: 0 };

// Anzahl noch laufender Klick-Anfragen je Mitarbeiter und Zaehler.
// Solange welche laufen, zeigt die Anzeige den sofort hochgezaehlten Wert;
// erst wenn alle fertig sind, wird der echte Stand vom Server geholt.
// (Antworten einzelner Klicks sind dafuer ungeeignet: der Server bearbeitet
// parallele Anfragen nicht zwingend in Sende-Reihenfolge.)
const inFlight = {};
const flightKey = (employee, category) => `${employee}|${category}`;

// Statuscodes, die von Renders Proxy stammen (Server schlaeft/startet) und
// garantiert nicht in der Datenbank angekommen sind - nur die sind fuer
// Schreibvorgaenge sicher wiederholbar.
const INFRA_STATUS = [404, 408, 425, 429, 502, 503, 504];
const READ_RETRY = { statuses: [...INFRA_STATUS, 500], retryOnNetworkError: true };
const WRITE_RETRY = { statuses: INFRA_STATUS, retryOnNetworkError: false };

async function apiFetch(url, options, retry) {
  const { statuses, retryOnNetworkError } = retry;
  const attempts = 3;
  let lastError;

  for (let i = 0; i < attempts; i++) {
    let res;

    try {
      res = await fetch(url, options);
    } catch (networkError) {
      // Bei Schreibvorgaengen ist unklar, ob der Klick noch angekommen ist -
      // dann lieber melden statt zu wiederholen und doppelt zu zaehlen.
      if (!retryOnNetworkError) throw networkError;
      lastError = networkError;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 800 * (i + 1)));
      continue;
    }

    if (res.ok) return res;
    if (!statuses.includes(res.status)) throw new Error('HTTP ' + res.status);

    lastError = new Error('HTTP ' + res.status);
    if (i < attempts - 1) await new Promise(r => setTimeout(r, 800 * (i + 1)));
  }

  throw lastError;
}

function showError(message) {
  const banner = document.getElementById('errorBanner');
  banner.textContent = message;
  banner.hidden = false;
}

function clearError() {
  document.getElementById('errorBanner').hidden = true;
}

function formatDate(dateStr) {
  const parts = dateStr.split('-');
  return `${parts[2]}.${parts[1]}.${parts[0]}`;
}

function todayString() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date());
}

function currentMonthString() {
  return todayString().slice(0, 7);
}

function showDate() {
  const now = new Date();
  const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Europe/Berlin' };
  document.getElementById('currentDate').textContent = now.toLocaleDateString('de-DE', options);
}

function counterCard(category) {
  return document.querySelector(`.counter-section[data-category="${category}"]`);
}

function renderCount(category) {
  counterCard(category).querySelector('[data-role="value"]').textContent = counts[category];
}

function animateCounter(category) {
  const el = counterCard(category).querySelector('[data-role="value"]');
  el.style.transform = 'scale(1.15)';
  setTimeout(() => { el.style.transform = 'scale(1)'; }, 150);
}

async function loadEmployees() {
  try {
    const res = await apiFetch(API + '/employees', undefined, READ_RETRY);
    const employees = await res.json();

    const tabsContainer = document.getElementById('tabs');
    tabsContainer.innerHTML = '';

    employees.forEach((name, index) => {
      const btn = document.createElement('button');
      btn.textContent = name;
      btn.dataset.employee = name;
      btn.addEventListener('click', () => selectEmployee(name));
      tabsContainer.appendChild(btn);

      if (index === 0) selectEmployee(name);
    });
  } catch (e) {
    showError('Verbindung zum Server fehlgeschlagen. Bitte Seite neu laden.');
  }
}

async function selectEmployee(name) {
  currentEmployee = name;

  document.querySelectorAll('.tabs button').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.employee === name);
  });

  await loadCounts();
  await loadHistory();
}

async function loadCounts() {
  const employee = currentEmployee;
  try {
    const res = await apiFetch(`${API}/count/${encodeURIComponent(employee)}?date=${todayString()}`, undefined, READ_RETRY);
    const data = await res.json();
    if (employee !== currentEmployee) return;
    for (const key of CATEGORY_KEYS) {
      // Zaehler mit laufenden Klicks nicht mit einem Zwischenstand ueberschreiben.
      if (inFlight[flightKey(employee, key)]) continue;
      counts[key] = data.counts[key] || 0;
      renderCount(key);
    }
    clearError();
  } catch (e) {
    showError('Zaehlerstand konnte nicht geladen werden.');
  }
}

async function changeCount(category, delta) {
  const employee = currentEmployee;
  if (!employee) return;
  if (delta < 0 && counts[category] <= 0) return;

  const action = delta > 0 ? 'increment' : 'decrement';
  const key = flightKey(employee, category);

  // Sofortige Anzeige, damit schnelles Klicken sich fluessig anfuehlt.
  counts[category] = Math.max(0, counts[category] + delta);
  renderCount(category);
  if (delta > 0) animateCounter(category);

  inFlight[key] = (inFlight[key] || 0) + 1;
  let failed = false;
  try {
    await apiFetch(
      `${API}/count/${encodeURIComponent(employee)}/${category}/${action}`,
      { method: 'POST' },
      WRITE_RETRY
    );
  } catch (e) {
    failed = true;
  } finally {
    inFlight[key] -= 1;
  }

  // Erst wenn alle Klicks dieses Zaehlers gespeichert sind: echten Stand holen.
  if (inFlight[key] === 0 && employee === currentEmployee) {
    await loadCounts();
    await loadHistory();
  }

  // Zuletzt, damit das erfolgreiche Nachladen den Hinweis nicht wieder ausblendet.
  if (failed) showError('Klick konnte nicht gespeichert werden - bitte erneut klicken.');
}

async function loadHistory() {
  const employee = currentEmployee;
  const month = document.getElementById('filterMonth').value;
  let url = `${API}/history?employee=${encodeURIComponent(employee)}`;
  if (month) url += `&month=${month}`;

  let rows;
  try {
    const res = await apiFetch(url, undefined, READ_RETRY);
    rows = await res.json();
  } catch (e) {
    showError('Uebersicht konnte nicht geladen werden.');
    return;
  }

  if (employee !== currentEmployee) return;

  const tbody = document.getElementById('historyBody');
  const emptyState = document.getElementById('emptyState');
  const table = document.querySelector('table');

  if (rows.length === 0) {
    tbody.innerHTML = '';
    emptyState.style.display = 'block';
    table.style.display = 'none';
    return;
  }

  emptyState.style.display = 'none';
  table.style.display = 'table';

  tbody.innerHTML = rows.map(row => `
    <tr>
      <td class="col-employee">${row.employee}</td>
      <td>${formatDate(row.date)}</td>
      <td class="num">${row.rtb}</td>
      <td class="num">${row.cc}</td>
      <td class="num">${row.total}</td>
    </tr>
  `).join('');
}

function populateMonthFilter() {
  const select = document.getElementById('filterMonth');
  const now = new Date();

  for (let i = 0; i < 12; i++) {
    const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');

    const option = document.createElement('option');
    option.value = `${y}-${m}`;
    option.textContent = date.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
    select.appendChild(option);
  }
}

function exportCSV(month) {
  let url = `${API}/export/csv`;
  if (month) url += `?month=${month}`;
  window.location.href = url;
}

for (const key of CATEGORY_KEYS) {
  counterCard(key).querySelectorAll('.counter-btn').forEach(btn => {
    btn.addEventListener('click', () => changeCount(key, Number(btn.dataset.delta)));
  });
}

document.getElementById('filterMonth').addEventListener('change', () => loadHistory());

document.getElementById('btnExportAll').addEventListener('click', () => exportCSV(null));
document.getElementById('btnExportMonth').addEventListener('click', () => exportCSV(currentMonthString()));

showDate();
populateMonthFilter();
loadEmployees();
