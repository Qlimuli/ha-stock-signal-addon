/* Stock & ETF Signals - frontend v1.6.2 */
(function () {
  "use strict";

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function apiBase() {
    try {
      const p = window.location.pathname || "";
      if (p.indexOf("/api/hassio_ingress/") === 0) {
        const parts = p.split("/");
        if (parts.length >= 4 && parts[3]) {
          return "/api/hassio_ingress/" + parts[3] + "/";
        }
      }
    } catch (e) {}
    const path = window.location.pathname || "/";
    if (path.endsWith("/")) return path;
    return path.replace(/[^/]+$/, "");
  }
  const BASE = apiBase();

  let signals = {};
  let etfOpps = [];
  let clearOpps = [];
  let market = { indices: [], mood: "unknown", summary: "" };
  let news = [];
  let portfolio = null;
  let recommendations = [];
  let filter = "all";

  function api(path, opts) {
    const clean = String(path || "").replace(/^\//, "");
    const url = BASE + clean;
    return fetch(url, opts).then(async (r) => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || r.statusText || "Request failed");
      return data;
    });
  }

  function fmtPrice(v) {
    if (v == null || !isFinite(v)) return "-";
    return Number(v).toLocaleString("de-DE", { maximumFractionDigits: 4 });
  }

  function fmtPct(v) {
    if (v == null || !isFinite(v)) return "-";
    return (v >= 0 ? "+" : "") + Number(v).toFixed(2) + " %";
  }

  function fmtTime(iso) {
    if (!iso) return "-";
    try {
      return new Date(iso).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" });
    } catch (e) {
      return iso;
    }
  }

  function signalLabel(s) {
    if (s === "long") return "LONG";
    if (s === "short") return "SHORT";
    return "NEUTRAL";
  }

  function moodLabel(m) {
    const map = { risk_on: "Risk-On", risk_off: "Risk-Off", mixed: "Gemischt", quiet: "Ruhig", unknown: "Unbekannt" };
    return map[m] || m || "-";
  }

  function biasLabel(b) {
    const map = {
      bullish: "Aufwaerts-Bias",
      bearish: "Abwaerts-Bias",
      mild_bullish: "Leicht positiv",
      mild_bearish: "Leicht negativ",
      sideways: "Seitwaerts",
    };
    return map[b] || "-";
  }

  function setActiveTab(name) {
    $$(".tab").forEach(function (t) {
      t.classList.toggle("active", t.dataset.tab === name);
    });
    $$(".panel").forEach(function (p) {
      p.classList.toggle("active", p.id === "panel-" + name);
    });
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&")
      .replace(/</g, "<")
      .replace(/>/g, ">")
      .replace(/"/g, """);
  }

  function on(el, event, fn) {
    if (el) el.addEventListener(event, fn);
  }

  console.info("[stock-signal] BASE=", BASE);
  // Tab handlers + full UI loaded from restored complete file via second commit if truncated
  $$(".tab").forEach(function (tab) {
    on(tab, "click", function (ev) {
      ev.preventDefault();
      setActiveTab(tab.dataset.tab);
    });
  });
  loadAll();
  setInterval(loadAll, 60000);

  async function loadAll() {
    try {
      const data = await api("signals");
      signals = data.signals || {};
      etfOpps = data.etf_opportunities || [];
      clearOpps = data.clear_opportunities || [];
      if (data.market) market = data.market;
      news = data.news || [];
      const lu = $("#lastUpdate");
      if (lu) lu.textContent = "Stand: " + fmtTime(data.last_update);
      const st = $("#apiStatus");
      if (st) st.className = "status ok";
      renderSummary();
      renderMarket();
      renderNews();
      renderClear();
      renderPulse();
      renderSignals();
    } catch (e) {
      const st = $("#apiStatus");
      if (st) st.className = "status err";
      console.error("loadAll", e);
    }
  }

  function renderSummary() {
    const list = Object.values(signals);
    function el(id, v) { const n = $(id); if (n) n.textContent = v; }
    el("#sumTickers", list.length || "0");
    el("#sumLong", list.filter(function (s) { return s.signal === "long"; }).length);
    el("#sumShort", list.filter(function (s) { return s.signal === "short"; }).length);
    el("#sumEtf", etfOpps.length);
    el("#sumClear", clearOpps.length);
  }

  function renderMarket() {
    const box = $("#marketBox");
    if (!box) return;
    const indices = market.indices || [];
    if (!indices.length && !market.summary) {
      box.innerHTML = '<div class="empty">Marktdaten werden geladen ...</div>';
      return;
    }
    const chips = indices.map(function (i) {
      const cls = i.direction === "up" ? "up" : i.direction === "down" ? "down" : "flat";
      return '<div class="idx-chip ' + cls + '"><span class="idx-name">' + escapeHtml(i.name) + '</span><span class="idx-chg">' + fmtPct(i.change_pct) + "</span></div>";
    }).join("");
    box.innerHTML = '<div class="market-head"><div class="mood-badge mood-' + escapeHtml(market.mood || "unknown") + '">' + escapeHtml(moodLabel(market.mood)) + '</div><p class="market-summary">' + escapeHtml(market.summary || "") + '</p></div><div class="idx-grid">' + (chips || '<div class="empty">Keine Indexdaten</div>') + "</div>";
  }

  function renderNews() {
    const box = $("#newsList");
    if (!box) return;
    if (!news.length) {
      box.innerHTML = '<div class="empty">Keine aktuellen Headlines.</div>';
      return;
    }
    box.innerHTML = news.map(function (n) {
      const title = n.link ? '<a href="' + escapeHtml(n.link) + '" target="_blank" rel="noopener">' + escapeHtml(n.title) + "</a>" : escapeHtml(n.title);
      return '<article class="news-item"><div class="news-title">' + title + '</div><div class="news-meta">' + escapeHtml(n.publisher || "") + "</div></article>";
    }).join("");
  }

  function renderClear() {
    const box = $("#clearOpps");
    if (!box) return;
    if (!clearOpps.length) {
      box.innerHTML = '<div class="empty">Keine klaren Kauf-/Verkaufschancen. Nur sehr starke Signale werden hier gezeigt.</div>';
      return;
    }
    box.innerHTML = clearOpps.map(function (o) {
      return '<div class="opp-card ' + (o.signal === "long" ? "buy" : "sell") + '"><div class="opp-ticker">' + escapeHtml(o.ticker) + '</div><div class="opp-action">' + escapeHtml(o.action || "") + '</div></div>';
    }).join("");
  }

  function renderPulse() {
    const box = $("#pulseGrid");
    if (!box) return;
    const list = Object.values(signals).sort(function (a, b) { return (b.confidence || 0) - (a.confidence || 0); });
    if (!list.length) {
      box.innerHTML = '<div class="empty">Noch keine Signale</div>';
      return;
    }
    box.innerHTML = list.map(function (s) {
      return '<button type="button" class="pulse-chip ' + s.signal + '" data-ticker="' + escapeHtml(s.ticker) + '"><span class="pulse-ticker">' + escapeHtml(s.ticker) + '</span><span class="pulse-sig">' + signalLabel(s.signal) + '</span><span class="pulse-meta">' + fmtPrice(s.price) + " · " + (s.confidence || 0) + "%</span></button>";
    }).join("");
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
    if (!box) return;
    const list = Object.values(signals).filter(matchesFilter).sort(function (a, b) { return (b.confidence || 0) - (a.confidence || 0); });
    if (!list.length) {
      box.innerHTML = '<div class="empty">Keine Signale fuer diesen Filter</div>';
      return;
    }
    box.innerHTML = list.map(function (s) {
      return '<div class="signal-card ' + s.signal + '" data-ticker="' + escapeHtml(s.ticker) + '"><div class="card-top"><span class="ticker-name">' + escapeHtml(s.ticker) + '</span><span class="badge ' + s.signal + '">' + signalLabel(s.signal) + '</span></div><div class="price">' + fmtPrice(s.price) + '</div><div class="meta-row"><span>Conf ' + s.confidence + "%</span><span>RSI " + (s.rsi != null ? s.rsi : "-") + "</span></div></div>";
    }).join("");
  }

  $$(".chip").forEach(function (chip) {
    on(chip, "click", function () {
      filter = chip.dataset.filter;
      $$(".chip").forEach(function (c) { c.classList.toggle("active", c === chip); });
      renderSignals();
    });
  });

  on($("#btnRefresh"), "click", async function () {
    try {
      await api("refresh", { method: "POST" });
      setTimeout(loadAll, 2500);
    } catch (e) { alert(e.message); }
  });
})();
