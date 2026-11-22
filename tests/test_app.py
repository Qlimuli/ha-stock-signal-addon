import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

os.environ.setdefault("DATA_DIR", tempfile.mkdtemp(prefix="stock-signal-tests-"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "stock_signal" / "rootfs" / "app"))
import main


class SignalEngineTests(unittest.TestCase):
    def make_prices(self, count=260):
        import numpy as np
        import pandas as pd
        x = np.arange(count, dtype=float)
        close = 100 + x * 0.03 + np.sin(x / 7) * 1.8
        return pd.DataFrame({
            "Open": close - 0.1, "High": close + 0.8, "Low": close - 0.8,
            "Close": close, "Volume": 100000 + (x % 17) * 2500,
        }, index=pd.date_range("2026-01-01", periods=count, freq="5min"))

    def test_indicator_pipeline_and_signal_contract(self):
        df = main.compute_indicators(self.make_prices())
        for column in ("RSI", "MACD", "MACD_Signal", "BB_Pct", "SMA_20", "SMA_50", "SMA_200", "EMA_12", "EMA_26", "VWAP", "ATR", "STOCH_K", "STOCH_D", "ADX", "CCI", "OBV", "Volume_Avg20"):
            self.assertIn(column, df.columns)
        result = main.generate_signal("TEST", df)
        self.assertIn(result["signal"], ("long", "short", "neutral"))
        self.assertTrue(0 <= result["confidence"] <= 95)
        self.assertEqual(result["confidence_type"], "heuristic_score_not_probability")
        self.assertTrue(result["data_sufficient"])
        self.assertIsNotNone(result["vwap"])
        self.assertGreaterEqual(result["atr"], 0)
        if result["signal"] != "neutral":
            self.assertIsNotNone(result["stop_loss"])
            self.assertIsNotNone(result["target_price"])

    def test_multiindex_field_ticker_layout(self):
        import pandas as pd
        base = self.make_prices()
        base.columns = pd.MultiIndex.from_product([base.columns, ["TEST"]])
        result = main.compute_indicators(base)
        self.assertIn("SMA_200", result.columns)

    def test_insufficient_intraday_history_is_not_a_signal(self):
        result = main.generate_signal("TEST", self.make_prices(199))
        self.assertFalse(result["data_sufficient"])
        self.assertEqual(result["signal"], "neutral")

    def test_zero_indicator_values_are_preserved(self):
        df = main.compute_indicators(self.make_prices())
        df.iloc[-1, df.columns.get_loc("RSI")] = 0
        df.iloc[-1, df.columns.get_loc("BB_Pct")] = 0
        df.iloc[-1, df.columns.get_loc("STOCH_K")] = 0
        result = main.generate_signal("TEST", df)
        self.assertEqual(result["rsi"], 0)
        self.assertEqual(result["bb_pct"], 0)
        self.assertEqual(result["stoch_k"], 0)

    def test_fetch_uses_intraday_and_fallback(self):
        ticker = Mock()
        ticker.history.side_effect = [self.make_prices(120), self.make_prices(260)]
        with patch.object(main.yf, "Ticker", return_value=ticker):
            result = main.fetch_and_analyze("TEST")
        self.assertEqual(result["interval"], "15m")
        self.assertEqual(result["vwap_type"], "session")
        self.assertEqual(ticker.history.call_args_list[0].kwargs["interval"], "5m")
        self.assertEqual(ticker.history.call_args_list[1].kwargs["interval"], "15m")

    def test_etf_uses_daily_bars_for_dca(self):
        ticker = Mock()
        ticker.history.return_value = self.make_prices(260)
        with patch.object(main.yf, "Ticker", return_value=ticker):
            result = main.fetch_and_analyze("SPY", is_etf=True)
        self.assertEqual(result["interval"], "1d")
        self.assertEqual(result["vwap_type"], "rolling20")
        self.assertEqual(ticker.history.call_args.kwargs["interval"], "1d")


class ApiAndPortfolioTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        main.PORTFOLIO_FILE = Path(self.temp.name) / "portfolio.json"
        main.latest_signals = {}
        main.latest_etf_opportunities = []
        main.last_update = None
        main.cycle_status = "idle"
        main.app.config.update(TESTING=True)
        self.client = main.app.test_client()

    def tearDown(self):
        self.temp.cleanup()

    def test_health_and_signals_endpoints(self):
        self.assertEqual(self.client.get("/health").status_code, 200)
        body = self.client.get("/signals").get_json()
        self.assertIn("signals", body)
        self.assertIn("cycle_status", body)

    def test_portfolio_create_update_delete_and_totals(self):
        response = self.client.post("/portfolio/holding", json={
            "ticker": "AAPL", "quantity": 2, "avg_cost": 100, "is_etf": False
        })
        self.assertEqual(response.status_code, 201)
        main.latest_signals["AAPL"] = {"price": 125, "signal": "long", "confidence": 70}
        snapshot = self.client.get("/portfolio").get_json()
        self.assertEqual(snapshot["market_value"], 250)
        self.assertEqual(snapshot["invested"], 200)
        self.assertEqual(snapshot["pnl"], 50)
        self.assertEqual(snapshot["unpriced_count"], 0)
        self.assertEqual(self.client.delete("/portfolio/holding/AAPL").status_code, 200)
        self.assertEqual(self.client.get("/portfolio").get_json()["holdings"], [])

    def test_portfolio_bulk_validation_and_import(self):
        self.assertEqual(self.client.post("/portfolio", json=[{"ticker":"MSFT","quantity":3,"avg_cost":20}]).status_code, 200)
        self.assertEqual(self.client.post("/portfolio", json=[None]).status_code, 400)
        self.assertEqual(self.client.post("/portfolio/holding", json=[]).status_code, 400)
        self.assertEqual(self.client.post("/portfolio", json={"ticker":"BAD"}).status_code, 400)

    def test_corrupt_portfolio_is_not_overwritten(self):
        original = "{not valid json"
        main.PORTFOLIO_FILE.write_text(original, encoding="utf-8")
        with self.assertRaises(RuntimeError):
            main._portfolio_read()
        self.assertEqual(main.PORTFOLIO_FILE.read_text(encoding="utf-8"), original)

    def test_recommendations_endpoint(self):
        self.client.post("/portfolio/holding", json={"ticker":"AAPL","quantity":1,"avg_cost":100})
        main.latest_signals["AAPL"] = {"price":110,"signal":"long","confidence":80}
        response = self.client.get("/recommendations")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["recommendations"][0]["ticker"], "AAPL")

    def test_analyze_endpoint_validation_and_result(self):
        self.assertEqual(self.client.post("/analyze", json={}).status_code, 400)
        self.assertEqual(self.client.post("/analyze", json=[]).status_code, 400)
        with patch.object(main, "fetch_and_analyze", return_value={"ticker":"AAPL","signal":"neutral"}):
            self.assertEqual(self.client.post("/analyze", json={"ticker":"AAPL"}).status_code, 200)
        self.assertIn("AAPL", main.latest_signals)

    def test_single_signal_endpoint_caches_new_analysis(self):
        with patch.object(main, "fetch_and_analyze", return_value={"ticker":"MSFT","signal":"long"}):
            response = self.client.get("/signal/MSFT")
        self.assertEqual(response.status_code, 200)
        self.assertIn("MSFT", main.latest_signals)

    def test_static_dashboard_and_etf_endpoint(self):
        self.assertEqual(self.client.get("/").status_code, 200)
        self.assertEqual(self.client.get("/etf_opportunities").status_code, 200)

    def test_refresh_reports_existing_cycle(self):
        main.cycle_lock.acquire()
        try:
            response = self.client.post("/refresh")
            self.assertEqual(response.status_code, 202)
            self.assertEqual(response.get_json()["status"], "running")
        finally:
            main.cycle_lock.release()


