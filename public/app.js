const API = window.location.origin + '/api';

let currentEmployee = null;
let currentCount = 0;

function formatDate(dateStr) {
  const parts = dateStr.split('-');
  return `${parts[2]}.${parts[1]}.${parts[0]}`;
}

function todayString() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function currentMonthString() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function showDate() {
  const now = new Date();
  const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
  document.getElementById('currentDate').textContent = now.toLocaleDateString('de-DE', options);
}

async function loadEmployees() {
  const res = await fetch(API + '/employees');
  const employees = await res.json();

  const tabsContainer = document.getElementById('tabs');
  tabsContainer.innerHTML = '';

  employees.forEach((name, index) => {
    const btn = document.createElement('button');
    btn.textContent = name;
    btn.dataset.employee = name;
    btn.addEventListener('click', () => selectEmployee(name));
    tabsContainer.appendChild(btn);

    if (index === 0) {
      selectEmployee(name);
    }
  });
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
  const res = await fetch(`${API}/count/${encodeURIComponent(currentEmployee)}?date=${todayString()}`);
  const data = await res.json();
  currentCount = data.count;
  document.getElementById('counterValue').textContent = currentCount;
}

async function increment() {
  const res = await fetch(`${API}/count/${encodeURIComponent(currentEmployee)}/increment`, { method: 'POST' });
  const data = await res.json();
  currentCount = data.count;
  document.getElementById('counterValue').textContent = currentCount;
  animateCounter();
  await loadHistory();
}

async function decrement() {
  if (currentCount <= 0) return;
  const res = await fetch(`${API}/count/${encodeURIComponent(currentEmployee)}/decrement`, { method: 'POST' });
  const data = await res.json();
  currentCount = data.count;
  document.getElementById('counterValue').textContent = currentCount;
  await loadHistory();
}

function animateCounter() {
  const el = document.getElementById('counterValue');
  el.style.transform = 'scale(1.15)';
  setTimeout(() => { el.style.transform = 'scale(1)'; }, 150);
}

async function loadHistory() {
  const month = document.getElementById('filterMonth').value;
  let url = `${API}/history?employee=${encodeURIComponent(currentEmployee)}`;
  if (month) {
    url += `&month=${month}`;
  }

  const res = await fetch(url);
  const rows = await res.json();

  const tbody = document.getElementById('historyBody');
  const emptyState = document.getElementById('emptyState');

  if (rows.length === 0) {
    tbody.innerHTML = '';
    emptyState.style.display = 'block';
    document.querySelector('table').style.display = 'none';
    return;
  }

  emptyState.style.display = 'none';
  document.querySelector('table').style.display = 'table';

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
    const value = `${y}-${m}`;
    const label = date.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });

    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  }
}

function exportCSV(month) {
  let url = `${API}/export/csv`;
  if (month) {
    url += `?month=${month}`;
  }
  window.location.href = url;
}

document.getElementById('btnIncrement').addEventListener('click', increment);
document.getElementById('btnDecrement').addEventListener('click', decrement);

document.getElementById('filterMonth').addEventListener('change', () => {
  loadHistory();
});

document.getElementById('btnExportAll').addEventListener('click', () => {
  exportCSV(null);
});

document.getElementById('btnExportMonth').addEventListener('click', () => {
  exportCSV(currentMonthString());
});

document.getElementById('counterValue').style.transition = 'transform 0.15s ease';

showDate();
populateMonthFilter();
loadEmployees();
