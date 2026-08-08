# Umzug der Datenbank zu Neon

**Warum:** Die kostenlose PostgreSQL-Datenbank bei Render läuft nach 30 Tagen ab und
wird nach weiteren 14 Tagen mitsamt allen Daten gelöscht. Kostenlose Render-Datenbanken
unterstützen außerdem keine Backups. Neon hat kein Ablaufdatum.

**Am Code ändert sich nichts.** Die App nutzt Standard-PostgreSQL über die Variable
`DATABASE_URL` – es wird nur diese eine Adresse ausgetauscht.

**Dauer:** etwa 10 Minuten.

---

## Schritt 0: Daten sichern (nur falls schon gezählt wurde)

Falls in der App bereits echte Stückzahlen erfasst sind:

1. App öffnen: https://counter-rtb.onrender.com
2. Auf **Alle Daten exportieren (CSV)** klicken
3. Datei gut ablegen

Die neue Datenbank startet leer. Bereits erfasste Zahlen müssten nachgetragen werden –
deshalb der Umzug am besten so früh wie möglich.

---

## Schritt 1: Neon-Konto anlegen

1. https://neon.com öffnen
2. **Sign up** – am einfachsten mit dem GitHub-Konto
3. Kostenlos, keine Kreditkarte nötig

---

## Schritt 2: Projekt erstellen

Nach der Anmeldung erscheint die Projekterstellung:

| Feld | Eingabe |
|------|---------|
| Project name | `counter-rtb` |
| Postgres version | Vorauswahl belassen |
| Region | **Europe (Frankfurt)** |

Region Frankfurt wählen – das hält die App schnell, da der Render-Server ebenfalls in
Europa laufen sollte.

Auf **Create project** klicken.

---

## Schritt 3: Verbindungsadresse kopieren

Direkt nach dem Anlegen zeigt Neon die **Connection string** an:

1. Falls eine Auswahl erscheint: **Pooled connection** verwenden
2. Auf das Kopiersymbol klicken

Die Adresse sieht so aus:

```
postgresql://neondb_owner:XXXXXXXX@ep-xxxx-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require
```

Sie enthält das Datenbank-Passwort – nicht weitergeben und nicht in GitHub einchecken.

Später wiederzufinden unter: Projekt → **Connect** bzw. **Connection Details**.

---

## Schritt 4: Adresse in Render eintragen

1. https://dashboard.render.com öffnen
2. Web Service **counter-rtb** anklicken (nicht die Datenbank)
3. Links im Menü auf **Environment**
4. Bei der Variable `DATABASE_URL` auf **Edit** klicken
5. Alten Wert vollständig löschen, neue Neon-Adresse einfügen
6. **Save changes**

Render startet die App daraufhin automatisch neu.

---

## Schritt 5: Prüfen, ob der Umzug geklappt hat

Nach ein bis zwei Minuten:

**a) Serverstatus prüfen** – im Browser aufrufen:

```
https://counter-rtb.onrender.com/api/health
```

Erwartete Antwort:

```json
{"status":"ok","date":"2026-08-08"}
```

Die Tabelle wird beim Start automatisch angelegt – dafür ist nichts zu tun.

**b) Funktionstest**

1. App öffnen
2. Bei einem Mitarbeiter einmal auf **+** klicken
3. Die Zahl muss auf 1 springen und in der Tabelle mit dem heutigen Datum erscheinen
4. Seite neu laden – der Wert muss erhalten bleiben

Bleibt der Wert erhalten, läuft die App auf Neon.

**c) Testeintrag entfernen**

Einmal auf **−** klicken, damit die Erfassung sauber bei 0 startet.

---

## Schritt 6: Alte Render-Datenbank löschen

Erst durchführen, wenn Schritt 5 erfolgreich war.

1. Render-Dashboard → Datenbank **counter-rtb-db**
2. **Settings** → ganz nach unten
3. **Delete Database**

Das verhindert, dass später versehentlich die ablaufende Datenbank verwendet wird.

---

## Was danach anders ist

- **Kein Ablaufdatum mehr.** Die Datenbank wird nicht gelöscht.
- **Die Datenbank pausiert nach 5 Minuten ohne Zugriff** und ist beim nächsten Zugriff
  in etwa einer Sekunde wieder da. Das ist deutlich schneller als der Render-Webserver,
  der weiterhin bis zu 30 Sekunden zum Aufwachen braucht.
- **Speicher:** 0,5 GB im kostenlosen Tarif. Die Erfassung von sechs Mitarbeitern
  erzeugt etwa 1.500 Zeilen pro Jahr – das sind wenige Kilobyte.
- **Rechenzeit:** Der kostenlose Tarif enthält ein monatliches Kontingent. Für einen
  Klickzähler mit sechs Personen reicht das aus; der Verbrauch ist im Neon-Dashboard
  unter *Usage* einsehbar.

---

## Empfehlung unabhängig vom Anbieter

Einmal im Monat **Aktuellen Monat exportieren (CSV)** klicken und die Datei ablegen.
Das kostet zehn Sekunden und ist die verlässlichste Sicherung der Arbeitsdaten.

---

## Wenn etwas nicht klappt

| Symptom | Ursache und Lösung |
|---------|--------------------|
| `/api/health` antwortet nicht | Render-Logs prüfen: Dashboard → counter-rtb → **Logs**. Meist ein Tippfehler in der Adresse. |
| Fehlerbanner „Verbindung zum Server fehlgeschlagen" | Adresse unvollständig kopiert – sie muss mit `postgresql://` beginnen und auf `?sslmode=require` enden. |
| Zahlen nach Neuladen weg | Es wird noch die alte Adresse verwendet: In Render prüfen, ob `DATABASE_URL` wirklich gespeichert wurde. |
| Erste Anfrage dauert lange | Normal: Render-Webserver wacht auf (bis 30 Sek.), danach flüssig. |
