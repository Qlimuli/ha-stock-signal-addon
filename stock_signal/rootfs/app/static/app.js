(() => {
  "use strict";

  // Relative base so HA Ingress (/api/hassio_ingress/<token>/) works.
  // Leading-slash paths would resolve against the HA host root and 404.
  const API = ".";

  let allSignals = {};
  let etfOpps = [];
  let currentFilter = "all";
  let portfolioData = [];

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  async function loadSignals() {
    try {
      const res = await fetch(`${API}/signals`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      allSignals = data.signals || {};
      etfOpps = data.etf_opportunities || [];
      updateUI(data.last_update);
      await loadPortfolio();
      setStatus(true);
    } catch (e) {
      console.error(e);
      setStatus(false);
      $("#signalsGrid").innerHTML = `<div class="empty">Keine Verbindung zum Signal-Server.<br><small>${e.message}</small></div>`;
    }
  }

  async function forceRefresh() {
    const btn = $("#btnRefresh");
    btn.classList.add("loading");
    btn.innerHTML = `<span class="icon">↻</span> Analysiere…`;
    try {
      const started = await fetch(`${API}/refresh`, { method: "POST" });
      if (!started.ok && started.status !== 202) throw new Error(`HTTP ${started.status}`);
      for (let i = 0; i < 60; i++) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        const response = await fetch(`${API}/signals`);
        const data = await response.json();
        if (data.cycle_status !== "running") break;
      }
      await loadSignals();
    } catch (e) {
      console.error("Refresh failed:", e);
      alert("Aktualisierung fehlgeschlagen: " + e.message);
    } finally {
      btn.classList.remove("loading");
      btn.innerHTML = `<span class="icon">↻</span> Aktualisieren`;
    }
  }

  function updateUI(lastUpdate) {
    const signals = Object.values(allSignals);
    const longC = signals.filter(s => s.signal === "long").length;
    const shortC = signals.filter(s => s.signal === "short").length;

    $("#sumTickers").textContent = signals.length;
    $("#sumLong").textContent = longC;
    $("#sumShort").textContent = shortC;
    $("#sumEtf").textContent = etfOpps.length;

    if (lastUpdate) {
      const d = new Date(lastUpdate);
      $("#lastUpdate").textContent = "Stand: " + d.toLocaleString("de-DE", {
        day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit"
      });
    }

    renderEtf();
    renderSignals();
    renderDashboardRecommendations();
  }

  function renderEtf() {
    const section = $("#etfSection");
    const grid = $("#etfGrid");
    if (!etfOpps.length) {
      section.style.display = "none";
      return;
    }
    section.style.display = "block";
    grid.innerHTML = etfOpps.map(o => `
      <div class="etf-card" data-ticker="${esc(o.ticker)}">
        <div class="ticker">${esc(o.ticker)}</div>
        <div class="rec">${esc(o.recommendation || "Guter Zeitpunkt zum Nachkaufen")}</div>
        <div class="meta">
          <span>Stärke ${o.strength}</span>
          <span>Confidence ${o.confidence ?? 0}%</span>
          <span>RSI ${o.rsi ?? "—"}</span>
          <span>${o.price != null ? formatPrice(o.price) : ""}</span>
        </div>
      </div>
    `).join("");

    grid.querySelectorAll(".etf-card").forEach(el => {
      el.addEventListener("click", () => openModal(el.dataset.ticker));
    });
  }

  function renderSignals() {
    const grid = $("#signalsGrid");
    let list = Object.values(allSignals);

    if (currentFilter === "long") list = list.filter(s => s.signal === "long");
    else if (currentFilter === "short") list = list.filter(s => s.signal === "short");
    else if (currentFilter === "neutral") list = list.filter(s => s.signal === "neutral");
    else if (currentFilter === "etf") list = list.filter(s => s.is_etf);

    list.sort((a, b) => {
      const order = { long: 0, short: 1, neutral: 2 };
      if (order[a.signal] !== order[b.signal]) return order[a.signal] - order[b.signal];
      return (b.strength || 0) - (a.strength || 0);
    });

    if (!list.length) {
      grid.innerHTML = `<div class="empty">Keine Signale für diesen Filter.</div>`;
      return;
    }

    grid.innerHTML = list.map(s => {
      const reasons = (s.reasons || []).slice(0, 2).join(" · ") || "—";
      return `
        <div class="signal-card ${s.signal}" data-ticker="${esc(s.ticker)}">
          <div class="card-top">
            <div>
              <span class="ticker-name">${esc(s.ticker)}</span>
              ${s.is_etf ? '<span class="badge etf-tag">ETF</span>' : ""}
            </div>
            <span class="badge ${s.signal}">${s.signal}</span>
          </div>
          <div class="price">${s.price != null ? formatPrice(s.price) : "—"}</div>
          <div class="meta-row"><span>${esc(s.interval || "—")} Kerzen</span><span>VWAP ${s.vwap != null ? formatPrice(s.vwap) : "—"}</span><span>ATR ${s.atr != null ? formatPrice(s.atr) : "—"}</span></div>
          ${s.signal !== "neutral" ? `<div class="meta-row risk"><span>SL ${s.stop_loss != null ? formatPrice(s.stop_loss) : "—"}</span><span>Ziel ${s.target_price != null ? formatPrice(s.target_price) : "—"}</span></div>` : ""}
          <div class="strength-row">
            <div class="strength-bar">
              <div class="strength-fill ${s.signal}" style="width:${Math.min(100, s.strength || 0)}%"></div>
            </div>
            <span class="strength-val">${s.strength ?? 0} · C ${s.confidence ?? 0}%</span>
          </div>
          <div class="reasons">${esc(reasons)}</div>
        </div>
      `;
    }).join("");

    grid.querySelectorAll(".signal-card").forEach(el => {
      el.addEventListener("click", () => openModal(el.dataset.ticker));
    });
  }


  async function api(path, options = {}) {
    const response = await fetch(`${API}${path}`, {
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      ...options
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  async function loadPortfolio() {
    try {
      const data = await api("/portfolio");
      portfolioData = data.holdings || [];
      $("#pfTotals").textContent = `Wert ${formatPrice(data.market_value)} · P&L ${formatPrice(data.pnl)}`;
      $("#pfBody").innerHTML = portfolioData.map(h => `
        <tr>
          <td>${esc(h.ticker)}</td><td>${h.quantity}</td><td>${formatPrice(h.avg_cost)}</td>
          <td>${h.price == null ? "—" : formatPrice(h.price)}</td>
          <td>${h.market_value == null ? "—" : formatPrice(h.market_value)}</td>
          <td>${h.pnl == null ? "—" : formatPrice(h.pnl)} (${h.pnl_percent ?? "—"}%)</td>
          <td><span class="badge ${esc(h.signal)}">${esc(h.signal)}</span></td>
          <td><button class="btn btn-secondary pf-delete" data-ticker="${esc(h.ticker)}">×</button></td>
        </tr>`).join("") || '<tr><td colspan="8" class="empty">Noch keine Positionen eingetragen.</td></tr>';
      $("#pfBody").querySelectorAll(".pf-delete").forEach(btn => btn.addEventListener("click", async () => {
        if (!confirm(`Position ${btn.dataset.ticker} löschen?`)) return;
        try { await api(`/portfolio/holding/${encodeURIComponent(btn.dataset.ticker)}`, { method: "DELETE" }); await loadPortfolio(); }
        catch (e) { alert(e.message); }
      }));
      const recs = await api("/recommendations");
      $("#pfRecs").innerHTML = (recs.recommendations || []).map(h =>
        `<div class="rec-item"><strong>${esc(h.ticker)}</strong> · ${esc(h.signal)} · Confidence ${h.confidence}% · P&L ${h.pnl_percent ?? "—"}%</div>`
      ).join("") || '<div class="empty">Noch keine Empfehlungen.</div>';
      renderDashboardRecommendations(recs.recommendations || []);
    } catch (e) {
      console.error("Portfolio:", e);
      $("#pfBody").innerHTML = `<tr><td colspan="8" class="empty">${esc(e.message)}</td></tr>`;
    }
  }

  function renderDashboardRecommendations(recommendations) {
    const target = $("#dashRecs");
    if (!target) return;
    const rows = (recommendations && recommendations.length ? recommendations : Object.values(allSignals).filter(s => s.signal !== "neutral"))
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0)).slice(0, 5);
    target.innerHTML = rows.length ? rows.slice(0, 5).map(s =>
      `<div class="rec-item"><strong>${esc(s.ticker)}</strong> · ${esc(s.signal)} · Stärke ${s.strength ?? 0} · Confidence ${s.confidence ?? 0}%</div>`
    ).join("") : '<div class="empty">Noch keine klaren Signale.</div>';
    const sum = $("#sumRec");
    if (sum) sum.textContent = rows.length;
  }

  function showPanel(name) {
    $$(".tab").forEach(tab => tab.classList.toggle("active", tab.dataset.tab === name));
    $$(".panel").forEach(panel => panel.classList.toggle("active", panel.id === `panel-${name}`));
    if (name === "portfolio") loadPortfolio();
  }

  function openHoldingModal() { $("#holdModal").hidden = false; }
  function closeHoldingModal() { $("#holdModal").hidden = true; }

  async function analyzeTicker(event) {
    event.preventDefault();
    const ticker = $("#analyzeTicker").value.trim().toUpperCase();
    const is_etf = $("#analyzeEtf").checked;
    const out = $("#analyzeResult");
    out.textContent = "Analysiere…";
    try {
      const result = await api("/analyze", { method: "POST", body: JSON.stringify({ ticker, is_etf }) });
      out.innerHTML = `<div class="signal-card ${esc(result.signal)}"><strong>${esc(result.ticker)} · ${esc(result.signal)}</strong><p>Kurs ${result.price == null ? "—" : formatPrice(result.price)} · Stärke ${result.strength} · Confidence ${result.confidence ?? 0}%</p><p>${esc((result.reasons || []).join(" · "))}</p></div>`;
    } catch (e) { out.textContent = e.message; }
  }

  function openModal(ticker) {
    const s = allSignals[ticker];
    if (!s) return;

    const reasonsHtml = (s.reasons || []).map(r => `<li>${esc(r)}</li>`).join("") || "<li>—</li>";

    $("#modalBody").innerHTML = `
      <div class="modal-body">
        <h3>${esc(s.ticker)}</h3>
        <span class="badge ${s.signal} signal-badge">${s.signal.toUpperCase()} · Stärke ${s.strength}</span>
        ${s.is_etf ? '<span class="badge etf-tag">ETF</span>' : ""}

        <div class="metric-grid">
          <div class="metric"><div class="m-label">Kurs</div><div class="m-value">${s.price != null ? formatPrice(s.price) : "—"}</div></div>
          <div class="metric"><div class="m-label">Confidence (heuristisch)</div><div class="m-value">${s.confidence ?? 0}%</div></div>
          <div class="metric"><div class="m-label">RSI</div><div class="m-value">${s.rsi ?? "—"}</div></div>
          <div class="metric"><div class="m-label">MACD Hist</div><div class="m-value">${s.macd_hist ?? "—"}</div></div>
          <div class="metric"><div class="m-label">BB %</div><div class="m-value">${s.bb_pct != null ? (s.bb_pct * 100).toFixed(0) + "%" : "—"}</div></div>
          <div class="metric"><div class="m-label">SMA 20</div><div class="m-value">${s.sma20 != null ? formatPrice(s.sma20) : "—"}</div></div>
          <div class="metric"><div class="m-label">SMA 50</div><div class="m-value">${s.sma50 != null ? formatPrice(s.sma50) : "—"}</div></div>
          <div class="metric"><div class="m-label">SMA 200</div><div class="m-value">${s.sma200 != null ? formatPrice(s.sma200) : "—"}</div></div>
          <div class="metric"><div class="m-label">Session VWAP</div><div class="m-value">${s.vwap != null ? formatPrice(s.vwap) : "—"}</div></div>
          <div class="metric"><div class="m-label">ATR / Volatilität</div><div class="m-value">${s.atr != null ? formatPrice(s.atr) + " (" + (s.atr_percent ?? "—") + "%)" : "—"}</div></div>
          <div class="metric"><div class="m-label">Stochastic %K</div><div class="m-value">${s.stoch_k ?? "—"}</div></div>
          <div class="metric"><div class="m-label">ADX</div><div class="m-value">${s.adx ?? "—"}</div></div>
          <div class="metric"><div class="m-label">CCI</div><div class="m-value">${s.cci ?? "—"}</div></div>
          <div class="metric"><div class="m-label">Stop-Loss (ATR 1,5x)</div><div class="m-value">${s.stop_loss != null ? formatPrice(s.stop_loss) : "—"}</div></div>
          <div class="metric"><div class="m-label">Kursziel (ATR 2x)</div><div class="m-value">${s.target_price != null ? formatPrice(s.target_price) : "—"}</div></div>
          <div class="metric"><div class="m-label">Long / Short Score</div><div class="m-value">${s.long_score ?? 0} / ${s.short_score ?? 0}</div></div>
        </div>

        <strong style="font-size:0.85rem">Gründe</strong>
        <ul class="reason-list">${reasonsHtml}</ul>
      </div>
    `;
    $("#modal").hidden = false;
  }

  function closeModal() {
    $("#modal").hidden = true;
  }

  function formatPrice(p) {
    if (p == null) return "—";
    if (p >= 1000) return p.toLocaleString("de-DE", { maximumFractionDigits: 0 });
    if (p >= 10) return p.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return p.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  }

  function esc(str) {
    if (str == null) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function setStatus(ok) {
    const el = $("#apiStatus");
    el.className = "status " + (ok ? "ok" : "err");
    el.title = ok ? "Verbunden" : "Keine Verbindung";
  }

  $("#btnRefresh").addEventListener("click", forceRefresh);
  $$(".tab").forEach(tab => tab.addEventListener("click", () => showPanel(tab.dataset.tab)));
  $("#btnAddHolding").addEventListener("click", openHoldingModal);
  $("#holdClose").addEventListener("click", closeHoldingModal);
  $("#holdX").addEventListener("click", closeHoldingModal);
  $("#holdForm").addEventListener("submit", async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const payload = Object.fromEntries(form.entries());
    payload.quantity = Number(payload.quantity); payload.avg_cost = Number(payload.avg_cost);
    payload.is_etf = form.has("is_etf");
    try { await api("/portfolio/holding", { method: "POST", body: JSON.stringify(payload) }); event.currentTarget.reset(); closeHoldingModal(); await loadPortfolio(); }
    catch (e) { alert(e.message); }
  });
  $("#btnExportJson").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(portfolioData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob); const a = document.createElement("a");
    a.href = url; a.download = "stock-signal-portfolio.json"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $("#btnImportJson").addEventListener("click", () => {
    const input = document.createElement("input"); input.type = "file"; input.accept = "application/json";
    input.onchange = async () => {
      try { if (!input.files || !input.files[0]) return; const parsed = JSON.parse(await input.files[0].text()); if (!Array.isArray(parsed)) throw new Error("JSON muss ein Array sein"); await api("/portfolio", { method: "POST", body: JSON.stringify(parsed) }); await loadPortfolio(); }
      catch (e) { alert(e.message); }
    }; input.click();
  });
  $("#analyzeForm").addEventListener("submit", analyzeTicker);
  $("#modalClose").addEventListener("click", closeModal);
  $("#modalX").addEventListener("click", closeModal);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

  $$(".chip").forEach(chip => {
    chip.addEventListener("click", () => {
      $$(".chip").forEach(c => c.classList.remove("active"));
      chip.classList.add("active");
      currentFilter = chip.dataset.filter;
      renderSignals();
    });
  });

  loadSignals();
  setInterval(loadSignals, 60000);
})();
