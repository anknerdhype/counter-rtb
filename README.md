# Counter RTB – Stückzähler

Weboberfläche, mit der sechs Mitarbeiter ihre tagesaktuell fertiggestellten Stücke
per Klick erfassen. Jeder Mitarbeiter hat einen eigenen Tab mit Plus-/Minus-Knopf
und der aktuellen Zahl. Die Erfassung wird pro Mitarbeiter und Tag gespeichert und
lässt sich als CSV exportieren.

**Live:** https://counter-rtb.onrender.com

---

## Funktionen

- Sechs Mitarbeiter-Tabs: Serkan, Julius, Hannes, Walid, Tobias, Andreas
- Plus/Minus mit sofortiger Anzeige, Minus stoppt bei 0
- Datum wird automatisch auf den aktuellen Tag gesetzt (deutsche Zeitzone)
- Tabelle der erfassten Tage, filterbar nach Monat
- CSV-Export: alle Daten oder ein einzelner Monat
- Von mehreren Geräten gleichzeitig nutzbar, gemeinsame Datenbasis

---

## Technik

| Bereich | Verwendet |
|---------|-----------|
| Backend | Node.js, Express |
| Datenbank | PostgreSQL (Treiber `pg`) |
| Frontend | HTML, CSS, JavaScript ohne Framework |
| Hosting | Render (Webserver), Neon (Datenbank) |

### Dateien

```
server.js           Express-Server, API, Datenbankzugriff
public/index.html   Seitenstruktur
public/style.css    Gestaltung (Grau/Weiß/Dunkelblau), inkl. Handy-Ansicht
public/app.js       Bedienlogik, API-Aufrufe, Tabelle, Export
render.yaml         Deployment-Konfiguration für Render
NEON-UMZUG.md       Anleitung für den Datenbankumzug zu Neon
```

---

## Datenmodell

Eine Tabelle, die beim Serverstart automatisch angelegt wird:

```sql
CREATE TABLE counts (
  id       SERIAL PRIMARY KEY,
  employee TEXT    NOT NULL,
  date     DATE    NOT NULL,
  count    INTEGER NOT NULL DEFAULT 0,
  UNIQUE(employee, date)
);
```

Pro Mitarbeiter und Tag existiert genau eine Zeile. Zeilen mit `count = 0` werden in
Tabelle und Export ausgeblendet.

---

## API

| Methode | Pfad | Zweck |
|---------|------|-------|
| GET | `/api/health` | Statusprüfung, liefert auch das Serverdatum |
| GET | `/api/employees` | Liste der Mitarbeiter |
| GET | `/api/count/:employee?date=YYYY-MM-DD` | Stand eines Tages (Standard: heute) |
| POST | `/api/count/:employee/increment` | Heutigen Wert um 1 erhöhen |
| POST | `/api/count/:employee/decrement` | Heutigen Wert um 1 senken (nicht unter 0) |
| GET | `/api/history?employee=&month=YYYY-MM` | Erfasste Tage, optional gefiltert |
| GET | `/api/export/csv?month=YYYY-MM` | CSV-Download, ohne `month` alle Daten |

Mitarbeitername, Datum und Monat werden serverseitig geprüft; unbekannte Werte
werden mit Status 400 abgewiesen.

Die CSV-Datei ist semikolongetrennt und beginnt mit einem BOM, damit Excel in
deutscher Einstellung die Spalten und Umlaute direkt korrekt darstellt.

---

## Wichtige Entscheidungen im Code

Diese Punkte sehen wie Details aus, halten aber Fehler fern, die vorher aufgetreten
sind. Beim Ändern bitte beachten:

**Datumsformatierung passiert in SQL, nicht in JavaScript.**
`history` und der CSV-Export verwenden `TO_CHAR(date, ...)`. Der Treiber `pg` würde
eine `DATE`-Spalte sonst in ein JavaScript-Datum um lokale Mitternacht umwandeln;
`toISOString()` rechnet das auf UTC zurück und liefert bei deutscher Zeitzone den
Vortag. Genau dieser Fehler war in der Tabelle sichtbar.

