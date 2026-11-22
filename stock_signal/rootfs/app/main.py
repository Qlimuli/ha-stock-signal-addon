#!/usr/bin/env python3
"""
Stock & ETF Signal Server for Home Assistant
- Free data via yfinance (no API key)
- Technical analysis: RSI, MACD, Bollinger, SMA/EMA, volume
- Long / Short signals + ETF dip-buy opportunities
- MQTT sensors + REST API
"""

import os
import time
import json
import logging
import threading
from datetime import datetime, timezone
from typing import Dict, List, Any, Optional

import yfinance as yf
import pandas as pd
import numpy as np
from ta.momentum import RSIIndicator
from ta.trend import MACD, SMAIndicator, EMAIndicator
from ta.volatility import BollingerBands
from ta.volume import OnBalanceVolumeIndicator
from flask import Flask, jsonify, request
import paho.mqtt.client as mqtt

# ---------------------------------------------------------------------------
# Config from environment (set by run.sh / bashio)
# ---------------------------------------------------------------------------
TICKERS = [t.strip().upper() for t in os.getenv("STOCK_TICKERS", "AAPL,MSFT,TSLA").split(",") if t.strip()]
ETF_TICKERS = [t.strip().upper() for t in os.getenv("ETF_TICKERS", "VWCE.DE,SPY,QQQ").split(",") if t.strip()]
UPDATE_MINUTES = int(os.getenv("UPDATE_INTERVAL_MINUTES", "30"))
MQTT_ENABLED = os.getenv("MQTT_ENABLED", "true").lower() in ("true", "1", "yes")
MQTT_PREFIX = os.getenv("MQTT_TOPIC_PREFIX", "stock_signal")
RSI_OVERSOLD = int(os.getenv("RSI_OVERSOLD", "30"))
RSI_OVERBOUGHT = int(os.getenv("RSI_OVERBOUGHT", "70"))
LOOKBACK_DAYS = int(os.getenv("LOOKBACK_DAYS", "120"))

MQTT_HOST = os.getenv("MQTT_HOST", "core-mosquitto")
MQTT_PORT = int(os.getenv("MQTT_PORT", "1883"))
MQTT_USER = os.getenv("MQTT_USER", "")
MQTT_PASSWORD = os.getenv("MQTT_PASSWORD", "")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("stock_signal")

app = Flask(__name__)

# Global state
latest_signals: Dict[str, Any] = {}
latest_etf_opportunities: List[Dict[str, Any]] = []
last_update: Optional[str] = None
mqtt_client: Optional[mqtt.Client] = None


# ---------------------------------------------------------------------------
# Technical Analysis Engine
# ---------------------------------------------------------------------------
def compute_indicators(df: pd.DataFrame) -> pd.DataFrame:
    """Add RSI, MACD, Bollinger, SMAs, EMAs, OBV."""
    if len(df) < 30:
        return df

    close = df["Close"]
    high = df["High"]
    low = df["Low"]
    volume = df["Volume"]

    # RSI
    rsi = RSIIndicator(close=close, window=14)
    df["RSI"] = rsi.rsi()

    # MACD
    macd = MACD(close=close)
    df["MACD"] = macd.macd()
    df["MACD_Signal"] = macd.macd_signal()
    df["MACD_Hist"] = macd.macd_diff()

    # Bollinger Bands
    bb = BollingerBands(close=close, window=20, window_dev=2)
    df["BB_High"] = bb.bollinger_hband()
    df["BB_Low"] = bb.bollinger_lband()
    df["BB_Mid"] = bb.bollinger_mavg()
    df["BB_Pct"] = bb.bollinger_pband()  # 0 = lower, 1 = upper

    # Moving Averages
    df["SMA_20"] = SMAIndicator(close=close, window=20).sma_indicator()
    df["SMA_50"] = SMAIndicator(close=close, window=50).sma_indicator()
    df["SMA_200"] = SMAIndicator(close=close, window=200).sma_indicator() if len(df) >= 200 else np.nan
    df["EMA_12"] = EMAIndicator(close=close, window=12).ema_indicator()
    df["EMA_26"] = EMAIndicator(close=close, window=26).ema_indicator()

    # Volume
    df["OBV"] = OnBalanceVolumeIndicator(close=close, volume=volume).on_balance_volume()

    return df


