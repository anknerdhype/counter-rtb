const API = window.location.origin + '/api';

let currentEmployee = null;
let currentCount = 0;
let requestSeq = 0;

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

function renderCount(value) {
  document.getElementById('counterValue').textContent = value;
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

  await loadCount();
  await loadHistory();
}

async function loadCount() {
  const employee = currentEmployee;
  try {
    const res = await apiFetch(`${API}/count/${encodeURIComponent(employee)}?date=${todayString()}`, undefined, READ_RETRY);
    const data = await res.json();
    if (employee !== currentEmployee) return;
    currentCount = data.count;
    renderCount(currentCount);
    clearError();
  } catch (e) {
    showError('Zaehlerstand konnte nicht geladen werden.');
  }
}

async function changeCount(delta) {
  const employee = currentEmployee;
  if (!employee) return;
  if (delta < 0 && currentCount <= 0) return;

  const action = delta > 0 ? 'increment' : 'decrement';
  const mySeq = ++requestSeq;

  // Sofortige Anzeige, damit schnelles Klicken sich fluessig anfuehlt.
  currentCount = Math.max(0, currentCount + delta);
  renderCount(currentCount);
  if (delta > 0) animateCounter();

  try {
    const res = await apiFetch(
      `${API}/count/${encodeURIComponent(employee)}/${action}`,
      { method: 'POST' },
      WRITE_RETRY
    );
    const data = await res.json();

    // Nur die Antwort auf die zuletzt gesendete Anfrage darf die Anzeige setzen.
    if (mySeq === requestSeq && employee === currentEmployee) {
      currentCount = data.count;
      renderCount(currentCount);
    }
    clearError();
    if (employee === currentEmployee) await loadHistory();
  } catch (e) {
    showError('Klick konnte nicht gespeichert werden - bitte erneut klicken.');
    if (employee === currentEmployee) await loadCount();
  }
}

function animateCounter() {
  const el = document.getElementById('counterValue');
  el.style.transform = 'scale(1.15)';
  setTimeout(() => { el.style.transform = 'scale(1)'; }, 150);
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
      <td>${row.employee}</td>
      <td>${formatDate(row.date)}</td>
      <td>${row.count}</td>
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

document.getElementById('btnIncrement').addEventListener('click', () => changeCount(1));
document.getElementById('btnDecrement').addEventListener('click', () => changeCount(-1));

document.getElementById('filterMonth').addEventListener('change', () => loadHistory());

document.getElementById('btnExportAll').addEventListener('click', () => exportCSV(null));
document.getElementById('btnExportMonth').addEventListener('click', () => exportCSV(currentMonthString()));

document.getElementById('counterValue').style.transition = 'transform 0.15s ease';

showDate();
populateMonthFilter();
loadEmployees();
