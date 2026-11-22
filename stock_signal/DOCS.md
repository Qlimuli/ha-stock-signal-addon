# Stock & ETF Signal Server – Dokumentation (v1.3)

## Daten und Signale

Kursdaten werden ohne API-Key über Yahoo Finance (yfinance) geladen. Aktien und ETFs werden über die Add-on-Optionen getrennt konfiguriert.

Technische Indikatoren:
- RSI (14)
- MACD (12/26/9)
- Bollinger-Bänder (20, 2)
- SMA 20 / 50 / 200 und EMA 12 / 26
- Volumen und 20-Tage-Volumenmittel

Long-/Short-Scores werden aus mehreren Indikatorgruppen gebildet. Ein Signal entsteht ab einer Netto-Differenz von 28 Punkten. **Confidence ist ein heuristischer Übereinstimmungswert, keine statistische Wahrscheinlichkeit.** Bei zu wenigen oder unvollständigen Daten wird kein belastbares Signal ausgegeben. Fehlgeschlagene Aktualisierungen löschen nicht den letzten gültigen Kursstand.

## Portfolio

Das Portfolio wird persistent unter `/data/portfolio.json` gespeichert.

- `GET /portfolio` – Positionen, Marktwert und Gewinn/Verlust
- `POST /portfolio` – gesamtes Portfolio als JSON-Array ersetzen
- `POST /portfolio/holding` – Position hinzufügen/ersetzen
- `DELETE /portfolio/holding/<TICKER>` – Position löschen
- `GET /recommendations` – Positionen nach Signal-Confidence sortiert

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