**Der heutige Tag wird über `Intl` in der Zone `Europe/Berlin` bestimmt.**
So hängt das Datum nicht von der Zeitzone des Servers ab.

**Plus und Minus sind je eine einzige atomare SQL-Anweisung mit `RETURNING`.**
Dadurch gibt es kein Zeitfenster zwischen Schreiben und Lesen, in dem parallele
Klicks einen falschen Stand liefern könnten.

**Wiederholversuche im Browser unterscheiden Lesen und Schreiben.**
Lesende Aufrufe werden bei jedem Fehler wiederholt. Schreibende nur bei Fehlern der
vorgelagerten Render-Infrastruktur (z. B. 502/503, wenn der Server aufwacht) – dort
ist gesichert, dass nichts in der Datenbank angekommen ist. Bei Netzwerkabbrüchen
oder Serverfehlern wird **nicht** wiederholt, weil sonst ein Klick doppelt gezählt
werden könnte. Schlägt ein Klick fehl, erscheint ein Hinweisbanner.

**Die Anzeige aktualisiert sich sofort, die Serverantwort korrigiert nach.**
Jede Anfrage trägt eine laufende Nummer; nur die Antwort auf die jüngste Anfrage
darf die Anzeige setzen. Das hält schnelles Klicken flüssig und konsistent.

---

## Lokal starten

Voraussetzung: Node.js und eine erreichbare PostgreSQL-Datenbank.

```bash
npm install
```

Die Verbindung wird über die Umgebungsvariable `DATABASE_URL` gesetzt:

```bash
$env:DATABASE_URL = "postgresql://benutzer:passwort@host/datenbank?sslmode=require"
node server.js
```

Danach im Browser http://localhost:3000 öffnen.

Für Tests nicht die Produktionsdatenbank verwenden – in Neon lässt sich dafür ein
zweites Projekt oder ein Branch anlegen.

---

## Deployment

Der Webserver läuft auf Render und deployt automatisch bei jedem Push auf `main`.

Die Datenbank liegt bei Neon und ist **absichtlich nicht** in `render.yaml`
deklariert: Kostenlose Render-Datenbanken laufen nach 30 Tagen ab und werden danach
samt Daten gelöscht. `DATABASE_URL` wird deshalb direkt in Render gesetzt
(Dashboard → `counter-rtb` → Environment) und ist in `render.yaml` als
`sync: false` markiert, damit sie nicht überschrieben wird.

Der Umzug der Datenbank ist in [NEON-UMZUG.md](NEON-UMZUG.md) beschrieben.

---

## Wartung

**Monatlich sichern.** Einmal pro Monat *Aktuellen Monat exportieren (CSV)* klicken
und die Datei ablegen. Der kostenlose Neon-Tarif bietet keine Backups.

**Kaltstart.** Der Render-Webserver schläft nach etwa 15 Minuten ohne Zugriff ein;
der erste Aufruf danach dauert bis zu 30 Sekunden. Die Datenbank pausiert nach fünf
Minuten und ist in etwa einer Sekunde wieder da. Ein kostenloser Ping-Dienst auf
`/api/health` alle 14 Minuten hält den Webserver wach.

**Mitarbeiter ändern.** Die Namen stehen in `server.js` in der Liste `EMPLOYEES`.
Nach einer Änderung erscheinen die Tabs automatisch. Bereits erfasste Daten eines
entfernten Mitarbeiters bleiben in der Datenbank erhalten, verschwinden aber aus der
Oberfläche.

---

## Bekannte Grenzen

- **Kein Zugriffsschutz.** Wer die Adresse kennt, kann für jeden Mitarbeiter zählen
  und alle Daten exportieren.
- **Nur der heutige Tag ist änderbar.** Ein falscher Wert von gestern lässt sich über
  die Oberfläche nicht korrigieren.
- **Die Tabelle zeigt nur den ausgewählten Mitarbeiter.** Der CSV-Export enthält alle.
- **Kein Verlauf einzelner Klicks.** Gespeichert wird nur die Tagessumme, nicht der
  Zeitpunkt der einzelnen Erfassung.
