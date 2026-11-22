# Home Assistant Addon: Stock & ETF Signal Server Pro

Professioneller **Aktien- und ETF-Signal-Server** mit Multi-Faktor-Analyse – **ohne API-Keys**.

## Features (v1.2)

| Bereich | Inhalt |
|---------|--------|
| **Signale** | Long / Short / Neutral mit Stärke + Confidence |
| **Indikatoren** | RSI, MACD, Bollinger, SMA/EMA, Stochastic, ADX, ATR%, Volumen |
| **Regime** | Uptrend / Downtrend / Range + Risiko (Volatilität) |
| **ETF-Nachkauf** | Dip-Bias, DCA-Empfehlungen |
| **Portfolio** | Holdings speichern, P&L, gewichtete Nachkauf-Prioritäten |
| **GUI** | Tabs: Dashboard, Signale, Portfolio, On-Demand-Analyse |
| **MQTT / REST** | Sensoren + API für Automationen |

## Installation

1. HA → **Einstellungen → Add-ons → Add-on Store**
2. Repositories → `https://github.com/Qlimuli/ha-stock-signal-addon`
3. **Stock & ETF Signal Server** installieren / updaten auf **1.2.0** und neu starten

## Scalable Capital

Der offizielle Scalable-MCP (`https://mcp.scalable.capital/mcp`) nutzt **OAuth im AI-Client** (Grok, Claude, …) – nicht im Add-on-Container.

**Im Add-on:**
- Tab **Portfolio** → Positionen manuell oder per JSON-Import
- Empfehlungen kombinieren Live-Signale mit deinem Depot (P&L, Dip vs. Einstand)

**Optional:**
- Scalable Web → Profil → Sicherheit → *Agentic Investing* (Read-only)
- HACS-Integration [somansch/scalable](https://github.com/somansch/scalable) für HA-Sensoren

## REST (Port 8099 / Ingress)

- `GET /signals` · `GET /signal/<T>` · `POST /analyze`
- `GET|POST /portfolio` · `POST /portfolio/holding` · `DELETE /portfolio/holding/<T>`
- `GET /recommendations` · `POST /refresh` · `GET /health`

## Disclaimer

**Keine Finanzberatung.** Technische Analyse ist ein Werkzeug, keine Garantie.

## License

MIT
