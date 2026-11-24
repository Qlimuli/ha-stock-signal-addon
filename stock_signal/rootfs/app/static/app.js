/* Stock & ETF Signals – frontend v1.6.0 */
(function () {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  let signals = {};
  let etfOpps = [];
  let clearOpps = [];
  let market = { indices: [], mood: "unknown", summary: "" };
  let news = [];
  let portfolio = null;
  let recommendations = [];
  let filter = "all";
  let cycleStatus = "idle";

  function api(path, opts) {
    return fetch(path, opts).then(async (r) => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || r.statusText || "Request failed");
      return data;
    });
  }

  function fmtPrice(v) {
    if (v == null || !isFinite(v)) return "—";
    return Number(v).toLocaleString("de-DE", { maximumFractionDigits: 4 });
  }

  function fmtPct(v) {
    if (v == null || !isFinite(v)) return "—";
    return (v >= 0 ? "+" : "") + Number(v).toFixed(2) + " %";
  }

  function fmtTime(iso) {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" });
    } catch (_) {
      return iso;
    }
  }

  function signalLabel(s) {
    if (s === "long") return "LONG";
    if (s === "short") return "SHORT";
    return "NEUTRAL";
  }

  function moodLabel(m) {
    return ({ risk_on: "Risk-On", risk_off: "Risk-Off", mixed: "Gemischt", quiet: "Ruhig", unknown: "Unbekannt" })[m] || m || "—";
  }

  function biasLabel(b) {
    return ({ bullish: "↑ Aufwärts-Bias", bearish: "↓ Abwärts-Bias", mild_bullish: "↗ Leicht positiv", mild_bearish: "↘ Leicht negativ", sideways: "→ Seitwärts" })[b] || "—";
  }

  function setActiveTab(name) {
    $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    $$(".panel").forEach((p) => p.classList.toggle("active", p.id === "panel-" + name));
  }

  function escapeHtml(s) {
    return String(s || "").replace(/&/g, "&").replace(/</g, "<").replace(/>/g, ">").replace(/"/g, """);
  }

  function renderSummary() {
    const list = Object.values(signals);
    $("#sumTickers").textContent = list.length || "0";
    $("#sumLong").textContent = list.filter((s) => s.signal === "long").length;
    $("#sumShort").textContent = list.filter((s) => s.signal === "short").length;
    $("#sumEtf").textContent = etfOpps.length;
    $("#sumClear").textContent = clearOpps.length;
  }

  function renderMarket() {
    const box = $("#marketBox");
    if (!box) return;
    const indices = market.indices || [];
    if (!indices.length && !market.summary) {
      box.innerHTML = '<div class="empty">Marktdaten werden geladen …</div>';
      return;
    }
    const chips = indices.map((i) => {
      const cls = i.direction === "up" ? "up" : i.direction === "down" ? "down" : "flat";
      return `<div class="idx-chip ${cls}"><span class="idx-name">${i.name}</span><span class="idx-chg">${fmtPct(i.change_pct)}</span></div>`;
    }).join("");
    box.innerHTML = `<div class="market-head"><div class="mood-badge mood-${market.mood || "unknown"}">${moodLabel(market.mood)}</div><p class="market-summary">${market.summary || ""}</p></div><div class="idx-grid">${chips || '<div class="empty">Keine Indexdaten</div>'}</div>`;
  }

  function renderNews() {
    const box = $("#newsList");
    if (!box) return;
    if (!news.length) {
      box.innerHTML = '<div class="empty">Keine aktuellen Headlines – nach dem nächsten Analysezyklus erscheinen sie hier.</div>';
      return;
    }
    box.innerHTML = news.map((n) => {
      const title = n.link ? `<a href="${n.link}" target="_blank" rel="noopener">${escapeHtml(n.title)}</a>` : escapeHtml(n.title);
      return `<article class="news-item"><div class="news-title">${title}</div><div class="news-meta">${escapeHtml(n.publisher || "")}${n.related ? " · " + escapeHtml(n.related) : ""}</div></article>`;
    }).join("");
  }

  function oppCard(o) {
    const buy = o.signal === "long";
    return `<div class="opp-card ${buy ? "buy" : "sell"}" data-ticker="${escapeHtml(o.ticker)}"><div class="opp-top"><span class="opp-ticker">${escapeHtml(o.ticker)}${o.is_etf ? ' <span class="badge kind">ETF</span>' : ""}</span><span class="badge ${buy ? "long" : "short"}">${signalLabel(o.signal)}</span></div><div class="opp-action">${escapeHtml(o.action || (buy ? "Nachkauf prüfen" : "Absichern prüfen"))}</div><div class="opp-price">${fmtPrice(o.price)}</div><div class="opp-scores"><span>Conf <strong>${o.confidence ?? "—"}%</strong></span><span>Stärke <strong>${o.strength ?? "—"}</strong></span><span>${biasLabel(o.short_term_bias)}</span></div>${o.stop_loss != null ? `<div class="opp-risk">SL ~ ${fmtPrice(o.stop_loss)} · Ziel ~ ${fmtPrice(o.target_price)}</div>` : ""}<div class="opp-reasons">${(o.reasons || []).slice(0, 3).map(escapeHtml).join(" · ")}</div></div>`;
  }

  function renderClear() {
    const box = $("#clearOpps");
    if (!clearOpps.length) {
      box.innerHTML = '<div class="empty">Keine klaren Kauf-/Verkaufschancen. Nur sehr starke, übereinstimmende Signale werden hier gezeigt.</div>';
      return;
    }
    box.innerHTML = clearOpps.map(oppCard).join("");
    $$(".opp-card", box).forEach((el) => el.addEventListener("click", () => openSignalModal(el.dataset.ticker)));
  }

  function renderEtf() {
    const section = $("#etfSection");
    const grid = $("#etfGrid");
    if (!etfOpps.length) { section.style.display = "none"; return; }
    section.style.display = "";
    grid.innerHTML = etfOpps.map((e) => `<div class="etf-card" data-ticker="${escapeHtml(e.ticker)}"><div class="ticker">${escapeHtml(e.ticker)}</div><div class="rec">${escapeHtml(e.recommendation || "DCA prüfen")}</div><div class="meta"><span>${fmtPrice(e.price)}</span><span>Conf ${e.confidence}%</span><span>RSI ${e.rsi ?? "—"}</span></div></div>`).join("");
    $$(".etf-card", grid).forEach((el) => el.addEventListener("click", () => openSignalModal(el.dataset.ticker)));
  }

  function renderPulse() {
    const box = $("#pulseGrid");
    const list = Object.values(signals).sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
    if (!list.length) { box.innerHTML = '<div class="empty">Noch keine Signale</div>'; return; }
    box.innerHTML = list.map((s) => `<button type="button" class="pulse-chip ${s.signal}${s.clear_opportunity ? " clear" : ""}" data-ticker="${escapeHtml(s.ticker)}"><span class="pulse-ticker">${escapeHtml(s.ticker)}</span><span class="pulse-sig">${signalLabel(s.signal)}${s.clear_opportunity ? " · klar" : ""}</span><span class="pulse-meta">${fmtPrice(s.price)} · ${s.confidence ?? 0}%</span></button>`).join("");
    $$(".pulse-chip", box).forEach((el) => el.addEventListener("click", () => openSignalModal(el.dataset.ticker)));
  }

  function renderDashRecs() {
    const box = $("#dashRecs");
    const rows = Object.values(signals).filter((s) => s.signal !== "neutral" || s.clear_opportunity).sort((a, b) => (b.confidence || 0) - (a.confidence || 0)).slice(0, 8);
    if (!rows.length) { box.innerHTML = '<div class="empty">Keine nennenswerten Signale</div>'; return; }
    box.innerHTML = rows.map((s) => `<div class="rec-item${s.clear_opportunity ? " clear-rec" : ""}" data-ticker="${escapeHtml(s.ticker)}"><strong>${escapeHtml(s.ticker)}</strong> <span class="badge ${s.signal}">${signalLabel(s.signal)}</span> · Conf ${s.confidence}% · ${biasLabel(s.short_term_bias)}<div class="reasons">${(s.reasons || []).slice(0, 2).map(escapeHtml).join(" · ")}</div></div>`).join("");
    $$(".rec-item", box).forEach((el) => el.addEventListener("click", () => openSignalModal(el.dataset.ticker)));
  }

  function matchesFilter(s) {
    if (filter === "all") return true;
    if (filter === "long") return s.signal === "long";
    if (filter === "short") return s.signal === "short";
    if (filter === "neutral") return s.signal === "neutral";
    if (filter === "etf") return !!s.is_etf;
    if (filter === "clear") return !!s.clear_opportunity;
    return true;
  }

  function renderSignals() {
    const box = $("#signalsGrid");
    const list = Object.values(signals).filter(matchesFilter).sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
    if (!list.length) { box.innerHTML = '<div class="empty">Keine Signale für diesen Filter</div>'; return; }
    box.innerHTML = list.map((s) => {
      const fill = Math.min(100, s.strength || 0);
      return `<div class="signal-card ${s.signal}" data-ticker="${escapeHtml(s.ticker)}"><div class="card-top"><span class="ticker-name">${escapeHtml(s.ticker)}${s.is_etf ? ' <span class="badge etf-tag">ETF</span>' : ""}${s.clear_opportunity ? ' <span class="badge clear-tag">klar</span>' : ""}</span><span class="badge ${s.signal}">${signalLabel(s.signal)}</span></div><div class="price">${fmtPrice(s.price)}</div><div class="strength-row"><div class="strength-bar"><div class="strength-fill ${s.signal}" style="width:${fill}%"></div></div><span class="strength-val">${s.strength ?? 0}</span></div><div class="meta-row"><span>Conf ${s.confidence}%</span><span>RSI ${s.rsi ?? "—"}</span><span>ADX ${s.adx ?? "—"}</span><span>${biasLabel(s.short_term_bias)}</span></div><div class="reasons">${(s.reasons || []).slice(0, 3).map(escapeHtml).join(" · ")}</div></div>`;
    }).join("");
    $$(".signal-card", box).forEach((el) => el.addEventListener("click", () => openSignalModal(el.dataset.ticker)));
  }

  function openSignalModal(ticker) {
    const s = signals[ticker];
    if (!s) return;
    $("#modalBody").innerHTML = `<h3 style="margin-bottom:8px">${escapeHtml(s.ticker)} <span class="badge ${s.signal}">${signalLabel(s.signal)}</span>${s.clear_opportunity ? ' <span class="badge clear-tag">klares Signal</span>' : ""}</h3><p class="muted">${escapeHtml(s.bias_note || "")}</p><div class="metric-grid"><div class="metric"><div class="m-label">Kurs</div><div class="m-value">${fmtPrice(s.price)}</div></div><div class="metric"><div class="m-label">Confidence</div><div class="m-value">${s.confidence}%</div></div><div class="metric"><div class="m-label">RSI</div><div class="m-value">${s.rsi ?? "—"}</div></div><div class="metric"><div class="m-label">ADX</div><div class="m-value">${s.adx ?? "—"}</div></div><div class="metric"><div class="m-label">Stop (orient.)</div><div class="m-value">${fmtPrice(s.stop_loss)}</div></div><div class="metric"><div class="m-label">Ziel (orient.)</div><div class="m-value">${fmtPrice(s.target_price)}</div></div></div><ul class="reason-list">${(s.reasons || []).map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul><p class="small-note">Confidence ist kein Wahrscheinlichkeitswert. Keine Finanzberatung.</p>`;
    $("#modal").hidden = false;
  }

  function renderPortfolio() {
    const body = $("#pfBody");
    const totals = $("#pfTotals");
    if (!portfolio) { body.innerHTML = ""; totals.textContent = "—"; return; }
    const holdings = portfolio.holdings || [];
    const mv = portfolio.market_value;
    const pnl = portfolio.pnl;
    totals.innerHTML = `<span>Wert: <strong>${mv != null ? fmtPrice(mv) : "—"}</strong></span><span class="${(pnl || 0) >= 0 ? "status-ok" : "status-error"}">P&L: ${pnl != null ? fmtPrice(pnl) : "—"}</span>`;
    if (!holdings.length) { body.innerHTML = '<tr><td colspan="8" class="empty">Keine Positionen</td></tr>'; return; }
    body.innerHTML = holdings.map((h) => {
      const sig = signals[h.ticker] || {};
      return `<tr><td><strong>${escapeHtml(h.ticker)}</strong>${h.is_etf ? " <span class='badge kind'>ETF</span>" : ""}</td><td>${h.quantity}</td><td>${fmtPrice(h.avg_cost)}</td><td>${fmtPrice(h.price ?? sig.price)}</td><td>${fmtPrice(h.market_value)}</td><td class="${(h.pnl || 0) >= 0 ? "status-ok" : "status-error"}">${fmtPrice(h.pnl)}</td><td><span class="badge ${sig.signal || "neutral"}">${signalLabel(sig.signal || "neutral")}</span></td><td><button type="button" class="btn btn-secondary btn-del" data-ticker="${escapeHtml(h.ticker)}">×</button></td></tr>`;
    }).join("");
    $$(".btn-del", body).forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("Position " + btn.dataset.ticker + " löschen?")) return;
        try { portfolio = await api("/portfolio/holding/" + encodeURIComponent(btn.dataset.ticker), { method: "DELETE" }); renderPortfolio(); loadRecommendations(); } catch (e) { alert(e.message); }
      });
    });
  }

  function renderPfRecs() {
    const box = $("#pfRecs");
    if (!recommendations.length) { box.innerHTML = '<div class="empty">Noch keine Daten</div>'; return; }
    box.innerHTML = recommendations.slice(0, 10).map((r) => {
      const sig = r.signal || (signals[r.ticker] || {}).signal || "neutral";
      return `<div class="rec-item"><strong>${escapeHtml(r.ticker)}</strong> <span class="badge ${sig}">${signalLabel(sig)}</span> · Conf ${r.confidence ?? (signals[r.ticker] || {}).confidence ?? "—"}%</div>`;
    }).join("");
  }

  async function loadAll() {
    try {
      const data = await api("/signals");
      signals = data.signals || {};
      etfOpps = data.etf_opportunities || [];
      clearOpps = data.clear_opportunities || [];
      market = data.market || market;
      news = data.news || [];
      cycleStatus = data.cycle_status || "idle";
      $("#lastUpdate").textContent = "Stand: " + fmtTime(data.last_update);
      $("#apiStatus").className = "status ok";
      renderSummary(); renderMarket(); renderNews(); renderClear(); renderEtf(); renderPulse(); renderDashRecs(); renderSignals();
    } catch (e) {
      $("#apiStatus").className = "status err";
      console.error(e);
    }
  }

  async function loadPortfolio() {
    try { portfolio = await api("/portfolio"); renderPortfolio(); } catch (e) { console.error(e); }
  }

  async function loadRecommendations() {
    try { const data = await api("/recommendations"); recommendations = data.recommendations || []; renderPfRecs(); } catch (e) { console.error(e); }
  }

  async function loadSystem() {
    const box = $("#systemStatus");
    try {
      const h = await api("/health");
      box.innerHTML = `<div class="status-line"><span>Status</span><strong class="status-ok">${h.status}</strong></div><div class="status-line"><span>Zyklus</span><strong>${h.cycle_status}</strong></div><div class="status-line"><span>Signale</span><strong>${h.signal_count}</strong></div><div class="status-line"><span>MQTT</span><strong>${h.mqtt_enabled ? (h.mqtt_connected ? "verbunden" : "getrennt") : "aus"}</strong></div><div class="status-line"><span>Update</span><strong>${fmtTime(h.last_update)}</strong></div>`;
    } catch (e) { box.innerHTML = '<div class="status-error">Status nicht erreichbar</div>'; }
  }

  $$(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      setActiveTab(tab.dataset.tab);
      if (tab.dataset.tab === "portfolio") { loadPortfolio(); loadRecommendations(); }
      if (tab.dataset.tab === "settings") loadSystem();
    });
  });

  $$(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      filter = chip.dataset.filter;
      $$(".chip").forEach((c) => c.classList.toggle("active", c === chip));
      renderSignals();
    });
  });

  $("#btnRefresh").addEventListener("click", async () => {
    const btn = $("#btnRefresh");
    btn.classList.add("loading");
    try {
      await api("/refresh", { method: "POST" });
      setTimeout(loadAll, 2500);
      setTimeout(loadAll, 8000);
    } catch (e) { alert(e.message); }
    finally { setTimeout(() => btn.classList.remove("loading"), 1500); }
  });

  $("#analyzeForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const ticker = $("#analyzeTicker").value.trim().toUpperCase();
    const is_etf = $("#analyzeEtf").checked;
    const out = $("#analyzeResult");
    out.innerHTML = '<div class="loading">Analysiere …</div>';
    try {
      const s = await api("/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ticker, is_etf }) });
      signals[s.ticker] = s;
      out.innerHTML = `<div class="signal-card ${s.signal}"><div class="card-top"><span class="ticker-name">${escapeHtml(s.ticker)}</span><span class="badge ${s.signal}">${signalLabel(s.signal)}</span></div><div class="price">${fmtPrice(s.price)}</div><div class="meta-row">Conf ${s.confidence}% · ${biasLabel(s.short_term_bias)}${s.clear_opportunity ? " · <strong>klares Signal</strong>" : ""}</div><p class="muted">${escapeHtml(s.bias_note || "")}</p><ul class="reason-list">${(s.reasons || []).map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul></div>`;
    } catch (e) { out.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`; }
  });

  $("#btnAddHolding").addEventListener("click", () => { $("#holdForm").reset(); $("#holdModal").hidden = false; });
  $("#holdClose").addEventListener("click", () => ($("#holdModal").hidden = true));
  $("#holdX").addEventListener("click", () => ($("#holdModal").hidden = true));
  $("#holdForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const payload = { ticker: String(fd.get("ticker") || "").trim().toUpperCase(), name: String(fd.get("name") || "").trim(), quantity: Number(fd.get("quantity")), avg_cost: Number(fd.get("avg_cost")), is_etf: fd.get("is_etf") === "on" };
    try {
      portfolio = await api("/portfolio/holding", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      $("#holdModal").hidden = true; renderPortfolio(); loadRecommendations();
    } catch (e) { alert(e.message); }
  });

  $("#btnExportJson").addEventListener("click", async () => {
    try {
      const data = await api("/portfolio");
      const blob = new Blob([JSON.stringify(data.holdings || [], null, 2)], { type: "application/json" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "portfolio.json"; a.click(); URL.revokeObjectURL(a.href);
    } catch (e) { alert(e.message); }
  });

  $("#btnImportJson").addEventListener("click", () => {
    const input = document.createElement("input"); input.type = "file"; input.accept = "application/json,.json";
    input.onchange = async () => {
      const file = input.files && input.files[0]; if (!file) return;
      try {
        const arr = JSON.parse(await file.text());
        portfolio = await api("/portfolio", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(arr) });
        renderPortfolio(); loadRecommendations();
      } catch (e) { alert(e.message || "Import fehlgeschlagen"); }
    };
    input.click();
  });

  $("#btnCopyMcp").addEventListener("click", async () => {
    const url = $("#scalableMcpUrl").value;
    try { await navigator.clipboard.writeText(url); $("#btnCopyMcp").textContent = "Kopiert"; setTimeout(() => ($("#btnCopyMcp").textContent = "Kopieren"), 1500); }
    catch (_) { prompt("MCP-URL kopieren:", url); }
  });

  $("#modalClose").addEventListener("click", () => ($("#modal").hidden = true));
  $("#modalX").addEventListener("click", () => ($("#modal").hidden = true));

  async function loadPush() {
    try {
      const s = await api("/push/settings");
      $("#pushEnabled").checked = !!s.enabled;
      $("#pushLong").checked = !!s.notify_long;
      $("#pushShort").checked = !!s.notify_short;
      $("#pushConfidence").value = s.min_confidence ?? 65;
      $("#pushConfidenceValue").textContent = (s.min_confidence ?? 65) + " %";
      $("#pushStatus").textContent = (s.subscriptions || 0) + " Gerät(e)";
      $("#pushHelp").textContent = s.subscriptions ? "Geräte registriert." : "Noch kein Gerät registriert.";
    } catch (_) {}
  }

  $("#pushConfidence").addEventListener("input", () => { $("#pushConfidenceValue").textContent = $("#pushConfidence").value + " %"; });
  $("#btnSavePush").addEventListener("click", async () => {
    try {
      await api("/push/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: $("#pushEnabled").checked, notify_long: $("#pushLong").checked, notify_short: $("#pushShort").checked, min_confidence: Number($("#pushConfidence").value) }) });
      loadPush();
    } catch (e) { alert(e.message); }
  });
  $("#btnTestPush").addEventListener("click", async () => {
    try { await api("/push/test", { method: "POST" }); alert("Test gesendet (falls Geräte registriert)."); } catch (e) { alert(e.message); }
  });

  $("#btnEnablePush").addEventListener("click", async () => {
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) { alert("Push wird von diesem Browser nicht unterstützt."); return; }
      const reg = await navigator.serviceWorker.register("./sw.js");
      const keyData = await api("/push/public-key");
      if ((await Notification.requestPermission()) !== "granted") { alert("Benachrichtigungen nicht erlaubt."); return; }
      function urlBase64ToUint8Array(base64String) {
        const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
        const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
        const raw = atob(base64);
        const out = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; ++i) out[i] = raw.charCodeAt(i);
        return out;
      }
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(keyData.publicKey) });
      await api("/push/subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sub.toJSON()) });
      loadPush(); alert("Push aktiviert.");
    } catch (e) { alert(e.message || "Push-Setup fehlgeschlagen"); }
  });

  loadAll(); loadPortfolio(); loadRecommendations(); loadPush();
  setInterval(loadAll, 60000);
})();
