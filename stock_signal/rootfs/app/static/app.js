(() => {
  "use strict";

  const API = "";

  let allSignals = {};
  let etfOpps = [];
  let currentFilter = "all";

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
      await fetch(`${API}/signals`);
      try {
        await fetch(`${API}/refresh`, { method: "POST" });
      } catch (_) {}
      await loadSignals();
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
          <div class="strength-row">
            <div class="strength-bar">
              <div class="strength-fill ${s.signal}" style="width:${Math.min(100, s.strength || 0)}%"></div>
            </div>
            <span class="strength-val">${s.strength ?? 0}</span>
          </div>
          <div class="reasons">${esc(reasons)}</div>
        </div>
      `;
    }).join("");

    grid.querySelectorAll(".signal-card").forEach(el => {
      el.addEventListener("click", () => openModal(el.dataset.ticker));
    });
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
          <div class="metric"><div class="m-label">RSI</div><div class="m-value">${s.rsi ?? "—"}</div></div>
          <div class="metric"><div class="m-label">MACD Hist</div><div class="m-value">${s.macd_hist ?? "—"}</div></div>
          <div class="metric"><div class="m-label">BB %</div><div class="m-value">${s.bb_pct != null ? (s.bb_pct * 100).toFixed(0) + "%" : "—"}</div></div>
          <div class="metric"><div class="m-label">SMA 20</div><div class="m-value">${s.sma20 != null ? formatPrice(s.sma20) : "—"}</div></div>
          <div class="metric"><div class="m-label">SMA 50</div><div class="m-value">${s.sma50 != null ? formatPrice(s.sma50) : "—"}</div></div>
          <div class="metric"><div class="m-label">SMA 200</div><div class="m-value">${s.sma200 != null ? formatPrice(s.sma200) : "—"}</div></div>
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