class CycleAndMqttTests(unittest.TestCase):
    def setUp(self):
        main.latest_signals = {}
        main.latest_etf_opportunities = []
        main.last_update = None
        main.cycle_status = "idle"

    def test_cycle_includes_manually_held_tickers(self):
        main.latest_signals = {"REMOVED":{"ticker":"REMOVED","signal":"long"}}
        fake_signal = lambda ticker, is_etf=False: {
            "ticker": ticker, "signal": "neutral", "strength": 0, "confidence": 0,
            "price": 10, "reasons": [], "is_etf": is_etf
        }
        with patch.object(main, "TICKERS", ["AAPL"]), patch.object(main, "ETF_TICKERS", ["SPY"]), \
             patch.object(main, "_portfolio_read", return_value=[{"ticker":"CUSTOM","is_etf":True}]), \
             patch.object(main, "fetch_and_analyze", side_effect=fake_signal) as fetch, \
             patch.object(main.time, "sleep"), patch.object(main, "MQTT_ENABLED", False):
            self.assertTrue(main.run_analysis_cycle())
        self.assertEqual({call.args[0] for call in fetch.call_args_list}, {"AAPL", "SPY", "CUSTOM"})
        self.assertTrue(main.latest_signals["CUSTOM"]["is_etf"])
        self.assertNotIn("REMOVED", main.latest_signals)
        self.assertEqual(main.cycle_status, "idle")

    def test_push_only_fires_on_new_qualifying_signal(self):
        with patch.object(main, "_push_settings_read", return_value={
            "enabled": True, "notify_long": True, "notify_short": True, "min_confidence": 70
        }), patch.object(main, "_push_send", return_value=1) as send:
            main.notify_signal_changes({"AAPL":{"signal":"neutral"}}, {
                "AAPL":{"signal":"long","confidence":75,"price":100}
            })
            main.notify_signal_changes({"MSFT":{"signal":"long"}}, {
                "MSFT":{"signal":"long","confidence":90,"price":200}
            })
            main.notify_signal_changes({"NVDA":{"signal":"neutral"}}, {
                "NVDA":{"signal":"short","confidence":60,"price":100}
            })
        self.assertEqual(send.call_count, 1)
        self.assertEqual(send.call_args.args[0]["ticker"], "AAPL")

    def test_mqtt_v2_reason_code_object_does_not_crash(self):
        reason = Mock(is_failure=False)
        with patch.object(main, "publish_mqtt"):
            main._mqtt_on_connect(None, None, None, reason, None)
        self.assertTrue(main.mqtt_connected)
        main.mqtt_connected = False

    def test_push_settings_validation_and_subscription(self):
        with tempfile.TemporaryDirectory() as folder:
            main.PUSH_SETTINGS_FILE = Path(folder) / "push_settings.json"
            main.PUSH_SUBSCRIPTIONS_FILE = Path(folder) / "push_subscriptions.json"
            client = main.app.test_client()
            self.assertEqual(client.post("/push/settings", json={"min_confidence": 120}).status_code, 400)
            self.assertEqual(client.post("/push/settings", json={"enabled": False, "min_confidence": 70}).status_code, 200)
            self.assertFalse(client.get("/push/settings").get_json()["enabled"])
            self.assertEqual(client.post("/push/subscribe", json={"endpoint":"https://push.example/sub","keys":{"p256dh":"key","auth":"auth"}}).status_code, 201)
            self.assertEqual(client.get("/push/settings").get_json()["subscriptions"], 1)

    def test_mqtt_topics_are_retained(self):
        fake = Mock()
        main.mqtt_client = fake
        main.mqtt_connected = True
        fake.publish.return_value.rc = 0
        main.latest_signals = {"AAPL":{"signal":"long","strength":60,"confidence":70}}
        main.latest_etf_opportunities = []
        main.last_update = "2026-11-22T12:00:00+00:00"
        main.publish_mqtt()
        self.assertGreaterEqual(fake.publish.call_count, 6)
        self.assertTrue(all(call.kwargs.get("retain") is True for call in fake.publish.call_args_list))
        main.mqtt_client = None
        main.mqtt_connected = False


if __name__ == "__main__":
    unittest.main()