def generate_signal(ticker: str, df: pd.DataFrame, is_etf: bool = False) -> Dict[str, Any]:
    """
    Solid multi-factor signal logic.
    Returns: signal (long / short / neutral), strength (0-100), reasons, key metrics.
    """
    if df is None or len(df) < 30:
        return {
            "ticker": ticker,
            "signal": "neutral",
            "strength": 0,
            "reasons": ["Insufficient data"],
            "price": None,
            "is_etf": is_etf,
        }

    latest = df.iloc[-1]
    prev = df.iloc[-2] if len(df) > 1 else latest

    price = float(latest["Close"])
    rsi = float(latest.get("RSI", 50) or 50)
    macd = float(latest.get("MACD", 0) or 0)
    macd_sig = float(latest.get("MACD_Signal", 0) or 0)
    macd_hist = float(latest.get("MACD_Hist", 0) or 0)
    bb_pct = float(latest.get("BB_Pct", 0.5) or 0.5)
    sma20 = float(latest.get("SMA_20", price) or price)
    sma50 = float(latest.get("SMA_50", price) or price)
    sma200 = float(latest.get("SMA_200", price) or price) if not pd.isna(latest.get("SMA_200")) else None

    reasons: List[str] = []
    long_score = 0
    short_score = 0

    # --- RSI ---
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

    # --- MACD ---
    if macd > macd_sig and macd_hist > 0:
        long_score += 20
        reasons.append("MACD bullish crossover / positive histogram")
    elif macd < macd_sig and macd_hist < 0:
        short_score += 20
        reasons.append("MACD bearish crossover / negative histogram")

    # MACD momentum
    if len(df) > 2:
        prev_hist = float(df.iloc[-2].get("MACD_Hist", 0) or 0)
        if macd_hist > prev_hist and macd_hist > 0:
            long_score += 8
        elif macd_hist < prev_hist and macd_hist < 0:
            short_score += 8

    # --- Bollinger ---
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

    # --- Trend / MAs ---
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

    # --- Volume confirmation (simple) ---
    if "Volume" in df.columns and len(df) > 20:
        avg_vol = df["Volume"].tail(20).mean()
        if latest["Volume"] > avg_vol * 1.5:
            if long_score > short_score:
                long_score += 7
                reasons.append("High volume confirmation")
            elif short_score > long_score:
                short_score += 7
                reasons.append("High volume confirmation")

    # --- ETF special logic: favor dips for DCA ---
    if is_etf:
        # Extra weight on oversold / below MAs for buy-the-dip
        if rsi < 40 or bb_pct < 0.3 or (sma200 and price < sma200 * 0.98):
            long_score += 15
            reasons.append("ETF dip opportunity (DCA-friendly)")
        # Reduce short bias for broad ETFs
        short_score = int(short_score * 0.6)

    # Determine final signal
    net = long_score - short_score
    if net >= 25:
        signal = "long"
        strength = min(100, 50 + net)
    elif net <= -25:
        signal = "short"
        strength = min(100, 50 + abs(net))
    else:
        signal = "neutral"
        strength = max(0, 50 - abs(net))

    # Clean reasons
    reasons = list(dict.fromkeys(reasons))[:6]

    return {
        "ticker": ticker,
        "signal": signal,
        "strength": int(strength),
        "long_score": long_score,
        "short_score": short_score,
        "reasons": reasons,
        "price": round(price, 4),
        "rsi": round(rsi, 1),
        "macd_hist": round(macd_hist, 4),
        "bb_pct": round(bb_pct, 3),
        "sma20": round(sma20, 4),
        "sma50": round(sma50, 4),
        "sma200": round(sma200, 4) if sma200 else None,
        "is_etf": is_etf,
        "updated": datetime.now(timezone.utc).isoformat(),
    }


def fetch_and_analyze(ticker: str, is_etf: bool = False) -> Optional[Dict[str, Any]]:
    """Download history and produce signal."""
    try:
        t = yf.Ticker(ticker)
        # Use period that covers LOOKBACK + buffer
        period = "6mo" if LOOKBACK_DAYS <= 120 else "1y"
        df = t.history(period=period, auto_adjust=True)
        if df.empty or len(df) < 20:
            log.warning(f"No/insufficient data for {ticker}")
            return None
        df = compute_indicators(df)
        return generate_signal(ticker, df, is_etf=is_etf)
    except Exception as e:
        log.error(f"Error analyzing {ticker}: {e}")
        return None


