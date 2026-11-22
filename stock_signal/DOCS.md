# Stock & ETF Signal Server – Dokumentation (v1.5.1)

## Daten und Signale

Kursdaten werden ohne API-Key über Yahoo Finance (yfinance) geladen. Aktien und ETFs werden über die Add-on-Optionen getrennt konfiguriert. Aktien werden mit 5-Minuten-Kerzen (Fallback 15 Minuten) für kurze Haltedauern analysiert. ETFs werden bewusst mit Tageskerzen bewertet, damit DCA-/Nachkaufkandidaten nicht aus kurzfristigem 5-Minuten-Rauschen entstehen. VWAP wird bei Aktien je Handelstag zurückgesetzt; bei ETFs wird ein rollierender 20-Tage-VWAP verwendet. Die ATR-Marken dienen nur als technische Orientierung und werden nicht als Order ausgeführt. Yahoo kann Daten verzögert liefern oder Intraday-Daten zeitweise nicht bereitstellen.

Technische Indikatoren:
- RSI (14)
- MACD (12/26/9)
- Bollinger-Bänder (20, 2)
- SMA 20 / 50 / 200 und EMA 12 / 26
- Session-VWAP, Stochastic %K/%D, ADX, CCI, ATR und 20-Kerzen-Volumenmittel
- ATR-basierte Orientierungsmarken: Stop-Loss bei 1,5 × ATR und Kursziel bei 2 × ATR (keine garantierten Kursmarken)

Long-/Short-Scores werden aus mehreren Indikatorgruppen gebildet. Ein Signal entsteht ab einer Netto-Differenz von 28 Punkten. **Confidence ist ein heuristischer Übereinstimmungswert, keine statistische Wahrscheinlichkeit.** Bei zu wenigen oder unvollständigen Daten wird kein belastbares Signal ausgegeben. Fehlgeschlagene Aktualisierungen löschen nicht den letzten gültigen Kursstand.

## Portfolio

Das Portfolio wird persistent unter `/data/portfolio.json` gespeichert. Beschädigte JSON-Dateien werden nicht stillschweigend als leeres Depot überschrieben. Für nicht bepreiste Positionen werden Marktwert und P&L je Position als nicht verfügbar ausgewiesen; die Depotübersicht meldet die Anzahl solcher Positionen.

- `GET /portfolio` – Positionen, Marktwert und Gewinn/Verlust
- `POST /portfolio` – gesamtes Portfolio als JSON-Array ersetzen
- `POST /portfolio/holding` – Position hinzufügen/ersetzen
- `DELETE /portfolio/holding/<TICKER>` – Position löschen
- `GET /recommendations` – Positionen nach Signal-Confidence sortiert
- Portfolio-Antworten enthalten zusätzlich `unpriced_count` und `valued_invested`, damit fehlende Kursdaten nicht mit Nullwerten verwechselt werden.

Ein Portfolio-Eintrag benötigt `ticker`, `quantity` und `avg_cost`; optional sind `name` und `is_etf`.

## REST API

- `GET /health` – Dienststatus, Analysezyklus und Anzahl Signale
- `GET /signals` – zuletzt verfügbare Signale
- `GET /signal/<TICKER>` – einzelnes Signal
- `POST /analyze` – einmalige Analyse mit JSON `{"ticker":"AAPL","is_etf":false}`
- `POST /refresh` – Analysezyklus starten (HTTP 202; verhindert parallele Jobs)
- `GET /etf_opportunities` – ETF-Kandidaten

## MQTT

- `stock_signal/summary`
- `stock_signal/<TICKER>` (JSON)
- `stock_signal/<TICKER>/signal`
- `stock_signal/<TICKER>/strength`
- `stock_signal/<TICKER>/confidence`
- `stock_signal/etf_opportunities`

MQTT-Nachrichten werden retained veröffentlicht. Der Client verwendet asynchrone Verbindung und automatische Wiederverbindungsintervalle.

## Hinweis

Die Anwendung ist ein technisches Analysewerkzeug und keine Anlageberatung. Yahoo-Finance-Daten können verzögert, unvollständig oder zeitweise nicht verfügbar sein. Vor jeder Transaktion Daten und Risiken selbst prüfen.

## Push-Benachrichtigungen
Web Push verwendet persistente VAPID-Schlüssel. Geräte können in der GUI unter Einstellungen registriert werden. Benachrichtigungen werden bei einem Wechsel zu Long oder Short und ab der eingestellten Mindest-Confidence versendet. HTTPS und Browser-Berechtigung sind erforderlich. Private Schlüssel und Abonnements werden unter /data gespeichert; abgelaufene Abonnements werden entfernt.
API: GET/POST /push/settings, GET /push/public-key, POST /push/subscribe und POST /push/test.

## Scalable Capital MCP
Scalable MCP ist ein Remote-MCP-Server für kompatible KI-Clients, keine lokale Broker-API. Die GUI stellt Serveradresse und Einrichtungsanleitung bereit. OAuth und 2FA erfolgen im unterstützten KI-Client. Das Add-on speichert keine Scalable-Zugangsdaten und behauptet keine direkte MCP-Verbindung. Depotdaten können als JSON importiert werden.
