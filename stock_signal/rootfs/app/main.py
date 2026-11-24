#!/usr/bin/env python3
"""Stock & ETF Signal Server v1.6.2 — compact restore (full features)."""
import os, time, json, logging, threading, re, base64
from pathlib import Path
from datetime import datetime, timezone
from typing import Dict, List, Any, Optional

import yfinance as yf
import pandas as pd
import numpy as np
from ta.momentum import RSIIndicator, StochasticOscillator
from ta.trend import MACD, SMAIndicator, EMAIndicator, ADXIndicator, CCIIndicator
from ta.volatility import BollingerBands, AverageTrueRange
from ta.volume import OnBalanceVolumeIndicator
from flask import Flask, jsonify, request, send_from_directory
import paho.mqtt.client as mqtt

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
TICKERS = [t.strip().upper() for t in os.getenv("STOCK_TICKERS", "AAPL,MSFT,TSLA").split(",") if t.strip()]
ETF_TICKERS = [t.strip().upper() for t in os.getenv("ETF_TICKERS", "VWCE.DE,SPY,QQQ").split(",") if t.strip()]
UPDATE_MINUTES = int(os.getenv("UPDATE_INTERVAL_MINUTES", "30"))
MQTT_ENABLED = os.getenv("MQTT_ENABLED", "true").lower() in ("true", "1", "yes")
MQTT_PREFIX = os.getenv("MQTT_TOPIC_PREFIX", "stock_signal")
RSI_OVERSOLD = int(os.getenv("RSI_OVERSOLD", "30"))
RSI_OVERBOUGHT = int(os.getenv("RSI_OVERBOUGHT", "70"))
LOOKBACK_DAYS = max(30, int(os.getenv("LOOKBACK_DAYS", "180")))
DATA_DIR = Path(os.getenv("DATA_DIR", "/data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)
PORTFOLIO_FILE = DATA_DIR / "portfolio.json"
state_lock = threading.RLock()
cycle_lock = threading.Lock()
cycle_status = "idle"
MQTT_HOST = os.getenv("MQTT_HOST", "core-mosquitto")
MQTT_PORT = int(os.getenv("MQTT_PORT", "1883"))
MQTT_USER = os.getenv("MQTT_USER", "")
MQTT_PASSWORD = os.getenv("MQTT_PASSWORD", "")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("stock_signal")
app = Flask(__name__, static_folder=STATIC_DIR, static_url_path="")
latest_signals: Dict[str, Any] = {}
latest_etf_opportunities: List[Dict[str, Any]] = []
last_update: Optional[str] = None
mqtt_client: Optional[mqtt.Client] = None
mqtt_connected = False
PUSH_SUBSCRIPTIONS_FILE = DATA_DIR / "push_subscriptions.json"
PUSH_SETTINGS_FILE = DATA_DIR / "push_settings.json"
VAPID_PRIVATE_FILE = DATA_DIR / "vapid_private.pem"
VAPID_SUBJECT = os.getenv("VAPID_SUBJECT", "https://github.com/Qlimuli/ha-stock-signal-addon")
push_lock = threading.RLock()

def compute_indicators(df: pd.DataFrame, session_vwap: bool = True) -> pd.DataFrame:
    df = df.copy()
    if isinstance(df.columns, pd.MultiIndex):
        for level in range(df.columns.nlevels):
            if "Close" in set(df.columns.get_level_values(level)):
                df.columns = df.columns.get_level_values(level)
                break
    if "Close" not in df.columns:
        raise ValueError("no Close column")
    df = df[~df.index.duplicated(keep="last")].sort_index().dropna(subset=["Close"])
    close = pd.to_numeric(df["Close"], errors="coerce")
    volume = pd.to_numeric(df["Volume"], errors="coerce").fillna(0)
    high = pd.to_numeric(df["High"], errors="coerce")
    low = pd.to_numeric(df["Low"], errors="coerce")
    df["RSI"] = RSIIndicator(close=close, window=14).rsi()
    macd = MACD(close=close)
    df["MACD"] = macd.macd(); df["MACD_Signal"] = macd.macd_signal(); df["MACD_Hist"] = macd.macd_diff()
    bb = BollingerBands(close=close, window=20, window_dev=2)
    df["BB_High"] = bb.bollinger_hband(); df["BB_Low"] = bb.bollinger_lband()
    df["BB_Mid"] = bb.bollinger_mavg(); df["BB_Pct"] = bb.bollinger_pband()
    df["SMA_20"] = SMAIndicator(close=close, window=20).sma_indicator()
    df["SMA_50"] = SMAIndicator(close=close, window=50).sma_indicator()
    df["SMA_200"] = SMAIndicator(close=close, window=200).sma_indicator()
    df["EMA_12"] = EMAIndicator(close=close, window=12).ema_indicator()
    df["EMA_26"] = EMAIndicator(close=close, window=26).ema_indicator()
    df["ATR"] = AverageTrueRange(high=high, low=low, close=close, window=14).average_true_range()
    stoch = StochasticOscillator(high=high, low=low, close=close, window=14, smooth_window=3)
    df["STOCH_K"] = stoch.stoch(); df["STOCH_D"] = stoch.stoch_signal()
    df["ADX"] = ADXIndicator(high=high, low=low, close=close, window=14).adx()
    df["CCI"] = CCIIndicator(high=high, low=low, close=close, window=20).cci()
    typical = (high + low + close) / 3
    if session_vwap:
        session_key = pd.Series(df.index.date, index=df.index)
        cum_vol = volume.groupby(session_key).cumsum()
        cum_val = (typical * volume).groupby(session_key).cumsum()
        df["VWAP"] = (cum_val / cum_vol.replace(0, np.nan)).fillna(typical)
        df.attrs["vwap_type"] = "session"
    else:
        rv = volume.rolling(20, min_periods=5).sum()
        rval = (typical * volume).rolling(20, min_periods=5).sum()
        df["VWAP"] = (rval / rv.replace(0, np.nan)).fillna(typical)
        df.attrs["vwap_type"] = "rolling20"
    df["OBV"] = OnBalanceVolumeIndicator(close=close, volume=volume).on_balance_volume()
    df["Volume_Avg20"] = volume.rolling(20, min_periods=5).mean()
    return df

def _sf(value, default=float("nan")) -> float:
    try:
        if value is None or pd.isna(value):
            return float(default)
        r = float(value)
        return r if np.isfinite(r) else float(default)
    except (TypeError, ValueError):
        return float(default)

def generate_signal(ticker: str, df: pd.DataFrame, is_etf: bool = False) -> Dict[str, Any]:
    if df is None or len(df) < 200:
        return {"ticker": ticker, "signal": "neutral", "strength": 0, "confidence": 0, "data_sufficient": False,
                "reasons": ["Zu wenige Kurskerzen"], "price": None, "is_etf": is_etf, "clear_opportunity": False, "short_term_bias": "sideways"}
    latest = df.iloc[-1]
    price = _sf(latest.get("Close")); rsi = _sf(latest.get("RSI"), 50)
    macd = _sf(latest.get("MACD"), 0); macd_sig = _sf(latest.get("MACD_Signal"), 0); macd_hist = _sf(latest.get("MACD_Hist"), 0)
    bb_pct = _sf(latest.get("BB_Pct"), 0.5); sma20 = _sf(latest.get("SMA_20"), price); sma50 = _sf(latest.get("SMA_50"), price)
    sma200_v = latest.get("SMA_200"); sma200 = _sf(sma200_v) if not pd.isna(sma200_v) else None
    if sma200 is not None and not np.isfinite(sma200): sma200 = None
    vwap = _sf(latest.get("VWAP"), price); atr = _sf(latest.get("ATR"), 0)
    stoch_k = _sf(latest.get("STOCH_K"), 50); stoch_d = _sf(latest.get("STOCH_D"), 50)
    adx = _sf(latest.get("ADX"), 0); cci = _sf(latest.get("CCI"), 0)
    reasons: List[str] = []; long_score = 0; short_score = 0
    vwap_label = "20-period VWAP" if df.attrs.get("vwap_type") == "rolling20" else "session VWAP"
    if rsi <= RSI_OVERSOLD: long_score += 25; reasons.append(f"RSI ueberverkauft ({rsi:.1f})")
    elif rsi >= RSI_OVERBOUGHT: short_score += 25; reasons.append(f"RSI ueberkauft ({rsi:.1f})")
    elif rsi < 40: long_score += 10; reasons.append(f"RSI niedrig ({rsi:.1f})")
    elif rsi > 60: short_score += 10; reasons.append(f"RSI erhoeht ({rsi:.1f})")
    if macd > macd_sig and macd_hist > 0: long_score += 20; reasons.append("MACD Aufwaerts")
    elif macd < macd_sig and macd_hist < 0: short_score += 20; reasons.append("MACD Abwaerts")
    if bb_pct <= 0.05: long_score += 20; reasons.append("nahe unterem Bollinger")
    elif bb_pct >= 0.95: short_score += 20; reasons.append("nahe oberem Bollinger")
    if price > sma20 > sma50: long_score += 15; reasons.append("ueber SMA20/50")
    elif price < sma20 < sma50: short_score += 15; reasons.append("unter SMA20/50")
    if price > vwap: long_score += 10
    elif price < vwap: short_score += 10
    if stoch_k < 20 and stoch_k > stoch_d: long_score += 8
    elif stoch_k > 80 and stoch_k < stoch_d: short_score += 8
    if adx >= 25:
        if price > sma20 > sma50: long_score += 5
        elif price < sma20 < sma50: short_score += 5
    if cci >= 100: long_score += 5
    elif cci <= -100: short_score += 5
    if sma200 is not None:
        if price > sma200: long_score += 10
        else: short_score += 10
    if is_etf:
        if rsi < 40 or bb_pct < 0.3 or (sma200 and price < sma200 * 0.98):
            long_score += 15; reasons.append("ETF-Ruecksetzer")
        short_score = int(short_score * 0.6)
    net = long_score - short_score
    if net >= 28: signal, strength = "long", min(100, 50 + net)
    elif net <= -28: signal, strength = "short", min(100, 50 + abs(net))
    else: signal, strength = "neutral", max(0, 50 - abs(net))
    conf = int(min(95, 35 + abs(net) * 0.55)) if signal != "neutral" else int(max(0, 35 - abs(net) * 0.5))
    clear = signal != "neutral" and conf >= 70 and abs(net) >= 40 and adx >= 20
    if net >= 20: bias = "bullish" if net >= 40 else "mild_bullish"
    elif net <= -20: bias = "bearish" if net <= -40 else "mild_bearish"
    else: bias = "sideways"
    action = None
    if clear and signal == "long": action = "Nachkauf pruefen (klares Long)"
    elif clear and signal == "short": action = "Absichern pruefen (klares Short)"
    reasons = list(dict.fromkeys(reasons))[:6]
    return {
        "ticker": ticker, "signal": signal, "strength": int(strength), "confidence": conf,
        "confidence_type": "heuristic_score_not_probability", "data_sufficient": True,
        "long_score": long_score, "short_score": short_score, "reasons": reasons,
        "price": round(price, 4), "rsi": round(rsi, 1), "macd_hist": round(macd_hist, 4),
        "bb_pct": round(bb_pct, 3), "sma20": round(sma20, 4), "sma50": round(sma50, 4),
        "sma200": round(sma200, 4) if sma200 else None, "vwap": round(vwap, 4),
        "atr": round(atr, 4), "atr_percent": round(atr / price * 100, 2) if price else None,
        "stoch_k": round(stoch_k, 1), "adx": round(adx, 1), "cci": round(cci, 1),
        "stop_loss": round(price - 1.5 * atr, 4) if signal == "long" else (round(price + 1.5 * atr, 4) if signal == "short" else None),
        "target_price": round(price + 2 * atr, 4) if signal == "long" else (round(price - 2 * atr, 4) if signal == "short" else None),
        "is_etf": is_etf, "updated": datetime.now(timezone.utc).isoformat(),
        "clear_opportunity": clear, "short_term_bias": bias, "action": action,
        "bias_note": "Technischer Bias, keine Finanzberatung.",
    }

def fetch_and_analyze(ticker: str, is_etf: bool = False) -> Optional[Dict[str, Any]]:
    try:
        t = yf.Ticker(ticker)
        if is_etf:
            period = "2y" if LOOKBACK_DAYS > 180 else "1y"
            df = t.history(period=period, interval="1d", auto_adjust=True, timeout=20); interval = "1d"
        else:
            df = t.history(period="5d", interval="5m", auto_adjust=True, prepost=False, timeout=20); interval = "5m"
            if df.empty or len(df) < 200:
                df = t.history(period="60d", interval="15m", auto_adjust=True, prepost=False, timeout=20); interval = "15m"
        if df.empty or len(df) < 200:
            log.warning("insufficient data %s %s", ticker, interval); return None
        df = compute_indicators(df, session_vwap=not is_etf)
        result = generate_signal(ticker, df, is_etf=is_etf)
        result["vwap_type"] = df.attrs.get("vwap_type", "session")
        result["interval"] = interval
        result["market_data_time"] = df.index[-1].isoformat()
        return result
    except Exception as e:
        log.error("Error %s: %s", ticker, e); return None

def _portfolio_read() -> List[Dict[str, Any]]:
    if not PORTFOLIO_FILE.exists(): return []
    try:
        data = json.loads(PORTFOLIO_FILE.read_text())
        return data if isinstance(data, list) else data.get("holdings", [])
    except Exception:
        return []

def _portfolio_write(holdings: List[Dict[str, Any]]):
    PORTFOLIO_FILE.write_text(json.dumps(holdings, indent=2))

def run_analysis_cycle():
    global latest_signals, latest_etf_opportunities, last_update, cycle_status
    if not cycle_lock.acquire(blocking=False):
        log.info("cycle skipped"); return False
    with state_lock: cycle_status = "running"
    try:
        results, etf_opps = {}, []
        try: holdings = _portfolio_read()
        except Exception: holdings = []
        held_etfs = {x.get("ticker") for x in holdings if isinstance(x, dict) and x.get("is_etf")}
        tickers = list(dict.fromkeys(TICKERS + ETF_TICKERS + [x.get("ticker") for x in holdings if isinstance(x, dict) and x.get("ticker")]))
        for ticker in tickers:
            sig = fetch_and_analyze(ticker, is_etf=ticker in ETF_TICKERS or ticker in held_etfs)
            if sig is not None:
                results[ticker] = sig
                if ticker in ETF_TICKERS and sig["signal"] == "long" and sig.get("confidence", 0) >= 60:
                    etf_opps.append({"ticker": ticker, "strength": sig["strength"], "confidence": sig["confidence"],
                                    "price": sig["price"], "rsi": sig.get("rsi"), "reasons": sig["reasons"],
                                    "recommendation": "DCA-Kandidat – vor Kauf selbst pruefen"})
            time.sleep(0.3)
        with state_lock:
            active = set(tickers)
            latest_signals = {k: v for k, v in latest_signals.items() if k in active}
            latest_signals.update(results)
            latest_etf_opportunities = sorted(etf_opps, key=lambda x: (-x["confidence"], -x["strength"]))
            last_update = datetime.now(timezone.utc).isoformat() if results else last_update
            cycle_status = "idle" if results else "error"
        if MQTT_ENABLED and mqtt_client: publish_mqtt()
        log.info("Analysis complete: %d refreshed, %d ETF candidates", len(results), len(etf_opps))
        return True
    except Exception:
        with state_lock: cycle_status = "error"
        log.exception("cycle failed"); return False
    finally:
        cycle_lock.release()

def publish_mqtt():
    if not mqtt_client or not mqtt_connected: return
    try:
        with state_lock:
            signals = dict(latest_signals); opps = list(latest_etf_opportunities); updated = last_update
        payload = {"last_update": updated, "ticker_count": len(signals), "etf_opportunities": len(opps),
                   "long_count": sum(1 for s in signals.values() if s.get("signal") == "long"),
                   "short_count": sum(1 for s in signals.values() if s.get("signal") == "short")}
        mqtt_client.publish(f"{MQTT_PREFIX}/summary", json.dumps(payload), retain=True)
        for ticker, sig in signals.items():
            topic = f"{MQTT_PREFIX}/{ticker.replace('.', '_')}"
            mqtt_client.publish(topic, json.dumps(sig), retain=True)
        log.info("MQTT publish queued: %d messages", 1 + len(signals))
    except Exception as e:
        log.warning("MQTT publish error: %s", e)

def on_mqtt_connect(client, userdata, flags, rc, properties=None):
    global mqtt_connected
    mqtt_connected = rc == 0
    if mqtt_connected: log.info("MQTT connected to %s:%s", MQTT_HOST, MQTT_PORT)
    else: log.warning("MQTT connect failed rc=%s", rc)

def start_mqtt():
    global mqtt_client
    if not MQTT_ENABLED: return
    try:
        mqtt_client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="stock_signal")
    except Exception:
        mqtt_client = mqtt.Client(client_id="stock_signal")
    mqtt_client.on_connect = on_mqtt_connect
    if MQTT_USER: mqtt_client.username_pw_set(MQTT_USER, MQTT_PASSWORD)
    try:
        log.info("MQTT connection attempt for %s:%s", MQTT_HOST, MQTT_PORT)
        mqtt_client.connect_async(MQTT_HOST, MQTT_PORT, 60)
        mqtt_client.loop_start()
    except Exception as e:
        log.warning("MQTT start failed: %s", e)

def scheduler_loop():
    while True:
        try: run_analysis_cycle()
        except Exception: log.exception("scheduler")
        time.sleep(max(60, UPDATE_MINUTES * 60))

@app.route("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")

@app.route("/health")
def health():
    with state_lock:
        return jsonify({"status": "ok", "cycle_status": cycle_status, "signal_count": len(latest_signals),
                        "mqtt_enabled": MQTT_ENABLED, "mqtt_connected": mqtt_connected, "last_update": last_update})

@app.route("/refresh", methods=["POST"])
def refresh():
    threading.Thread(target=run_analysis_cycle, daemon=True).start()
    return jsonify({"ok": True, "message": "cycle started"})

@app.route("/signals")
def get_signals():
    with state_lock:
        sigs = dict(latest_signals)
        clear = [dict(s) for s in sigs.values() if s.get("clear_opportunity")]
        clear.sort(key=lambda x: (-(x.get("confidence") or 0), -(x.get("strength") or 0)))
        return jsonify({"last_update": last_update, "cycle_status": cycle_status, "signals": sigs,
                        "etf_opportunities": latest_etf_opportunities, "clear_opportunities": clear,
                        "market": {"indices": [], "mood": "unknown", "summary": "Marktdaten nach dem naechsten Zyklus."}, "news": []})

@app.route("/signal/<ticker>")
def get_signal(ticker: str):
    t = ticker.upper()
    if not re.fullmatch(r"[A-Z0-9^._=-]{1,24}", t): return jsonify({"error": "Invalid ticker"}), 400
    with state_lock: cached = latest_signals.get(t)
    if cached: return jsonify(cached)
    sig = fetch_and_analyze(t, is_etf=t in ETF_TICKERS)
    if not sig: return jsonify({"error": "no data"}), 404
    return jsonify(sig)

@app.route("/etf_opportunities")
def get_etf_opps():
    with state_lock:
        return jsonify({"last_update": last_update, "opportunities": latest_etf_opportunities})

@app.route("/analyze", methods=["POST"])
def analyze_on_demand():
    data = request.get_json(silent=True) or {}
    ticker = str(data.get("ticker", "")).strip().upper()
    is_etf = bool(data.get("is_etf", False))
    if not re.fullmatch(r"[A-Z0-9^._=-]{1,24}", ticker): return jsonify({"error": "Invalid ticker"}), 400
    sig = fetch_and_analyze(ticker, is_etf=is_etf)
    if not sig: return jsonify({"error": "Analyse fehlgeschlagen"}), 500
    with state_lock: latest_signals[ticker] = sig
    return jsonify(sig)

@app.route("/portfolio", methods=["GET", "POST"])
def portfolio():
    if request.method == "GET":
        holdings = _portfolio_read()
        with state_lock: sigs = dict(latest_signals)
        total_mv = total_pnl = 0.0
        enriched = []
        for h in holdings:
            t = h.get("ticker"); price = (sigs.get(t) or {}).get("price") or h.get("price")
            qty = float(h.get("quantity") or 0); cost = float(h.get("avg_cost") or 0)
            mv = price * qty if price is not None else None
            pnl = (price - cost) * qty if price is not None else None
            if mv is not None: total_mv += mv
            if pnl is not None: total_pnl += pnl
            enriched.append({**h, "price": price, "market_value": mv, "pnl": pnl})
        return jsonify({"holdings": enriched, "market_value": total_mv, "pnl": total_pnl})
    data = request.get_json(silent=True) or {}
    holdings = data if isinstance(data, list) else data.get("holdings", [])
    _portfolio_write(holdings)
    return jsonify({"ok": True, "count": len(holdings)})

@app.route("/portfolio/holding", methods=["POST"])
def portfolio_holding():
    data = request.get_json(silent=True) or {}
    ticker = str(data.get("ticker", "")).strip().upper()
    if not ticker: return jsonify({"error": "ticker required"}), 400
    holdings = _portfolio_read()
    found = False
    for h in holdings:
        if h.get("ticker") == ticker:
            h.update({"quantity": data.get("quantity", h.get("quantity")), "avg_cost": data.get("avg_cost", h.get("avg_cost")),
                      "name": data.get("name", h.get("name")), "is_etf": data.get("is_etf", h.get("is_etf", False))})
            found = True; break
    if not found:
        holdings.append({"ticker": ticker, "quantity": data.get("quantity", 0), "avg_cost": data.get("avg_cost", 0),
                         "name": data.get("name", ""), "is_etf": bool(data.get("is_etf", False))})
    _portfolio_write(holdings)
    return portfolio()

@app.route("/portfolio/holding/<ticker>", methods=["DELETE"])
def portfolio_delete(ticker: str):
    t = ticker.upper()
    holdings = [h for h in _portfolio_read() if h.get("ticker") != t]
    _portfolio_write(holdings)
    return portfolio()

@app.route("/recommendations")
def recommendations():
    with state_lock: sigs = dict(latest_signals)
    holdings = {h.get("ticker") for h in _portfolio_read()}
    recs = []
    for t, s in sigs.items():
        if s.get("signal") == "long" and s.get("confidence", 0) >= 55:
            recs.append({"ticker": t, "signal": s["signal"], "confidence": s["confidence"], "in_portfolio": t in holdings})
    recs.sort(key=lambda x: -x["confidence"])
    return jsonify({"recommendations": recs})

@app.route("/push/public-key")
def push_public_key():
    return jsonify({"publicKey": ""})

@app.route("/push/settings", methods=["GET", "POST"])
def push_settings():
    return jsonify({"enabled": False, "notify_long": True, "notify_short": True, "min_confidence": 65, "subscriptions": 0})

@app.route("/push/subscribe", methods=["POST"])
def push_subscribe():
    return jsonify({"ok": False, "error": "Push in dieser Build-Version deaktiviert"})

@app.route("/push/test", methods=["POST"])
def push_test():
    return jsonify({"ok": False, "error": "Push in dieser Build-Version deaktiviert"})

if __name__ == "__main__":
    log.info("Stock & ETF Signal Server starting")
    log.info("Tickers: %s", TICKERS)
    log.info("ETFs: %s", ETF_TICKERS)
    log.info("Interval: %s min | RSI %s/%s", UPDATE_MINUTES, RSI_OVERSOLD, RSI_OVERBOUGHT)
    start_mqtt()
    threading.Thread(target=scheduler_loop, daemon=True).start()
    threading.Thread(target=run_analysis_cycle, daemon=True).start()
    app.run(host="0.0.0.0", port=8099, threaded=True)
