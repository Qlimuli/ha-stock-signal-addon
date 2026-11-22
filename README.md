# Home Assistant Add-on: Stock & ETF Signal Server

Ein Home-Assistant-Add-on für technische Aktien- und ETF-Analyse mit REST-API, MQTT und Web-Dashboard. Marktdaten werden über Yahoo Finance bezogen; ein eigener API-Key ist nicht erforderlich.

## Funktionen

| Bereich | Funktion |
|---|---|
| Signale | Long / Short / Neutral mit Stärke und heuristischem Confidence-Wert |
| Indikatoren | RSI, MACD, Bollinger-Bänder, SMA 20/50/200, EMA 12/26 und Volumen |
| ETFs | ETF-Kandidaten für weitere Prüfung / DCA-Beobachtung |
| Portfolio | Positionen speichern, Marktwert und P&L berechnen, Empfehlungen anzeigen |
| Dashboard | Dashboard, Signale, Portfolio und On-Demand-Analyse |
| Integration | MQTT-Sensorwerte und REST-Endpunkte |

**Confidence ist keine Eintrittswahrscheinlichkeit.** Die Signale beruhen auf technischen Regeln und sind weder Prognose noch Finanzberatung. Standardmäßig werden Aktien und ETFs analysiert.

## Installation

1. Home Assistant → **Einstellungen → Add-ons → Add-on Store**
2. Repositories → `https://github.com/Qlimuli/ha-stock-signal-addon`
3. **Stock & ETF Signal Server** installieren und starten.

Nach dem Update auf Version 1.4.0 Add-on neu starten. Ticker, Intervall und MQTT können über die Add-on-Optionen angepasst werden.

## Portfolio

Positionen können im Portfolio-Tab manuell angelegt, als JSON importiert oder exportiert werden. Gespeichert wird dauerhaft in `/data/portfolio.json`.

## REST API

Port **8099** (über Home-Assistant-Ingress oder direkt, sofern Port freigegeben):

- `GET /health`
- `GET /signals`
- `GET /signal/<TICKER>`
- `POST /analyze`
- `POST /refresh`
- `GET|POST /portfolio`
- `POST /portfolio/holding`
- `DELETE /portfolio/holding/<TICKER>`
- `GET /recommendations`
- `GET /etf_opportunities`

Weitere Details stehen in [stock_signal/DOCS.md](stock_signal/DOCS.md).

## MQTT

Topics beginnen standardmäßig mit `stock_signal/`. Das Add-on veröffentlicht eine Zusammenfassung, je Ticker JSON sowie Signal, Stärke und Confidence.

## Disclaimer

Keine Finanzberatung. Technische Signale können falsch sein; Marktdaten können verzögert oder unvollständig sein. Es werden keine automatischen Kauf- oder Verkaufsaufträge ausgeführt.

## Lizenz

MIT
