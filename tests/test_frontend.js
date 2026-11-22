const fs = require("fs");
const vm = require("vm");
const assert = require("assert");

class Element {
  constructor(dataset = {}) {
    this.dataset = dataset;
    this.className = "";
    this.classList = {
      values: new Set(),
      add: (...xs) => xs.forEach(x => this.classList.values.add(x)),
      remove: (...xs) => xs.forEach(x => this.classList.values.delete(x)),
      toggle: (x, force) => {
        const on = force === undefined ? !this.classList.values.has(x) : force;
        if (on) this.classList.values.add(x); else this.classList.values.delete(x);
        return on;
      }
    };
    this.listeners = {};
    this.style = {};
    this.innerHTML = "";
    this.textContent = "";
    this.hidden = false;
    this.value = "";
    this.checked = false;
  }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  click() { if (this.listeners.click) this.listeners.click({ preventDefault() {} }); }
  reset() {}
}

const selectors = new Map();
const one = selector => {
  if (!selectors.has(selector)) selectors.set(selector, new Element());
  return selectors.get(selector);
};
const tabs = ["dashboard", "signals", "portfolio", "analyze"].map(x => new Element({tab:x}));
const panels = ["dashboard", "signals", "portfolio", "analyze"].map(x => {
  const el = new Element(); el.id = "panel-" + x; return el;
});
const chips = ["all", "long", "short", "neutral", "etf"].map(x => new Element({filter:x}));
const document = {
  querySelector: one,
  querySelectorAll: selector => selector === ".tab" ? tabs : selector === ".panel" ? panels : selector === ".chip" ? chips : [],
  addEventListener() {},
  createElement: () => new Element()
};
const calls = [];
async function fetch(url) {
  calls.push(url);
  let data = {};
  if (url.endsWith("/signals")) data = {signals:{}, etf_opportunities:[], cycle_status:"idle", last_update:null};
  else if (url.endsWith("/portfolio")) data = {holdings:[], market_value:0, pnl:0};
  else if (url.endsWith("/recommendations")) data = {recommendations:[]};
  return {ok:true, status:200, json:async()=>data};
}
const context = {
  document, fetch, console, setInterval:()=>0,
  setTimeout:fn=>{fn();return 0;},
  FormData: class { entries(){return [];} has(){return false;} },
  Blob: class {}, URL:{createObjectURL:()=>"",revokeObjectURL(){}},
  confirm:()=>true, alert:()=>{}, window:{}
};
vm.runInNewContext(fs.readFileSync("stock_signal/rootfs/app/static/app.js","utf8"), context);
setImmediate(() => {
  assert(tabs.every(t => typeof t.listeners.click === "function"), "tab click handlers registered");
  assert(one("#btnRefresh").listeners.click, "refresh handler registered");
  assert(one("#holdForm").listeners.submit, "portfolio form handler registered");
  tabs[2].click();
  assert(tabs[2].classList.values.has("active"), "portfolio tab becomes active");
  assert(panels[2].classList.values.has("active"), "portfolio panel becomes active");
  assert(calls.some(x => x.endsWith("/signals")), "initial signals request executed");
  assert(calls.some(x => x.endsWith("/portfolio")), "portfolio request executed");
  assert(calls.some(x => x.endsWith("/recommendations")), "recommendations request executed");
  console.log("Frontend startup, navigation, initial data loading: PASS");
});
