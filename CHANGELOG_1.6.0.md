# v1.6.0 – Überblick

## Neu
- **Warum bewegt sich der Markt?** Tagesveränderung wichtiger Welt-Indizes (S&P 500, Nasdaq, Dow, DAX, Euro Stoxx, FTSE, Nikkei, Shanghai, Hang Seng) + Stimmungstext (Risk-On / Risk-Off / Gemischt / Ruhig).
- **Headlines** zu den Bewegungen (Yahoo Finance News, aggregiert).
- **Nur sehr klare Signale** für Kauf-/Verkaufs-Empfehlungen: Confidence ≥ 75, Stärke ≥ 70, Netto-Score ≥ 40, ADX ≥ 20.
- **Technisches Bias-Label** (bullish / bearish / sideways) – ausdrücklich keine Prognose-Garantie und keine Finanzberatung.
- **app.js** war nur ein Placeholder – vollständig wiederhergestellt und an die neue API angebunden.

## API
- `GET /signals` liefert zusätzlich `clear_opportunities`, `market`, `news`
- `GET /market`, `GET /clear_opportunities`
- MQTT: `…/clear_opportunities`, `…/market`

## Nach dem Update
Add-on neu bauen/starten. Die GUI zeigt oben den Weltmarkt und die Headlines; darunter nur noch wirklich klare Chancen.
