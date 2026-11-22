# Stock & ETF Signal Server – Dokumentation (v1.2)

## Scoring (vereinfacht)

**Long:** RSI oversold, MACD bullisch, untere Bollinger, Uptrend (SMA), Stochastic oversold-Kreuzung, ADX+DI+, Volumen, ETF-Dip-Bonus  
**Short:** Spiegelbild; bei ETFs abgeschwächt  

Signal wenn |Long−Short| ≥ 28. Confidence steigt mit Anzahl bestätigender Faktoren und ADX.

## Portfolio & Nachkauf

`/data/portfolio.json` speichert Holdings.  
`GET /recommendations` sortiert nach Priorität (Signal + Stärke + Confidence + Distanz zum Einstand).

## MQTT

- `stock_signal/summary`
- `stock_signal/<TICKER>` (JSON), `/signal`, `/strength`, `/confidence`
- `stock_signal/etf_opportunities`