def run_analysis_cycle():
    """Full update of all tickers."""
    global latest_signals, latest_etf_opportunities, last_update
    log.info("Starting analysis cycle...")
    results = {}
    etf_opps = []

    all_tickers = list(dict.fromkeys(TICKERS + ETF_TICKERS))
    for ticker in all_tickers:
        is_etf = ticker in ETF_TICKERS
        sig = fetch_and_analyze(ticker, is_etf=is_etf)
        if sig:
            results[ticker] = sig
            if is_etf and sig["signal"] == "long" and sig["strength"] >= 55:
                etf_opps.append({
                    "ticker": ticker,
                    "strength": sig["strength"],
                    "price": sig["price"],
                    "rsi": sig["rsi"],
                    "reasons": sig["reasons"],
                    "recommendation": "Guter Zeitpunkt zum Nachkaufen (DCA)",
                })
        time.sleep(0.8)  # be nice to Yahoo

    latest_signals = results
    latest_etf_opportunities = sorted(etf_opps, key=lambda x: -x["strength"])
    last_update = datetime.now(timezone.utc).isoformat()
    log.info(f"Analysis done. {len(results)} signals, {len(etf_opps)} ETF opportunities.")

    if MQTT_ENABLED and mqtt_client:
        publish_mqtt()


def publish_mqtt():
    """Publish sensors to MQTT (Home Assistant discovery friendly)."""
    if not mqtt_client:
        return
    try:
        # Summary
        payload = {
            "last_update": last_update,
            "ticker_count": len(latest_signals),
            "etf_opportunities": len(latest_etf_opportunities),
            "long_count": sum(1 for s in latest_signals.values() if s["signal"] == "long"),
            "short_count": sum(1 for s in latest_signals.values() if s["signal"] == "short"),
        }
        mqtt_client.publish(f"{MQTT_PREFIX}/summary", json.dumps(payload), retain=True)

        for ticker, sig in latest_signals.items():
            topic = f"{MQTT_PREFIX}/{ticker.replace('.', '_')}"
            mqtt_client.publish(topic, json.dumps(sig), retain=True)
            # Simple state sensor
            mqtt_client.publish(f"{topic}/signal", sig["signal"], retain=True)
            mqtt_client.publish(f"{topic}/strength", str(sig["strength"]), retain=True)

        # ETF opportunities list
        mqtt_client.publish(
            f"{MQTT_PREFIX}/etf_opportunities",
            json.dumps(latest_etf_opportunities),
            retain=True,
        )
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
        client.connect(MQTT_HOST, MQTT_PORT, 60)
        client.loop_start()
        mqtt_client = client
        log.info(f"MQTT connected to {MQTT_HOST}:{MQTT_PORT}")
    except Exception as e:
        log.error(f"MQTT connect failed: {e}")
        mqtt_client = None


# ---------------------------------------------------------------------------
# REST API
# ---------------------------------------------------------------------------
@app.route("/health")
def health():
    return jsonify({"status": "ok", "last_update": last_update})


@app.route("/signals")
def get_signals():
    return jsonify({
        "last_update": last_update,
        "signals": latest_signals,
        "etf_opportunities": latest_etf_opportunities,
    })


@app.route("/signal/<ticker>")
def get_signal(ticker: str):
    t = ticker.upper()
    if t in latest_signals:
        return jsonify(latest_signals[t])
    # On-demand analysis
    is_etf = t in ETF_TICKERS
    sig = fetch_and_analyze(t, is_etf=is_etf)
    if sig:
        return jsonify(sig)
    return jsonify({"error": "No data"}), 404


@app.route("/etf_opportunities")
def get_etf_opps():
    return jsonify({
        "last_update": last_update,
        "opportunities": latest_etf_opportunities,
    })


@app.route("/analyze", methods=["POST"])
def analyze_on_demand():
    data = request.get_json(silent=True) or {}
    ticker = (data.get("ticker") or request.args.get("ticker") or "").upper()
    if not ticker:
        return jsonify({"error": "ticker required"}), 400
    is_etf = data.get("is_etf", False) or ticker in ETF_TICKERS
    sig = fetch_and_analyze(ticker, is_etf=is_etf)
    if sig:
        return jsonify(sig)
    return jsonify({"error": "analysis failed"}), 500


# ---------------------------------------------------------------------------
# Background scheduler
# ---------------------------------------------------------------------------
def scheduler_loop():
    # Initial run after short delay
    time.sleep(5)
    while True:
        try:
            run_analysis_cycle()
        except Exception as e:
            log.exception(f"Analysis cycle error: {e}")
        time.sleep(UPDATE_MINUTES * 60)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    log.info("Stock & ETF Signal Server starting")
    log.info(f"Tickers: {TICKERS}")
    log.info(f"ETFs: {ETF_TICKERS}")
    log.info(f"Interval: {UPDATE_MINUTES} min | RSI {RSI_OVERSOLD}/{RSI_OVERBOUGHT}")

    mqtt_connect()

    t = threading.Thread(target=scheduler_loop, daemon=True)
    t.start()

    # Flask on 8099
    app.run(host="0.0.0.0", port=8099, threaded=True)
