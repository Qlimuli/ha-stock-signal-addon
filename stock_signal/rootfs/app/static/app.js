/* Stock & ETF Signals - frontend v1.6.1 */
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

  function renderSummary() {
    const list = Object.values(signals);
    function el(id, v) {
      const n = $(id);
      if (n) n.textContent = v;
    }
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
    const chips = indices
      .map(function (i) {
        const cls = i.direction === "up" ? "up" : i.direction === "down" ? "down" : "flat";
        return '<div class="idx-chip ' + cls + '"><span class="idx-name">' + escapeHtml(i.name) + '</span><span class="idx-chg">' + fmtPct(i.change_pct) + "</span></div>";
      })
      .join("");
    box.innerHTML =
      '<div class="market-head"><div class="mood-badge mood-' +
      escapeHtml(market.mood || "unknown") +
      '">' +
      escapeHtml(moodLabel(market.mood)) +
      '</div><p class="market-summary">' +
      escapeHtml(market.summary || "") +
      '</p></div><div class="idx-grid">' +
      (chips || '<div class="empty">Keine Indexdaten</div>') +
      "</div>";
  }

  function renderNews() {
    const box = $("#newsList");
    if (!box) return;
    if (!news.length) {
      box.innerHTML = '<div class="empty">Keine aktuellen Headlines - nach dem naechsten Analysezyklus erscheinen sie hier.</div>';
      return;
    }
    box.innerHTML = news
      .map(function (n) {
        const title = n.link
          ? '<a href="' + escapeHtml(n.link) + '" target="_blank" rel="noopener">' + escapeHtml(n.title) + "</a>"
          : escapeHtml(n.title);
        return '<article class="news-item"><div class="news-title">' + title + '</div><div class="news-meta">' + escapeHtml(n.publisher || "") + (n.related ? " · " + escapeHtml(n.related) : "") + "</div></article>";
      })
      .join("");
  }

  function oppCard(o) {
    const buy = o.signal === "long";
    return (
      '<div class="opp-card ' +
      (buy ? "buy" : "sell") +
      '" data-ticker="' +
      escapeHtml(o.ticker) +
      '"><div class="opp-top"><span class="opp-ticker">' +
      escapeHtml(o.ticker) +
      (o.is_etf ? ' <span class="badge kind">ETF</span>' : "") +
      '</span><span class="badge ' +
      (buy ? "long" : "short") +
      '">' +
      signalLabel(o.signal) +
      '</span></div><div class="opp-action">' +
      escapeHtml(o.action || (buy ? "Nachkauf pruefen" : "Absichern pruefen")) +
      '</div><div class="opp-price">' +
      fmtPrice(o.price) +
      '</div><div class="opp-scores"><span>Conf <strong>' +
      (o.confidence != null ? o.confidence : "-") +
      '%</strong></span><span>Staerke <strong>' +
      (o.strength != null ? o.strength : "-") +
      "</strong></span><span>" +
      biasLabel(o.short_term_bias) +
      "</span></div>" +
      (o.stop_loss != null ? '<div class="opp-risk">SL ~ ' + fmtPrice(o.stop_loss) + " · Ziel ~ " + fmtPrice(o.target_price) + "</div>" : "") +
      '<div class="opp-reasons">' +
      (o.reasons || []).slice(0, 3).map(escapeHtml).join(" · ") +
      "</div></div>"
    );
  }

  function renderClear() {
    const box = $("#clearOpps");
    if (!box) return;
    if (!clearOpps.length) {
      box.innerHTML = '<div class="empty">Keine klaren Kauf-/Verkaufschancen. Nur sehr starke Signale werden hier gezeigt.</div>';
      return;
    }
    box.innerHTML = clearOpps.map(oppCard).join("");
    $$(".opp-card", box).forEach(function (el) {
      on(el, "click", function () { openSignalModal(el.dataset.ticker); });
    });
  }

  function renderEtf() {
    const section = $("#etfSection");
    const grid = $("#etfGrid");
    if (!section || !grid) return;
    if (!etfOpps.length) {
      section.style.display = "none";
      return;
    }
    section.style.display = "";
    grid.innerHTML = etfOpps
      .map(function (e) {
        return '<div class="etf-card" data-ticker="' + escapeHtml(e.ticker) + '"><div class="ticker">' + escapeHtml(e.ticker) + '</div><div class="rec">' + escapeHtml(e.recommendation || "DCA pruefen") + '</div><div class="meta"><span>' + fmtPrice(e.price) + "</span><span>Conf " + e.confidence + "%</span><span>RSI " + (e.rsi != null ? e.rsi : "-") + "</span></div></div>";
      })
      .join("");
    $$(".etf-card", grid).forEach(function (el) {
      on(el, "click", function () { openSignalModal(el.dataset.ticker); });
    });
  }

  function renderPulse() {
    const box = $("#pulseGrid");
    if (!box) return;
    const list = Object.values(signals).sort(function (a, b) { return (b.confidence || 0) - (a.confidence || 0); });
    if (!list.length) {
      box.innerHTML = '<div class="empty">Noch keine Signale</div>';
      return;
    }
    box.innerHTML = list
      .map(function (s) {
        return '<button type="button" class="pulse-chip ' + s.signal + (s.clear_opportunity ? " clear" : "") + '" data-ticker="' + escapeHtml(s.ticker) + '"><span class="pulse-ticker">' + escapeHtml(s.ticker) + '</span><span class="pulse-sig">' + signalLabel(s.signal) + (s.clear_opportunity ? " · klar" : "") + '</span><span class="pulse-meta">' + fmtPrice(s.price) + " · " + (s.confidence || 0) + "%</span></button>";
      })
      .join("");
    $$(".pulse-chip", box).forEach(function (el) {
      on(el, "click", function () { openSignalModal(el.dataset.ticker); });
    });
  }

  function renderDashRecs() {
    const box = $("#dashRecs");
    if (!box) return;
    const rows = Object.values(signals)
      .filter(function (s) { return s.signal !== "neutral" || s.clear_opportunity; })
      .sort(function (a, b) { return (b.confidence || 0) - (a.confidence || 0); })
      .slice(0, 8);
    if (!rows.length) {
      box.innerHTML = '<div class="empty">Keine nennenswerten Signale</div>';
      return;
    }
    box.innerHTML = rows
      .map(function (s) {
        return '<div class="rec-item' + (s.clear_opportunity ? " clear-rec" : "") + '" data-ticker="' + escapeHtml(s.ticker) + '"><strong>' + escapeHtml(s.ticker) + '</strong> <span class="badge ' + s.signal + '">' + signalLabel(s.signal) + "</span> · Conf " + s.confidence + "% · " + biasLabel(s.short_term_bias) + '<div class="reasons">' + (s.reasons || []).slice(0, 2).map(escapeHtml).join(" · ") + "</div></div>";
      })
      .join("");
    $$(".rec-item", box).forEach(function (el) {
      on(el, "click", function () { openSignalModal(el.dataset.ticker); });
    });
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
    box.innerHTML = list
      .map(function (s) {
        const fill = Math.min(100, s.strength || 0);
        return '<div class="signal-card ' + s.signal + '" data-ticker="' + escapeHtml(s.ticker) + '"><div class="card-top"><span class="ticker-name">' + escapeHtml(s.ticker) + (s.is_etf ? ' <span class="badge etf-tag">ETF</span>' : "") + (s.clear_opportunity ? ' <span class="badge clear-tag">klar</span>' : "") + '</span><span class="badge ' + s.signal + '">' + signalLabel(s.signal) + '</span></div><div class="price">' + fmtPrice(s.price) + '</div><div class="strength-row"><div class="strength-bar"><div class="strength-fill ' + s.signal + '" style="width:' + fill + '%"></div></div><span class="strength-val">' + (s.strength || 0) + '</span></div><div class="meta-row"><span>Conf ' + s.confidence + "%</span><span>RSI " + (s.rsi != null ? s.rsi : "-") + "</span><span>ADX " + (s.adx != null ? s.adx : "-") + "</span><span>" + biasLabel(s.short_term_bias) + '</span></div><div class="reasons">' + (s.reasons || []).slice(0, 3).map(escapeHtml).join(" · ") + "</div></div>";
      })
      .join("");
    $$(".signal-card", box).forEach(function (el) {
      on(el, "click", function () { openSignalModal(el.dataset.ticker); });
    });
  }

  function openSignalModal(ticker) {
    const s = signals[ticker];
    if (!s) return;
    const body = $("#modalBody");
    const modal = $("#modal");
    if (!body || !modal) return;
    body.innerHTML =
      '<h3 style="margin-bottom:8px">' +
      escapeHtml(s.ticker) +
      ' <span class="badge ' +
      s.signal +
      '">' +
      signalLabel(s.signal) +
      "</span>" +
      (s.clear_opportunity ? ' <span class="badge clear-tag">klares Signal</span>' : "") +
      '</h3><p class="muted">' +
      escapeHtml(s.bias_note || "") +
      '</p><div class="metric-grid">' +
      '<div class="metric"><div class="m-label">Kurs</div><div class="m-value">' +
      fmtPrice(s.price) +
      "</div></div>" +
      '<div class="metric"><div class="m-label">Confidence</div><div class="m-value">' +
      s.confidence +
      "%</div></div>" +
      '<div class="metric"><div class="m-label">RSI</div><div class="m-value">' +
      (s.rsi != null ? s.rsi : "-") +
      "</div></div>" +
      '<div class="metric"><div class="m-label">ADX</div><div class="m-value">' +
      (s.adx != null ? s.adx : "-") +
      "</div></div>" +
      '<div class="metric"><div class="m-label">Stop</div><div class="m-value">' +
      fmtPrice(s.stop_loss) +
      "</div></div>" +
      '<div class="metric"><div class="m-label">Ziel</div><div class="m-value">' +
      fmtPrice(s.target_price) +
      "</div></div></div>" +
      '<ul class="reason-list">' +
      (s.reasons || []).map(function (r) { return "<li>" + escapeHtml(r) + "</li>"; }).join("") +
      '</ul><p class="small-note">Keine Finanzberatung.</p>';
    modal.hidden = false;
  }

  function renderPortfolio() {
    const body = $("#pfBody");
    const totals = $("#pfTotals");
    if (!body || !totals) return;
    if (!portfolio) {
      body.innerHTML = "";
      totals.textContent = "-";
      return;
    }
    const holdings = portfolio.holdings || [];
    const mv = portfolio.market_value;
    const pnl = portfolio.pnl;
    totals.innerHTML =
      "<span>Wert: <strong>" +
      (mv != null ? fmtPrice(mv) : "-") +
      '</strong></span><span class="' +
      ((pnl || 0) >= 0 ? "status-ok" : "status-error") +
      '">P&L: ' +
      (pnl != null ? fmtPrice(pnl) : "-") +
      "</span>";
    if (!holdings.length) {
      body.innerHTML = '<tr><td colspan="8" class="empty">Keine Positionen</td></tr>';
      return;
    }
    body.innerHTML = holdings
      .map(function (h) {
        const sig = signals[h.ticker] || {};
        return (
          "<tr><td><strong>" +
          escapeHtml(h.ticker) +
          "</strong>" +
          (h.is_etf ? " <span class='badge kind'>ETF</span>" : "") +
          "</td><td>" +
          h.quantity +
          "</td><td>" +
          fmtPrice(h.avg_cost) +
          "</td><td>" +
          fmtPrice(h.price != null ? h.price : sig.price) +
          "</td><td>" +
          fmtPrice(h.market_value) +
          '</td><td class="' +
          ((h.pnl || 0) >= 0 ? "status-ok" : "status-error") +
          '">' +
          fmtPrice(h.pnl) +
          '</td><td><span class="badge ' +
          (sig.signal || "neutral") +
          '">' +
          signalLabel(sig.signal || "neutral") +
          '</span></td><td><button type="button" class="btn btn-secondary btn-del" data-ticker="' +
          escapeHtml(h.ticker) +
          '">x</button></td></tr>'
        );
      })
      .join("");
    $$(".btn-del", body).forEach(function (btn) {
      on(btn, "click", async function () {
        if (!confirm("Position " + btn.dataset.ticker + " loeschen?")) return;
        try {
          portfolio = await api("portfolio/holding/" + encodeURIComponent(btn.dataset.ticker), { method: "DELETE" });
          renderPortfolio();
          loadRecommendations();
        } catch (e) {
          alert(e.message);
        }
      });
    });
  }

  function renderPfRecs() {
    const box = $("#pfRecs");
    if (!box) return;
    if (!recommendations.length) {
      box.innerHTML = '<div class="empty">Noch keine Daten</div>';
      return;
    }
    box.innerHTML = recommendations
      .slice(0, 10)
      .map(function (r) {
        const sig = r.signal || (signals[r.ticker] || {}).signal || "neutral";
        const conf = r.confidence != null ? r.confidence : (signals[r.ticker] || {}).confidence;
        return '<div class="rec-item"><strong>' + escapeHtml(r.ticker) + '</strong> <span class="badge ' + sig + '">' + signalLabel(sig) + "</span> · Conf " + (conf != null ? conf : "-") + "%</div>";
      })
      .join("");
  }

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
      renderEtf();
      renderPulse();
      renderDashRecs();
      renderSignals();
    } catch (e) {
      const st = $("#apiStatus");
      if (st) st.className = "status err";
      console.error("loadAll", e);
      const box = $("#pulseGrid");
      if (box && !Object.keys(signals).length) {
        box.innerHTML = '<div class="empty">API-Fehler: ' + escapeHtml(e.message) + "</div>";
      }
    }
  }

  async function loadPortfolio() {
    try {
      portfolio = await api("portfolio");
      renderPortfolio();
    } catch (e) {
      console.error("portfolio", e);
    }
  }

  async function loadRecommendations() {
    try {
      const data = await api("recommendations");
      recommendations = data.recommendations || [];
      renderPfRecs();
    } catch (e) {
      console.error("recommendations", e);
    }
  }

  async function loadSystem() {
    const box = $("#systemStatus");
    if (!box) return;
    try {
      const h = await api("health");
      box.innerHTML =
        '<div class="status-line"><span>Status</span><strong class="status-ok">' +
        escapeHtml(h.status) +
        '</strong></div><div class="status-line"><span>Zyklus</span><strong>' +
        escapeHtml(h.cycle_status) +
        '</strong></div><div class="status-line"><span>Signale</span><strong>' +
        h.signal_count +
        '</strong></div><div class="status-line"><span>MQTT</span><strong>' +
        (h.mqtt_enabled ? (h.mqtt_connected ? "verbunden" : "getrennt") : "aus") +
        '</strong></div><div class="status-line"><span>Update</span><strong>' +
        fmtTime(h.last_update) +
        "</strong></div>";
    } catch (e) {
      box.innerHTML = '<div class="status-error">Status nicht erreichbar</div>';
    }
  }

  $$(".tab").forEach(function (tab) {
    on(tab, "click", function (ev) {
      ev.preventDefault();
      setActiveTab(tab.dataset.tab);
      if (tab.dataset.tab === "portfolio") {
        loadPortfolio();
        loadRecommendations();
      }
      if (tab.dataset.tab === "settings") loadSystem();
    });
  });

  $$(".chip").forEach(function (chip) {
    on(chip, "click", function () {
      filter = chip.dataset.filter;
      $$(".chip").forEach(function (c) {
        c.classList.toggle("active", c === chip);
      });
      renderSignals();
    });
  });

  on($("#btnRefresh"), "click", async function () {
    const btn = $("#btnRefresh");
    if (btn) btn.classList.add("loading");
    try {
      await api("refresh", { method: "POST" });
      setTimeout(loadAll, 2500);
      setTimeout(loadAll, 8000);
    } catch (e) {
      alert(e.message);
    } finally {
      setTimeout(function () {
        if (btn) btn.classList.remove("loading");
      }, 1500);
    }
  });

  on($("#analyzeForm"), "submit", async function (ev) {
    ev.preventDefault();
    const tickerEl = $("#analyzeTicker");
    const etfEl = $("#analyzeEtf");
    const out = $("#analyzeResult");
    if (!tickerEl || !out) return;
    const ticker = tickerEl.value.trim().toUpperCase();
    const is_etf = etfEl ? etfEl.checked : false;
    out.innerHTML = '<div class="loading">Analysiere ...</div>';
    try {
      const s = await api("analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker: ticker, is_etf: is_etf }),
      });
      signals[s.ticker] = s;
      out.innerHTML =
        '<div class="signal-card ' +
        s.signal +
        '"><div class="card-top"><span class="ticker-name">' +
        escapeHtml(s.ticker) +
        '</span><span class="badge ' +
        s.signal +
        '">' +
        signalLabel(s.signal) +
        '</span></div><div class="price">' +
        fmtPrice(s.price) +
        '</div><div class="meta-row">Conf ' +
        s.confidence +
        "% · " +
        biasLabel(s.short_term_bias) +
        (s.clear_opportunity ? " · <strong>klares Signal</strong>" : "") +
        '</div><p class="muted">' +
        escapeHtml(s.bias_note || "") +
        '</p><ul class="reason-list">' +
        (s.reasons || []).map(function (r) { return "<li>" + escapeHtml(r) + "</li>"; }).join("") +
        "</ul></div>";
    } catch (e) {
      out.innerHTML = '<div class="empty">' + escapeHtml(e.message) + "</div>";
    }
  });

  on($("#btnAddHolding"), "click", function () {
    const f = $("#holdForm");
    const m = $("#holdModal");
    if (f) f.reset();
    if (m) m.hidden = false;
  });
  on($("#holdClose"), "click", function () {
    const m = $("#holdModal");
    if (m) m.hidden = true;
  });
  on($("#holdX"), "click", function () {
    const m = $("#holdModal");
    if (m) m.hidden = true;
  });
  on($("#holdForm"), "submit", async function (ev) {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const payload = {
      ticker: String(fd.get("ticker") || "").trim().toUpperCase(),
      name: String(fd.get("name") || "").trim(),
      quantity: Number(fd.get("quantity")),
      avg_cost: Number(fd.get("avg_cost")),
      is_etf: fd.get("is_etf") === "on",
    };
    try {
      portfolio = await api("portfolio/holding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const m = $("#holdModal");
      if (m) m.hidden = true;
      renderPortfolio();
      loadRecommendations();
    } catch (e) {
      alert(e.message);
    }
  });

  on($("#btnExportJson"), "click", async function () {
    try {
      const data = await api("portfolio");
      const blob = new Blob([JSON.stringify(data.holdings || [], null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "portfolio.json";
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      alert(e.message);
    }
  });

  on($("#btnImportJson"), "click", function () {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.onchange = async function () {
      const file = input.files && input.files[0];
      if (!file) return;
      try {
        const arr = JSON.parse(await file.text());
        portfolio = await api("portfolio", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(arr),
        });
        renderPortfolio();
        loadRecommendations();
      } catch (e) {
        alert(e.message || "Import fehlgeschlagen");
      }
    };
    input.click();
  });

  on($("#btnCopyMcp"), "click", async function () {
    const urlEl = $("#scalableMcpUrl");
    if (!urlEl) return;
    const url = urlEl.value;
    try {
      await navigator.clipboard.writeText(url);
      const b = $("#btnCopyMcp");
      if (b) {
        b.textContent = "Kopiert";
        setTimeout(function () {
          b.textContent = "Kopieren";
        }, 1500);
      }
    } catch (e) {
      prompt("MCP-URL kopieren:", url);
    }
  });

  on($("#modalClose"), "click", function () {
    const m = $("#modal");
    if (m) m.hidden = true;
  });
  on($("#modalX"), "click", function () {
    const m = $("#modal");
    if (m) m.hidden = true;
  });

  async function loadPush() {
    try {
      const s = await api("push/settings");
      const pe = $("#pushEnabled");
      const pl = $("#pushLong");
      const ps = $("#pushShort");
      const pc = $("#pushConfidence");
      const pcv = $("#pushConfidenceValue");
      const pst = $("#pushStatus");
      const ph = $("#pushHelp");
      if (pe) pe.checked = !!s.enabled;
      if (pl) pl.checked = !!s.notify_long;
      if (ps) ps.checked = !!s.notify_short;
      if (pc) pc.value = s.min_confidence != null ? s.min_confidence : 65;
      if (pcv) pcv.textContent = (s.min_confidence != null ? s.min_confidence : 65) + " %";
      if (pst) pst.textContent = (s.subscriptions || 0) + " Geraet(e)";
      if (ph) ph.textContent = s.subscriptions ? "Geraete registriert." : "Noch kein Geraet registriert.";
    } catch (e) {}
  }

  on($("#pushConfidence"), "input", function () {
    const pc = $("#pushConfidence");
    const pcv = $("#pushConfidenceValue");
    if (pc && pcv) pcv.textContent = pc.value + " %";
  });

  on($("#btnSavePush"), "click", async function () {
    try {
      await api("push/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: $("#pushEnabled") ? $("#pushEnabled").checked : true,
          notify_long: $("#pushLong") ? $("#pushLong").checked : true,
          notify_short: $("#pushShort") ? $("#pushShort").checked : true,
          min_confidence: Number($("#pushConfidence") ? $("#pushConfidence").value : 65),
        }),
      });
      loadPush();
    } catch (e) {
      alert(e.message);
    }
  });

  on($("#btnTestPush"), "click", async function () {
    try {
      await api("push/test", { method: "POST" });
      alert("Test gesendet (falls Geraete registriert).");
    } catch (e) {
      alert(e.message);
    }
  });

  on($("#btnEnablePush"), "click", async function () {
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        alert("Push wird von diesem Browser nicht unterstuetzt.");
        return;
      }
      const reg = await navigator.serviceWorker.register(BASE + "sw.js");
      const keyData = await api("push/public-key");
      if ((await Notification.requestPermission()) !== "granted") {
        alert("Benachrichtigungen nicht erlaubt.");
        return;
      }
      function urlBase64ToUint8Array(base64String) {
        const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
        const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
        const raw = atob(base64);
        const out = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; ++i) out[i] = raw.charCodeAt(i);
        return out;
      }
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(keyData.publicKey),
      });
      await api("push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sub.toJSON()),
      });
      loadPush();
      alert("Push aktiviert.");
    } catch (e) {
      alert(e.message || "Push-Setup fehlgeschlagen");
    }
  });

  console.info("[stock-signal] BASE=", BASE);
  loadAll();
  loadPortfolio();
  loadRecommendations();
  loadPush();
  setInterval(loadAll, 60000);
})();
