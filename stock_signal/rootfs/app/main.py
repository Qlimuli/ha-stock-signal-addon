#!/usr/bin/env python3
"""
Stock & ETF Signal Server for Home Assistant
- Free data via yfinance (no API key)
- Technical analysis: RSI, MACD, Bollinger, SMA/EMA, volume
- Long / Short signals + ETF dip-buy opportunities
- MQTT sensors + REST API + Web GUI
"""

import os
import time
import json
import logging
import threading
import re
from pathlib import Path
from datetime import datetime, timezone
from typing import Dict, List, Any, Optional

import yfinance as yf
import pandas as pd
import numpy as np
from ta.momentum import RSIIndicator
from ta.trend import MACD, SMAIndicator, EMAIndicator
from ta.volatility import BollingerBands
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


def compute_indicators(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    df = df.dropna(subset=["Close"])
    close = pd.to_numeric(df["Close"], errors="coerce")
    volume = pd.to_numeric(df["Volume"], errors="coerce").fillna(0)
    df["RSI"] = RSIIndicator(close=close, window=14).rsi()
    macd = MACD(close=close)
    df["MACD"] = macd.macd()
    df["MACD_Signal"] = macd.macd_signal()
    df["MACD_Hist"] = macd.macd_diff()
    bb = BollingerBands(close=close, window=20, window_dev=2)
    df["BB_High"] = bb.bollinger_hband()
    df["BB_Low"] = bb.bollinger_lband()
    df["BB_Mid"] = bb.bollinger_mavg()
    df["BB_Pct"] = bb.bollinger_pband()
    df["SMA_20"] = SMAIndicator(close=close, window=20).sma_indicator()
    df["SMA_50"] = SMAIndicator(close=close, window=50).sma_indicator()
    df["SMA_200"] = SMAIndicator(close=close, window=200).sma_indicator()
    df["EMA_12"] = EMAIndicator(close=close, window=12).ema_indicator()
    df["EMA_26"] = EMAIndicator(close=close, window=26).ema_indicator()
    df["OBV"] = OnBalanceVolumeIndicator(close=close, volume=volume).on_balance_volume()
    df["Volume_Avg20"] = volume.rolling(20, min_periods=5).mean()
    return df


def generate_signal(ticker: str, df: pd.DataFrame, is_etf: bool = False) -> Dict[str, Any]:
    if df is None or len(df) < 50:
        return {"ticker": ticker, "signal": "neutral", "strength": 0, "confidence": 0, "data_sufficient": False, "reasons": ["Zu wenige Kursdaten (mindestens 50 Handelstage erforderlich)"], "price": None, "is_etf": is_etf}
    latest = df.iloc[-1]
    price = float(latest["Close"])
    rsi = float(latest.get("RSI", 50) or 50)
    macd = float(latest.get("MACD", 0) or 0)
    macd_sig = float(latest.get("MACD_Signal", 0) or 0)
    macd_hist = float(latest.get("MACD_Hist", 0) or 0)
    bb_pct = float(latest.get("BB_Pct", 0.5) or 0.5)
    sma20 = float(latest.get("SMA_20", price) or price)
    sma50 = float(latest.get("SMA_50", price) or price)
    sma200 = float(latest.get("SMA_200", price) or price) if not pd.isna(latest.get("SMA_200")) else None
    if any(pd.isna(v) for v in [price, rsi, macd, macd_sig, macd_hist, bb_pct, sma20, sma50]):
        return {"ticker": ticker, "signal": "neutral", "strength": 0, "confidence": 0, "data_sufficient": False, "reasons": ["Indikatoren noch nicht vollständig verfügbar"], "price": price, "is_etf": is_etf}
    reasons: List[str] = []
    long_score = 0
    short_score = 0
    if rsi <= RSI_OVERSOLD:
        long_score += 25
        reasons.append(f"RSI oversold ({rsi:.1f})")
    elif rsi >= RSI_OVERBOUGHT:
        short_score += 25
        reasons.append(f"RSI overbought ({rsi:.1f})")
    elif rsi < 40:
        long_score += 10
        reasons.append(f"RSI low ({rsi:.1f})")
    elif rsi > 60:
        short_score += 10
        reasons.append(f"RSI elevated ({rsi:.1f})")
    if macd > macd_sig and macd_hist > 0:
        long_score += 20
        reasons.append("MACD bullish crossover / positive histogram")
    elif macd < macd_sig and macd_hist < 0:
        short_score += 20
        reasons.append("MACD bearish crossover / negative histogram")
    if len(df) > 2:
        prev_hist = float(df.iloc[-2].get("MACD_Hist", 0) or 0)
        if macd_hist > prev_hist and macd_hist > 0:
            long_score += 8
        elif macd_hist < prev_hist and macd_hist < 0:
            short_score += 8
    if bb_pct <= 0.05:
        long_score += 20
        reasons.append(f"Price near lower Bollinger ({bb_pct*100:.0f}%)")
    elif bb_pct >= 0.95:
        short_score += 20
        reasons.append(f"Price near upper Bollinger ({bb_pct*100:.0f}%)")
    elif bb_pct < 0.25:
        long_score += 8
    elif bb_pct > 0.75:
        short_score += 8
    if price > sma20 > sma50:
        long_score += 15
        reasons.append("Price > SMA20 > SMA50 (uptrend)")
    elif price < sma20 < sma50:
        short_score += 15
        reasons.append("Price < SMA20 < SMA50 (downtrend)")
    if sma200 is not None:
        if price > sma200:
            long_score += 10
            reasons.append("Above 200-SMA (long-term bullish)")
        else:
            short_score += 10
            reasons.append("Below 200-SMA (long-term bearish)")
    if "Volume" in df.columns and len(df) > 20:
        avg_vol = df["Volume"].tail(20).mean()
        if latest["Volume"] > avg_vol * 1.5:
            if long_score > short_score:
                long_score += 7
                reasons.append("High volume confirmation")
            elif short_score > long_score:
                short_score += 7
                reasons.append("High volume confirmation")
    if is_etf:
        if rsi < 40 or bb_pct < 0.3 or (sma200 and price < sma200 * 0.98):
            long_score += 15
            reasons.append("ETF dip opportunity (DCA-friendly)")
        short_score = int(short_score * 0.6)
    net = long_score - short_score
    if net >= 28:
        signal = "long"
        strength = min(100, 50 + net)
    elif net <= -28:
        signal = "short"
        strength = min(100, 50 + abs(net))
    else:
        signal = "neutral"
        strength = max(0, 50 - abs(net))
    reasons = list(dict.fromkeys(reasons))[:6]
    return {
        "ticker": ticker, "signal": signal, "strength": int(min(100, abs(net))),
        "confidence": int(min(95, 35 + abs(net) * 0.55)) if signal != "neutral" else int(max(0, 35 - abs(net) * 0.5)),
        "confidence_type": "heuristic_score_not_probability", "data_sufficient": True,
        "long_score": long_score, "short_score": short_score, "reasons": reasons,
        "price": round(price, 4), "rsi": round(rsi, 1), "macd_hist": round(macd_hist, 4),
        "bb_pct": round(bb_pct, 3), "sma20": round(sma20, 4), "sma50": round(sma50, 4),
        "sma200": round(sma200, 4) if sma200 else None, "is_etf": is_etf,
        "updated": datetime.now(timezone.utc).isoformat(),
    }


def fetch_and_analyze(ticker: str, is_etf: bool = False) -> Optional[Dict[str, Any]]:
    try:
        t = yf.Ticker(ticker)
        period = "2y" if LOOKBACK_DAYS > 180 else "1y"
        df = t.history(period=period, interval="1d", auto_adjust=True)
        if df.empty or len(df) < 30:
            log.warning(f"No/insufficient data for {ticker}")
            return None
        df = compute_indicators(df)
        return generate_signal(ticker, df, is_etf=is_etf)
    except Exception as e:
        log.error(f"Error analyzing {ticker}: {e}")
        return None


def run_analysis_cycle():
    global latest_signals, latest_etf_opportunities, last_update, cycle_status
    if not cycle_lock.acquire(blocking=False):
        log.info("Analysis cycle skipped: another cycle is running")
        return False
    with state_lock:
        cycle_status = "running"
    try:
        results, etf_opps = {}, []
        for ticker in list(dict.fromkeys(TICKERS + ETF_TICKERS)):
            sig = fetch_and_analyze(ticker, is_etf=ticker in ETF_TICKERS)
            if sig is not None:
                results[ticker] = sig
                if ticker in ETF_TICKERS and sig["signal"] == "long" and sig.get("confidence", 0) >= 60:
                    etf_opps.append({"ticker": ticker, "strength": sig["strength"], "confidence": sig["confidence"],
                                     "price": sig["price"], "rsi": sig.get("rsi"), "reasons": sig["reasons"],
                                     "recommendation": "DCA-Kandidat – vor Kauf selbst prüfen"})
            time.sleep(0.4)
        with state_lock:
            latest_signals.update(results)
            latest_etf_opportunities = sorted(etf_opps, key=lambda x: (-x["confidence"], -x["strength"]))
            last_update = datetime.now(timezone.utc).isoformat()
            cycle_status = "idle"
        if MQTT_ENABLED and mqtt_client:
            publish_mqtt()
        log.info("Analysis complete: %d refreshed, %d ETF candidates", len(results), len(etf_opps))
        return True
    except Exception:
        with state_lock:
            cycle_status = "error"
        log.exception("Analysis cycle failed")
        return False
    finally:
        cycle_lock.release()


def publish_mqtt():
    if not mqtt_client:
        return
    try:
        payload = {
            "last_update": last_update, "ticker_count": len(latest_signals),
            "etf_opportunities": len(latest_etf_opportunities),
            "long_count": sum(1 for s in latest_signals.values() if s["signal"] == "long"),
            "short_count": sum(1 for s in latest_signals.values() if s["signal"] == "short"),
        }
        mqtt_client.publish(f"{MQTT_PREFIX}/summary", json.dumps(payload), retain=True)
        for ticker, sig in latest_signals.items():
            topic = f"{MQTT_PREFIX}/{ticker.replace('.', '_')}"
            mqtt_client.publish(topic, json.dumps(sig), retain=True)
            mqtt_client.publish(f"{topic}/signal", sig["signal"], retain=True)
            mqtt_client.publish(f"{topic}/strength", str(sig["strength"]), retain=True)
            mqtt_client.publish(f"{topic}/confidence", str(sig.get("confidence", 0)), retain=True)
        mqtt_client.publish(f"{MQTT_PREFIX}/etf_opportunities", json.dumps(latest_etf_opportunities), retain=True)
        log.info("MQTT publish complete")
    except Exception as e:
        log.error(f"MQTT publish failed: {e}")


def mqtt_connect():
    global mqtt_client
    if not MQTT_ENABLED:
        return
    try:
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="ha_stock_signal")
        if MQTT_USER:
            client.username_pw_set(MQTT_USER, MQTT_PASSWORD)
        client.reconnect_delay_set(min_delay=2, max_delay=60)
        client.connect_async(MQTT_HOST, MQTT_PORT, 60)
        client.loop_start()
        mqtt_client = client
        log.info(f"MQTT connected to {MQTT_HOST}:{MQTT_PORT}")
    except Exception as e:
        log.error(f"MQTT connect failed: {e}")
        mqtt_client = None


