# Stock & ETF Signal Server – Dokumentation

## Logik-Übersicht

### Long-Score (Bullish)
- RSI ≤ 30 → +25
- RSI < 40 → +10
- MACD bullish + positive Histogramm → +20
- Preis nahe unterer Bollinger (≤ 5 %) → +20
- Preis > SMA20 > SMA50 → +15
- Über 200-SMA → +10
- Hohes Volumen zur Bestätigung → +7
- Bei ETFs extra Dip-Bonus → +15

### Short-Score (Bearish)
- RSI ≥ 70 → +25
- RSI > 60 → +10
- MACD bearish → +20
- Preis nahe oberer Bollinger → +20
- Preis < SMA20 < SMA50 → +15
- Unter 200-SMA → +10

**Signal**:
- Netto ≥ +25 → **long**
- Netto ≤ −25 → **short**
- sonst **neutral**

ETFs bekommen eine reduzierte Short-Gewichtung und extra Nachkauf-Bonus bei Dips.

## MQTT Topics

- `stock_signal/summary` – Übersicht
- `stock_signal/<TICKER>` – vollständiges Signal-JSON
- `stock_signal/<TICKER>/signal` – long | short | neutral
- `stock_signal/<TICKER>/strength` – 0–100
- `stock_signal/etf_opportunities` – Liste der aktuellen ETF-Empfehlungen

## Empfohlene Automation (Beispiel)

Wenn `sensor.stock_signal_vwce_de_signal` auf `long` wechselt und Strength > 60 → Notification „Guter Zeitpunkt zum Nachkaufen VWCE“.
