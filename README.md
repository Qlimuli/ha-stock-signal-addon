# Home Assistant Addon: Stock & ETF Signal Server

**Aktien- und ETF-Signal-Server** mit seriöser technischer Analyse – **ohne API-Keys**.

- Datenquelle: Yahoo Finance (`yfinance`)
- Indikatoren: RSI, MACD, Bollinger Bands, SMA/EMA, Volumen
- Signale: **Long / Short / Neutral** mit Stärke und Begründungen
- Speziell für ETFs: Erkennung guter Nachkauf-Zeitpunkte (DCA / Buy-the-Dip)
- MQTT-Sensoren + REST-API
- Portfolio-Abfrage: **Scalable Capital offizieller MCP** (separat verbinden)

## Features

| Feature | Beschreibung |
|---------|--------------|
| Long-Signale | Oversold RSI, bullisches MACD, untere Bollinger, Uptrend |
| Short-Signale | Overbought, bearisches MACD, obere Bollinger, Downtrend |
| ETF-Nachkauf | Zusätzliche Gewichtung auf Dips für breite ETFs |
| MQTT | Sensoren unter `stock_signal/<TICKER>` |
| REST | `/signals`, `/signal/<TICKER>`, `/etf_opportunities`, `/analyze` |

## Installation

1. In Home Assistant → **Einstellungen → Add-ons → Add-on Store**
2. Drei Punkte → **Repositories** → URL hinzufügen:
   ```
   https://github.com/Qlimuli/ha-stock-signal-addon
   ```
3. Addon **Stock & ETF Signal Server** installieren und starten.

Oder per MCP (ha_manage_app):

```
action=add_repository, repository=https://github.com/Qlimuli/ha-stock-signal-addon
```

Danach installieren und starten.

## Konfiguration (Options)

- `tickers`: Komma-separierte Liste (z.B. `AAPL,MSFT,TSLA,VWCE.DE`)
- `etf_tickers`: ETFs, die speziell auf Nachkauf-Signale geprüft werden
- `update_interval_minutes`: Analyse-Intervall (Standard 30)
- `rsi_oversold` / `rsi_overbought`: Schwellen (30/70)
- MQTT wird automatisch über Supervisor erkannt, falls vorhanden.

## Scalable Capital Integration

Scalable bietet einen **offiziellen MCP-Server**:

1. In Scalable Web → Profil → Sicherheit → **Agentic Investing** aktivieren
2. MCP-URL: `https://mcp.scalable.capital/mcp`
3. In diesem Chat den Connector **Scalable Capital** verbinden

Danach kann ich (oder du) dein Depot abfragen und die Signale des Addons damit kombinieren.

## REST API (Port 8099)

- `GET /health`
- `GET /signals` – alle aktuellen Signale
- `GET /signal/AAPL` – einzelnes Signal (on-demand möglich)
- `GET /etf_opportunities` – aktuelle ETF-Nachkauf-Empfehlungen
- `POST /analyze` `{"ticker": "NVDA"}`

## Disclaimer

Dies ist **keine Finanzberatung**. Technische Analyse ist ein Tool, keine Garantie.  
Handele immer verantwortungsvoll und nach eigener Recherche.

## License

MIT