@app.route("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.route("/health")
def health():
    with state_lock:
        return jsonify({"status": "ok", "last_update": last_update, "cycle_status": cycle_status, "signal_count": len(latest_signals), "mqtt_enabled": MQTT_ENABLED})


@app.route("/refresh", methods=["POST"])
def refresh():
    if cycle_lock.locked():
        return jsonify({"status": "running", "message": "Analyse läuft bereits"}), 202
    threading.Thread(target=run_analysis_cycle, name="manual-analysis", daemon=True).start()
    return jsonify({"status": "started", "message": "Analyse gestartet"}), 202


@app.route("/signals")
def get_signals():
    with state_lock:
        return jsonify({"last_update": last_update, "cycle_status": cycle_status, "signals": latest_signals, "etf_opportunities": latest_etf_opportunities})


@app.route("/signal/<ticker>")
def get_signal(ticker: str):
    t = ticker.upper()
    if not re.fullmatch(r"[A-Z0-9^._=-]{1,24}", t):
        return jsonify({"error": "Invalid ticker"}), 400
    if t in latest_signals:
        return jsonify(latest_signals[t])
    is_etf = t in ETF_TICKERS
    sig = fetch_and_analyze(t, is_etf=is_etf)
    if sig:
        return jsonify(sig)
    return jsonify({"error": "No data"}), 404


@app.route("/etf_opportunities")
def get_etf_opps():
    return jsonify({"last_update": last_update, "opportunities": latest_etf_opportunities})


@app.route("/analyze", methods=["POST"])
def analyze_on_demand():
    data = request.get_json(silent=True) or {}
    ticker = (data.get("ticker") or request.args.get("ticker") or "").strip().upper()
    if not re.fullmatch(r"[A-Z0-9^._=-]{1,24}", ticker):
        return jsonify({"error": "ticker required"}), 400
    is_etf = data.get("is_etf", False) or ticker in ETF_TICKERS
    sig = fetch_and_analyze(ticker, is_etf=is_etf)
    if sig:
        return jsonify(sig)
    return jsonify({"error": "analysis failed"}), 500



def _portfolio_read():
    try:
        value = json.loads(PORTFOLIO_FILE.read_text(encoding="utf-8")) if PORTFOLIO_FILE.exists() else []
        return value if isinstance(value, list) else []
    except (OSError, ValueError):
        log.exception("Portfolio read failed")
        return []


def _portfolio_write(items):
    tmp = PORTFOLIO_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(PORTFOLIO_FILE)


def _portfolio_snapshot():
    holdings = _portfolio_read()
    rows, total_value, total_cost, valued_cost = [], 0.0, 0.0, 0.0
    with state_lock:
        signals = dict(latest_signals)
    for item in holdings:
        sig = signals.get(item["ticker"], {})
        qty, cost, price = float(item["quantity"]), float(item["avg_cost"]), sig.get("price")
        value = float(price) * qty if price is not None else None
        invested = qty * cost
        pnl = value - invested if value is not None else None
        total_cost += invested
        if value is not None:
            total_value += value
            valued_cost += invested
        rows.append({**item, "price": price, "market_value": round(value, 2) if value is not None else None,
                     "invested": round(invested, 2), "pnl": round(pnl, 2) if pnl is not None else None,
                     "pnl_percent": round(pnl / invested * 100, 2) if pnl is not None and invested else None,
                     "signal": sig.get("signal", "unknown"), "confidence": sig.get("confidence", 0)})
    return {"holdings": rows, "market_value": round(total_value, 2), "invested": round(total_cost, 2),
            "pnl": round(total_value - valued_cost, 2), "last_update": last_update}


@app.route("/portfolio", methods=["GET", "POST"])
def portfolio():
    if request.method == "GET":
        return jsonify(_portfolio_snapshot())
    data = request.get_json(silent=True)
    if not isinstance(data, list):
        return jsonify({"error": "JSON array expected"}), 400
    try:
        clean = []
        for item in data:
            ticker = str(item.get("ticker", "")).strip().upper()
            qty, cost = float(item.get("quantity")), float(item.get("avg_cost"))
            if not re.fullmatch(r"[A-Z0-9^._=-]{1,24}", ticker) or not np.isfinite(qty) or not np.isfinite(cost) or qty <= 0 or cost < 0:
                raise ValueError("Invalid ticker, quantity or average cost")
            clean.append({"ticker": ticker, "name": str(item.get("name") or ticker)[:80],
                          "quantity": qty, "avg_cost": cost, "is_etf": bool(item.get("is_etf"))})
        with state_lock:
            _portfolio_write(clean)
        return jsonify(_portfolio_snapshot())
    except (ValueError, TypeError, AttributeError) as exc:
        return jsonify({"error": str(exc)}), 400


@app.route("/portfolio/holding", methods=["POST"])
def add_holding():
    data = request.get_json(silent=True) or {}
    try:
        ticker = str(data.get("ticker", "")).strip().upper()
        qty, cost = float(data.get("quantity")), float(data.get("avg_cost"))
        if not re.fullmatch(r"[A-Z0-9^._=-]{1,24}", ticker) or not np.isfinite(qty) or not np.isfinite(cost) or qty <= 0 or cost < 0:
            raise ValueError("Invalid ticker, quantity or average cost")
        holding = {"ticker": ticker, "name": str(data.get("name") or ticker)[:80],
                   "quantity": qty, "avg_cost": cost, "is_etf": bool(data.get("is_etf"))}
        with state_lock:
            items = [x for x in _portfolio_read() if x.get("ticker") != ticker]
            items.append(holding)
            _portfolio_write(items)
        return jsonify(_portfolio_snapshot()), 201
    except (ValueError, TypeError) as exc:
        return jsonify({"error": str(exc)}), 400


@app.route("/portfolio/holding/<ticker>", methods=["DELETE"])
def delete_holding(ticker):
    ticker = ticker.strip().upper()
    if not re.fullmatch(r"[A-Z0-9^._=-]{1,24}", ticker):
        return jsonify({"error": "Invalid ticker"}), 400
    with state_lock:
        _portfolio_write([x for x in _portfolio_read() if x.get("ticker") != ticker])
    return jsonify(_portfolio_snapshot())


@app.route("/recommendations")
def recommendations():
    snapshot = _portfolio_snapshot()
    rows = sorted(snapshot["holdings"], key=lambda x: (-x.get("confidence", 0), x.get("pnl_percent") or 0))
    return jsonify({"recommendations": rows, "last_update": last_update})


def scheduler_loop():
    time.sleep(5)
    while True:
        try:
            run_analysis_cycle()
        except Exception as e:
            log.exception(f"Analysis cycle error: {e}")
        time.sleep(UPDATE_MINUTES * 60)


if __name__ == "__main__":
    log.info("Stock & ETF Signal Server starting")
    log.info(f"Tickers: {TICKERS}")
    log.info(f"ETFs: {ETF_TICKERS}")
    log.info(f"Interval: {UPDATE_MINUTES} min | RSI {RSI_OVERSOLD}/{RSI_OVERBOUGHT}")
    mqtt_connect()
    t = threading.Thread(target=scheduler_loop, daemon=True)
    t.start()
    app.run(host="0.0.0.0", port=8099, threaded=True)
