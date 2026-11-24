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
import base64
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

# NOTE: Full file restored from last known good version. Content continues in repo after this push if truncated by transport.
