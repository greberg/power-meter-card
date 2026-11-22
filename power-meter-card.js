// Power Meter Lovelace card for a Currently One (MQTT) power meter.
//
// Same look as the Price Heater cards: plain custom element, no build step,
// no external imports. Copy to /config/www/ and add as a dashboard resource:
//   url: /local/power-meter-card.js   type: JavaScript module
//
// Minimal config:
//   type: custom:power-meter-card
//   device: 0123456789ab   (suffix of sensor.power_<device>)
//
// Entities default to sensor.<key>_<device>; override any of them under
// `entities:` (keys: power, total, returning, l1-l3, i1-i3, u1-u3).
// Optional `temperature:` sensor adds the daily mean temperature to the
// energy-per-day chart.

const VERSION = "1.2.0";
const HISTORY_REFRESH_MS = 5 * 60 * 1000;
const MISSING = new Set(["unavailable", "unknown", "", "undefined", "null"]);
const KEYS = ["power", "total", "returning", "l1", "l2", "l3", "i1", "i2", "i3", "u1", "u2", "u3"];
const PHASES = [1, 2, 3];

const STRINGS = {
  en: {
    title: "Power meter",
    using: "Using now",
    exporting: "Exporting {power}",
    idle: "No consumption",
    total: "Meter reading",
    today: "Today",
    phases: "Phases",
    fuse: "Fuse {fuse} A",
    chart: "Power, last {hours} h",
    days: "Energy per day",
    total_power: "Total",
    no_device: "Set device (e.g. 0123456789ab) or entities in the card config.",
    missing: "Entity {entity} not found.",
    max_phase: "Highest load {phase}",
    chart_empty: "No history yet.",
    avg: "{min} min average",
    mean_temp: "Mean temp.",
  },
  sv: {
    title: "Elmätare",
    using: "Förbrukning nu",
    exporting: "Exporterar {power}",
    idle: "Ingen förbrukning",
    total: "Mätarställning",
    today: "Idag",
    phases: "Faser",
    fuse: "Säkring {fuse} A",
    chart: "Effekt, senaste {hours} h",
    days: "Energi per dag",
    total_power: "Totalt",
    no_device: "Ange device (t.ex. 0123456789ab) eller entities i kortets konfiguration.",
    missing: "Entiteten {entity} hittades inte.",
    max_phase: "Högst belastad {phase}",
    chart_empty: "Ingen historik än.",
    avg: "medel per {min} min",
    mean_temp: "Medeltemp.",
  },
};

const PHASE_COLORS = {
  1: "var(--info-color, #039be5)",
  2: "var(--purple-color, #926bc7)",
  3: "var(--teal-color, #009688)",
};

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const toNumber = (value) => {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const isMissing = (s) => !s || MISSING.has(String(s.state));

/** Factor that turns a sensor's unit into W (power) or kWh (energy). */
function unitFactor(stateObj, kind) {
  const unit = String(stateObj?.attributes?.unit_of_measurement || "").trim();
  if (kind === "power") return { kW: 1000, MW: 1e6, W: 1 }[unit] ?? 1;
  if (kind === "energy") return { Wh: 0.001, kWh: 1, MWh: 1000 }[unit] ?? 1;
  return 1;
}

const KIND = { power: "power", returning: "power", l1: "power", l2: "power", l3: "power", total: "energy" };

const rowTime = (row) => (row.lu !== undefined ? row.lu * 1000 : row.lc !== undefined ? row.lc * 1000 : Date.parse(row.last_changed || row.last_updated));
const rowState = (row) => (row.s !== undefined ? row.s : row.state);

function niceMax(value) {
  if (!(value > 0)) return 1000;
  const mag = 10 ** Math.floor(Math.log10(value));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * mag >= value) return m * mag;
  return 10 * mag;
}

/** Time-weighted mean of a step series in n buckets of `size` ms from t0; null where there is no data. */
function bucketMeans(pts, t0, t1, size, n) {
  const sum = new Array(n).fill(0);
  const dur = new Array(n).fill(0);
  for (let i = 0; i < pts.length; i++) {
    let a = Math.max(pts[i].t, t0);
    const b = Math.min(i + 1 < pts.length ? pts[i + 1].t : t1, t1);
    while (a < b) {
      const k = Math.min(n - 1, Math.floor((a - t0) / size));
      const e = Math.min(b, t0 + (k + 1) * size);
      if (e <= a) break;
      sum[k] += pts[i].v * (e - a);
      dur[k] += e - a;
      a = e;
    }
  }
  return sum.map((v, k) => (dur[k] > 0 ? v / dur[k] : null));
}

const STYLES = `
  :host { display: block; }
  ha-card { height: 100%; overflow: hidden; }
  .header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 16px 0; }
  .title { font-size: 16px; font-weight: 500; color: var(--primary-text-color); display: flex; align-items: center; gap: 8px; min-width: 0; }
  .title span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .title ha-icon { color: var(--state-icon-color); --mdc-icon-size: 20px; }
  .content { padding: 8px 16px 16px; display: flex; flex-direction: column; gap: 12px; }
  .hero { display: flex; align-items: center; gap: 16px; }
  .hero .big { font-size: 40px; line-height: 44px; font-weight: 400; white-space: nowrap; color: var(--primary-text-color); }
  .unit { font-size: 0.5em; color: var(--secondary-text-color); margin-left: 2px; }
  button.link.meter { display: flex; align-items: center; justify-content: center; width: 52px; height: 52px; border-radius: 50%;
    background: color-mix(in srgb, var(--disabled-text-color, #9e9e9e) 16%, transparent); color: var(--disabled-text-color, #9e9e9e); flex: none; }
  button.link.meter.on { background: color-mix(in srgb, var(--warning-color, #ffa600) 18%, transparent); color: var(--warning-color, #ffa600); }
  button.link.meter.export { background: color-mix(in srgb, var(--success-color, #43a047) 18%, transparent); color: var(--success-color, #43a047); }
  button.link.meter ha-icon { --mdc-icon-size: 30px; }
  button.link.side { margin-left: auto; align-items: flex-end; text-align: right; }
  .side .value { font-size: 22px; line-height: 28px; white-space: nowrap; }
  .reason { font-size: 14px; color: var(--secondary-text-color); }
  .reason.export { color: var(--success-color, #43a047); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(96px, 1fr)); gap: 8px; }
  .stat { display: flex; flex-direction: column; min-width: 0; text-align: left; }
  .label { color: var(--secondary-text-color); font-size: 12px; line-height: 16px; }
  .value { font-size: 16px; color: var(--primary-text-color); overflow-wrap: anywhere; }
  button.link { all: unset; cursor: pointer; display: inline-flex; flex-direction: column; min-width: 0; border-radius: 6px; }
  button.link:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
  button.link:hover .value { text-decoration: underline dotted; }
  .chip { font: inherit; font-size: 13px; line-height: 18px; padding: 4px 10px; border-radius: 16px; display: inline-flex; align-items: center; gap: 4px;
    border: 1px solid var(--divider-color); background: transparent; color: var(--primary-text-color); white-space: nowrap; }
  .chip ha-icon { --mdc-icon-size: 16px; }
  .chip.warning { border-color: var(--warning-color, #ffa600); color: var(--warning-color, #ffa600); }
  .chip.error { border-color: var(--error-color, #db4437); color: var(--error-color, #db4437); }
  .sub { color: var(--secondary-text-color); font-size: 11px; }
  .divider { height: 1px; background: var(--divider-color); }
  .section { font-size: 12px; color: var(--secondary-text-color); display: flex; justify-content: space-between; gap: 8px; }
  .phases { display: flex; flex-direction: column; gap: 10px; }
  button.link.phase { display: grid; grid-template-columns: 24px 1fr auto; align-items: center; gap: 4px 10px; width: 100%; }
  .phase .name { font-size: 13px; font-weight: 500; color: var(--primary-text-color); }
  .phase .name i { display: inline-block; width: 4px; height: 14px; border-radius: 2px; margin-right: 4px; vertical-align: -2px; }
  .phase .nums { font-size: 14px; white-space: nowrap; color: var(--primary-text-color); text-align: right; }
  .phase .meta { grid-column: 2 / 4; display: flex; justify-content: space-between; font-size: 11px; color: var(--secondary-text-color); margin-top: -2px; }
  .gauge { position: relative; height: 10px; border-radius: 5px; background: var(--divider-color); overflow: hidden; }
  .gauge .fill { position: absolute; top: 0; bottom: 0; left: 0; border-radius: 5px; background: var(--success-color, #43a047); opacity: .75; }
  .gauge .fill.warning { background: var(--warning-color, #ffa600); }
  .gauge .fill.error { background: var(--error-color, #db4437); }
  .legend { display: flex; flex-wrap: wrap; gap: 6px 8px; font-size: 11px; color: var(--secondary-text-color); }
  .legend i { display: inline-block; width: 12px; height: 8px; margin-right: 4px; vertical-align: middle; border-radius: 2px; }
  .legend i.line { height: 2px; }
  .empty { color: var(--secondary-text-color); font-size: 14px; padding: 8px 0; }
  button.link.chart { display: block; width: 100%; }
  svg { display: block; width: 100%; height: auto; overflow: visible; }
  svg text { font-size: 10px; fill: var(--secondary-text-color); font-family: inherit; }
  .grid-line { stroke: var(--divider-color); stroke-width: 1; }
  .now { stroke: var(--primary-text-color); stroke-width: 1; opacity: 0.6; }
  svg.power-chart { touch-action: pan-y; cursor: crosshair; }
  svg.power-chart text { font-size: 11px; }
  .chart-wrap { position: relative; }
  .stack { opacity: 0.45; stroke: none; }
  .stack-line { fill: none; stroke-width: 1.5; stroke-linejoin: round; }
  .cursor { stroke: var(--primary-text-color); stroke-width: 1; opacity: 0.5; pointer-events: none; }
  .tip { position: absolute; top: 0; pointer-events: none; display: flex; flex-direction: column; gap: 2px; min-width: 120px;
    padding: 6px 8px; border-radius: 8px; font-size: 12px; line-height: 16px; color: var(--primary-text-color);
    background: var(--card-background-color, #fff); border: 1px solid var(--divider-color); box-shadow: 0 2px 6px rgba(0, 0, 0, 0.15); }
  .tip[hidden] { display: none; }
  .tip .time { color: var(--secondary-text-color); font-size: 11px; }
  .tip .row { display: flex; align-items: center; gap: 6px; }
  .tip .row b { margin-left: auto; font-weight: 500; padding-left: 12px; }
  .tip .row.total b { font-weight: 600; }
  .tip .row.off { opacity: 0.45; }
  .tip i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; }
  .legend .toggle { all: unset; cursor: pointer; display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 12px;
    border: 1px solid var(--divider-color); color: var(--primary-text-color); font-size: 12px; }
  .legend .toggle:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 1px; }
  .legend .toggle.off { opacity: 0.45; text-decoration: line-through; }
  .legend .toggle i { margin-right: 6px; }
  .legend .unit-label { margin-left: auto; align-self: center; }
  .bar { fill: var(--warning-color, #ffa600); opacity: 0.55; }
  .bar.current { opacity: 1; }
  .bar-label { font-size: 9px; }
  .temp-line { fill: none; stroke: var(--info-color, #039be5); stroke-width: 2; stroke-linejoin: round; }
  .temp-dot { fill: var(--card-background-color, #fff); stroke: var(--info-color, #039be5); stroke-width: 2; }
  svg text.temp-label { fill: var(--info-color, #039be5); font-size: 10px; }
  .day-legend { display: inline-flex; gap: 10px; align-items: center; }
  .swatch { display: inline-block; width: 10px; height: 8px; border-radius: 2px; margin-right: 4px; vertical-align: middle; }
  .bar-swatch { background: var(--warning-color, #ffa600); opacity: 0.7; }
  .line-swatch { height: 2px; background: var(--info-color, #039be5); }
`;

class PowerMeterCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._seen = new Map();
    this._hidden = new Set();
    this._hoverIdx = null;
    this.shadowRoot.addEventListener("click", (ev) => this._onClick(ev));
    this.shadowRoot.addEventListener("pointermove", (ev) => this._hover(ev));
    this.shadowRoot.addEventListener("pointerdown", (ev) => this._hover(ev));
    this.shadowRoot.addEventListener(
      "pointerleave",
      (ev) => {
        if (ev.target?.classList?.contains("power-chart")) this._unhover();
      },
      true,
    );
    this._resize = new ResizeObserver(() => {
      const width = (this.shadowRoot.querySelector(".content")?.clientWidth || this.clientWidth) - 32;
      if (width > 0 && Math.abs(width - (this._width || 0)) >= 4) {
        this._width = width;
        this._render();
      }
    });
  }

  static getStubConfig(hass) {
    const id = Object.keys(hass?.states || {}).find((e) => /^sensor\.power_[0-9a-f]{12}$/.test(e) && hass.states[`sensor.l1_${e.slice(13)}`]);
    return { device: id ? id.slice("sensor.power_".length) : "" };
  }

  setConfig(config) {
    if (!config || typeof config !== "object") throw new Error("Invalid configuration");
    this._config = { fuse: 20, hours_to_show: 24, days_to_show: 7, show_chart: true, show_days: true, ...config };
    this._ids = {};
    for (const key of KEYS) {
      const id = config.entities?.[key] ?? (config.device ? `sensor.${key}_${config.device}` : null);
      if (id) this._ids[key] = id;
    }
    if (config.temperature) this._ids.temperature = config.temperature;
    this._history = null;
    this._stats = null;
    this._seen.clear();
    this._render();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first || this._changed()) this._render();
  }

  get hass() {
    return this._hass;
  }

  getCardSize() {
    return 8;
  }

  getGridOptions() {
    return { columns: 12, min_columns: 6 };
  }

  connectedCallback() {
    this._resize.observe(this);
    this._timer = setInterval(() => {
      this._history = null;
      this._stats = null;
      this._render();
    }, HISTORY_REFRESH_MS);
  }

  disconnectedCallback() {
    this._resize.disconnect();
    clearInterval(this._timer);
    this._timer = undefined;
  }

  // ---------------------------------------------------------------- helpers

  get lang() {
    const l = String(this._hass?.locale?.language || this._hass?.language || "en").toLowerCase();
    return l.startsWith("sv") ? "sv" : "en";
  }

  t(key, vars) {
    let text = STRINGS[this.lang][key] ?? STRINGS.en[key] ?? key;
    for (const [k, v] of Object.entries(vars || {})) text = text.replaceAll(`{${k}}`, String(v));
    return text;
  }

  n(value, digits = 1) {
    const v = toNumber(value);
    if (v === null) return "–";
    try {
      return new Intl.NumberFormat(this._hass?.locale?.language, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);
    } catch (_err) {
      return v.toFixed(digits);
    }
  }

  /** "850 W" or "1,25 kW", unit wrapped in a smaller span. */
  power(watts, big = false) {
    const v = toNumber(watts);
    if (v === null) return "–";
    const [num, unit] = Math.abs(v) >= 1000 ? [this.n(v / 1000, 2), "kW"] : [this.n(v, 0), "W"];
    return big ? `${num}<span class="unit">${unit}</span>` : `${num} ${unit}`;
  }

  clock(time) {
    try {
      return new Intl.DateTimeFormat(this._hass?.locale?.language, { hour: "2-digit", minute: "2-digit" }).format(new Date(time));
    } catch (_err) {
      return new Date(time).toTimeString().slice(0, 5);
    }
  }

  weekday(time) {
    try {
      return new Intl.DateTimeFormat(this._hass?.locale?.language, { weekday: "short" }).format(new Date(time));
    } catch (_err) {
      return "";
    }
  }

  /** Current value of a key, normalised to W / kWh. */
  val(key) {
    const s = this._hass.states[this._ids[key]];
    if (isMissing(s)) return null;
    const v = toNumber(s.state);
    return v === null ? null : v * unitFactor(s, KIND[key]);
  }

  points(key) {
    const id = this._ids[key];
    const rows = this._history?.data?.[id] || [];
    const f = unitFactor(this._hass.states[id], KIND[key]);
    return rows.map((r) => ({ t: rowTime(r), v: toNumber(rowState(r)) })).filter((p) => Number.isFinite(p.t) && p.v !== null).map((p) => ({ t: p.t, v: p.v * f }));
  }

  _changed() {
    let changed = false;
    for (const id of Object.values(this._ids || {})) {
      const s = this._hass.states[id];
      if (this._seen.get(id) !== s) {
        this._seen.set(id, s);
        changed = true;
      }
    }
    return changed;
  }

  _onClick(ev) {
    const toggle = ev.composedPath().find((el) => el.dataset && el.dataset.toggle);
    if (toggle) {
      const p = Number(toggle.dataset.toggle);
      if (this._hidden.has(p)) this._hidden.delete(p);
      else this._hidden.add(p);
      this._render();
      return;
    }
    const target = ev.composedPath().find((el) => el.dataset && el.dataset.more);
    const entityId = target && this._ids[target.dataset.more];
    if (entityId) this.dispatchEvent(new CustomEvent("hass-more-info", { detail: { entityId }, bubbles: true, composed: true }));
  }

  stat(key, label, text, cls = "") {
    const inner = `<span class="label">${esc(label)}</span><span class="value">${text}</span>`;
    if (!this._ids[key]) return `<div class="stat ${cls}">${inner}</div>`;
    return `<button class="link stat ${cls}" data-more="${esc(key)}" title="${esc(this._ids[key])}">${inner}</button>`;
  }

  // ---------------------------------------------------------------- data

  _windowStart(now) {
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    return Math.min(now - this._config.hours_to_show * 3600000, midnight.getTime());
  }

  async _loadHistory(start) {
    if (this._loadingHistory || !this._hass?.callWS) return;
    const ids = ["power", "total", "l1", "l2", "l3"].map((k) => this._ids[k]).filter((id) => id && this._hass.states[id]);
    if (!ids.length) return;
    this._loadingHistory = true;
    try {
      const data = await this._hass.callWS({
        type: "history/history_during_period",
        start_time: new Date(start).toISOString(),
        end_time: new Date().toISOString(),
        entity_ids: ids,
        minimal_response: true,
        no_attributes: true,
        significant_changes_only: false,
      });
      this._history = { start, data: data || {} };
    } catch (err) {
      console.warn("Power meter card: history unavailable", err);
      this._history = { start, data: {} };
    } finally {
      this._loadingHistory = false;
      this._render();
    }
  }

  async _loadStats(start) {
    const id = this._ids.total;
    const tempId = this._ids.temperature;
    if (this._loadingStats || !this._hass?.callWS || !id || !this._hass.states[id]) return;
    this._loadingStats = true;
    try {
      const data = await this._hass.callWS({
        type: "recorder/statistics_during_period",
        start_time: new Date(start).toISOString(),
        statistic_ids: tempId ? [id, tempId] : [id],
        period: "day",
        types: ["change", "mean"],
        units: { energy: "kWh" },
      });
      this._stats = { start, rows: data?.[id] || [], temps: tempId ? data?.[tempId] || [] : [] };
    } catch (err) {
      console.warn("Power meter card: statistics unavailable", err);
      this._stats = { start, rows: [], temps: [] };
    } finally {
      this._loadingStats = false;
      this._render();
    }
  }

  /** kWh since local midnight: live meter reading minus the reading at midnight. */
  _today(now) {
    const total = this.val("total");
    if (total === null || !this._history) return null;
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    const pts = this.points("total");
    if (!pts.length) return null;
    let base = pts[0].v;
    for (const p of pts) if (p.t <= midnight.getTime()) base = p.v;
    return Math.max(0, total - base);
  }

  // ---------------------------------------------------------------- render

  _render() {
    if (!this._config || !this._hass) return;
    for (const id of Object.values(this._ids)) this._seen.set(id, this._hass.states[id]);
    let body;
    if (!this._ids.power && !this._ids.l1) {
      body = `<div class="content"><div class="empty">${esc(this.t("no_device"))}</div></div>`;
    } else if (!this._hass.states[this._ids.power || this._ids.l1]) {
      body = `<div class="content"><div class="empty">${esc(this.t("missing", { entity: this._ids.power || this._ids.l1 }))}</div></div>`;
    } else {
      try {
        body = this.renderBody(Date.now());
      } catch (err) {
        console.error("Power meter card", err);
        body = `<div class="content"><div class="empty">${esc(err?.message || err)}</div></div>`;
      }
    }
    this.shadowRoot.innerHTML = `<style>${STYLES}</style><ha-card>${this.renderHeader()}${body}</ha-card>`;
    if (this._hoverIdx !== null) this._showTip();
  }

  renderHeader() {
    const title = this._config.title ?? this.t("title");
    const fuse = toNumber(this._config.fuse);
    const amps = PHASES.map((p) => this.val(`i${p}`)).filter((v) => v !== null);
    const peak = amps.length ? Math.max(...amps) : null;
    const ratio = fuse && peak !== null ? peak / fuse : 0;
    const level = ratio >= 0.9 ? "error" : ratio >= 0.7 ? "warning" : "";
    const chip = fuse ? `<span class="chip ${level}"><ha-icon icon="mdi:fuse"></ha-icon>${esc(this.t("fuse", { fuse }))}</span>` : "";
    return `<div class="header"><div class="title"><ha-icon icon="${esc(this._config.icon || "mdi:meter-electric")}"></ha-icon><span>${esc(
      title,
    )}</span></div>${chip}</div>`;
  }

  renderBody(now) {
    const start = this._windowStart(now);
    if (!this._history || this._history.start > start || now - this._history.start > (this._config.hours_to_show + 26) * 3600000) {
      queueMicrotask(() => this._loadHistory(start));
    }

    const power = this.val("power") ?? PHASES.reduce((sum, p) => sum + (this.val(`l${p}`) ?? 0), 0);
    const returning = this.val("returning");
    const exporting = returning !== null && returning > 0;
    const state = exporting ? "export" : power > 0 ? "on" : "";
    const reason = exporting ? this.t("exporting", { power: this.power(returning) }) : power > 0 ? this.t("using") : this.t("idle");
    const total = this.val("total");
    const today = this._today(now);

    return `<div class="content">
      <div class="hero">
        <button class="link meter ${state}" data-more="power"><ha-icon icon="${exporting ? "mdi:transmission-tower-export" : "mdi:flash"}"></ha-icon></button>
        <div class="stat">
          <button class="link" data-more="power"><span class="big">${this.power(exporting ? -returning : power, true)}</span></button>
          <span class="reason ${exporting ? "export" : ""}">${esc(reason)}</span>
        </div>
        ${this.stat("total", this.t("today"), today === null ? "–" : `${this.n(today, 2)} <span class="unit">kWh</span>`, "side")}
      </div>
      <div class="divider"></div>
      ${this.renderPhases()}
      ${this._config.show_chart !== false ? `<div class="divider"></div>${this.renderChart(now)}` : ""}
      ${this._config.show_days !== false && this._ids.total ? `<div class="divider"></div>${this.renderDays(now)}` : ""}
      ${total !== null ? `<div class="divider"></div><div class="grid">${this.stat("total", this.t("total"), `${this.n(total, 1)} <span class="unit">kWh</span>`)}${
        this._ids.returning && returning !== null ? this.stat("returning", this.t("exporting", { power: "" }).trim(), this.power(returning)) : ""
      }</div>` : ""}
    </div>`;
  }

  renderPhases() {
    const fuse = toNumber(this._config.fuse) || null;
    const rows = PHASES.map((p) => {
      const w = this.val(`l${p}`);
      const a = this.val(`i${p}`);
      const u = this.val(`u${p}`);
      if (w === null && a === null) return { p, html: "", ratio: null };
      // Load against the fuse: by current when we have it, else by power at nominal voltage.
      const ratio = fuse ? (a !== null ? a / fuse : w !== null ? w / ((u || 230) * fuse) : null) : null;
      const pct = ratio === null ? 0 : Math.max(0, Math.min(100, ratio * 100));
      const level = ratio >= 0.9 ? "error" : ratio >= 0.7 ? "warning" : "";
      const html = `<button class="link phase" data-more="l${p}" title="${esc(this._ids[`l${p}`] || "")}">
          <span class="name"><i style="background:${PHASE_COLORS[p]}"></i>L${p}</span>
          ${fuse ? `<div class="gauge"><div class="fill ${level}" style="width:${pct.toFixed(1)}%"></div></div>` : "<span></span>"}
          <span class="nums">${this.power(w)}</span>
          <span class="meta"><span>${a === null ? "" : `${this.n(a, 1)} A`}${fuse && a !== null ? ` / ${fuse} A` : ""}</span><span>${u === null ? "" : `${this.n(u, 0)} V`}</span></span>
        </button>`;
      return { p, html, ratio };
    }).filter((r) => r.html);
    if (!rows.length) return "";
    const top = rows.reduce((best, r) => (r.ratio !== null && (best === null || r.ratio > best.ratio) ? r : best), null);
    return `<div class="section"><span>${esc(this.t("phases"))}</span>${top && top.ratio > 0 ? `<span>${esc(this.t("max_phase", { phase: `L${top.p}` }))}</span>` : ""}</div>
      <div class="phases">${rows.map((r) => r.html).join("")}</div>`;
  }

  renderChart(now) {
    const hours = this._config.hours_to_show;
    const size = Math.max(1, Number(this._config.bucket_minutes) || 5) * 60000;
    const t0 = now - hours * 3600000;
    const W = this._chartWidth();
    const H = 150;
    const plot = { x0: 30, x1: W - 2, y0: 8, y1: H - 18 };
    const title = `<div class="section"><span>${esc(this.t("chart", { hours }))}</span><span>${esc(this.t("avg", { min: size / 60000 }))}</span></div>`;

    // Step series clipped to the window, extended to now with the live value.
    const series = (key) => {
      if (!this._ids[key]) return [];
      const pts = this.points(key);
      let before = null;
      const inside = [];
      for (const p of pts) (p.t < t0 ? (before = p) : inside.push(p));
      if (before) inside.unshift({ t: t0, v: before.v });
      const live = this.val(key);
      if (inside.length && live !== null) inside.push({ t: now, v: live });
      return inside;
    };
    const n = Math.ceil((now - t0) / size);
    const total = bucketMeans(series("power"), t0, now, size, n);
    const phases = PHASES.map((p) => ({ p, v: bucketMeans(series(`l${p}`), t0, now, size, n) })).filter((s) => s.v.some((v) => v !== null));
    const has = (arr) => arr.some((v) => v !== null);
    if (!has(total) && !phases.length) return `${title}<div class="empty">${esc(this.t("chart_empty"))}</div>`;

    // Stack the visible phases (L1 at the bottom); without phases, plot the total.
    const hidden = this._hidden;
    const shown = phases.filter((s) => !hidden.has(s.p));
    const layers = [];
    const base = new Array(n).fill(0);
    if (phases.length) {
      for (const s of shown) {
        const lower = base.slice();
        for (let k = 0; k < n; k++) base[k] += Math.max(0, s.v[k] ?? 0);
        layers.push({ cls: "stack", color: PHASE_COLORS[s.p], lower, upper: base.slice() });
      }
    } else {
      for (let k = 0; k < n; k++) base[k] = Math.max(0, total[k] ?? 0);
      layers.push({ cls: "stack total", color: "var(--warning-color, #ffa600)", lower: new Array(n).fill(0), upper: base.slice() });
    }
    const valid = (k) => total[k] !== null || phases.some((s) => s.v[k] !== null);
    let first = 0;
    while (first < n && !valid(first)) first++;

    const max = niceMax(Math.max(1, ...base, ...phases.flatMap((s) => s.v.map((v) => v ?? 0))));
    const kw = max >= 2000;
    const x = (t) => plot.x0 + ((t - t0) / (now - t0)) * (plot.x1 - plot.x0);
    const cx = (k) => x(Math.min(now, t0 + (k + 0.5) * size));
    const y = (v) => plot.y1 - (Math.max(0, v) / max) * (plot.y1 - plot.y0);

    const parts = [];
    for (const f of [0, 0.5, 1]) {
      const yy = y(max * f).toFixed(1);
      parts.push(`<line class="grid-line" x1="${plot.x0}" x2="${plot.x1}" y1="${yy}" y2="${yy}"/>`);
      const label = kw ? this.n((max * f) / 1000, (max * f) % 1000 ? 1 : 0) : this.n(max * f, 0);
      parts.push(`<text x="${plot.x0 - 6}" y="${Number(yy) + 4}" text-anchor="end">${esc(label)}</text>`);
    }
    const tickEvery = hours <= 6 ? 1 : hours <= 12 ? 3 : hours <= 24 ? (W < 360 ? 6 : 3) : 12;
    const firstHour = new Date(t0);
    firstHour.setMinutes(0, 0, 0);
    for (let t = firstHour.getTime() + 3600000; t < now; t += 3600000) {
      if (new Date(t).getHours() % tickEvery) continue;
      const xx = x(t).toFixed(1);
      if (Number(xx) - plot.x0 < 16 || plot.x1 - Number(xx) < 16) continue;
      parts.push(`<line class="grid-line" x1="${xx}" x2="${xx}" y1="${plot.y0}" y2="${plot.y1}" opacity="0.5"/>`);
      parts.push(`<text x="${xx}" y="${H - 3}" text-anchor="middle">${esc(this.clock(t))}</text>`);
    }
    if (first < n) {
      for (const l of layers) {
        let d = "";
        for (let k = first; k < n; k++) d += `${k === first ? "M" : "L"}${cx(k).toFixed(1)},${y(l.upper[k]).toFixed(1)}`;
        const top = d;
        for (let k = n - 1; k >= first; k--) d += `L${cx(k).toFixed(1)},${y(l.lower[k]).toFixed(1)}`;
        parts.push(`<path class="${l.cls}" style="fill:${l.color}" d="${d}Z"/><path class="stack-line" style="stroke:${l.color}" d="${top}"/>`);
      }
    }
    parts.push(`<line class="cursor" x1="0" x2="0" y1="${plot.y0}" y2="${plot.y1}" visibility="hidden"/>`);

    this._chart = { n, first, t0, size, now, plot, cx, total, phases };

    const legend = [
      ...(phases.length
        ? phases.map(
            (s) =>
              `<button class="toggle ${hidden.has(s.p) ? "off" : ""}" data-toggle="${s.p}" aria-pressed="${!hidden.has(s.p)}"><i style="background:${PHASE_COLORS[s.p]}"></i>L${s.p}</button>`,
          )
        : [`<span><i style="background:var(--warning-color,#ffa600)"></i>${esc(this.t("total_power"))}</span>`]),
      `<span class="unit-label">${kw ? "kW" : "W"}</span>`,
    ].join("");

    return `${title}
      <div class="chart-wrap">
        <svg class="power-chart" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(this.t("chart", { hours }))}">${parts.join("")}</svg>
        <div class="tip" hidden></div>
      </div>
      <div class="legend">${legend}</div>`;
  }

  _chartWidth() {
    return Math.max(220, Math.round(this._width || 300));
  }

  _hover(ev) {
    const c = this._chart;
    const svg = ev.target.closest?.("svg.power-chart") || ev.composedPath().find((el) => el.classList?.contains("power-chart"));
    if (!c || !svg) return this._unhover();
    const rect = svg.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * svg.viewBox.baseVal.width;
    const t = c.t0 + ((px - c.plot.x0) / (c.plot.x1 - c.plot.x0)) * (c.now - c.t0);
    const k = Math.max(c.first, Math.min(c.n - 1, Math.floor((t - c.t0) / c.size)));
    this._hoverIdx = k;
    this._showTip();
  }

  _unhover() {
    this._hoverIdx = null;
    this._showTip();
  }

  _showTip() {
    const root = this.shadowRoot;
    const tip = root.querySelector(".tip");
    const cursor = root.querySelector(".cursor");
    const c = this._chart;
    const k = this._hoverIdx;
    if (!tip || !cursor || !c || k === null || k === undefined || k < c.first || k >= c.n) {
      if (tip) tip.hidden = true;
      if (cursor) cursor.setAttribute("visibility", "hidden");
      return;
    }
    const xx = c.cx(k);
    cursor.setAttribute("x1", xx);
    cursor.setAttribute("x2", xx);
    cursor.setAttribute("visibility", "visible");
    const start = c.t0 + k * c.size;
    const end = Math.min(c.now, start + c.size);
    const sum = c.phases.reduce((acc, s) => acc + (s.v[k] ?? 0), 0);
    const totalV = c.total[k] ?? (c.phases.length ? sum : null);
    const rows = c.phases
      .map((s) => `<span class="row ${this._hidden.has(s.p) ? "off" : ""}"><i style="background:${PHASE_COLORS[s.p]}"></i>L${s.p}<b>${this.power(s.v[k])}</b></span>`)
      .join("");
    tip.innerHTML = `<span class="time">${esc(this.clock(start))}–${esc(this.clock(end))}</span>
      <span class="row total">${esc(this.t("total_power"))}<b>${this.power(totalV)}</b></span>${rows}`;
    tip.hidden = false;
    const wrap = tip.parentElement.getBoundingClientRect();
    const svg = root.querySelector("svg.power-chart");
    const scale = svg ? svg.getBoundingClientRect().width / svg.viewBox.baseVal.width : 1;
    const left = xx * scale;
    const w = tip.offsetWidth;
    tip.style.left = `${Math.max(0, Math.min(wrap.width - w, left > wrap.width / 2 ? left - w - 10 : left + 10))}px`;
  }

  renderDays(now) {
    const days = Math.max(2, Math.min(31, Number(this._config.days_to_show) || 7));
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (days - 1));
    if (!this._stats || this._stats.start !== start.getTime()) queueMicrotask(() => this._loadStats(start.getTime()));

    const dayOf = (r) => new Date(typeof r.start === "number" ? r.start : Date.parse(r.start)).setHours(0, 0, 0, 0);
    const byDay = new Map();
    for (const r of this._stats?.rows || []) byDay.set(dayOf(r), toNumber(r.change));
    const tempByDay = new Map();
    for (const r of this._stats?.temps || []) tempByDay.set(dayOf(r), toNumber(r.mean));
    // Statistics lag up to an hour; today's bar uses the live figure.
    const todayKey = new Date(now).setHours(0, 0, 0, 0);
    const today = this._today(now);
    if (today !== null) byDay.set(todayKey, today);
    // Before the first hourly statistics of the day, fall back to the live temperature.
    const tempState = this._hass.states[this._ids.temperature];
    if (this._ids.temperature && !tempByDay.has(todayKey) && !isMissing(tempState)) tempByDay.set(todayKey, toNumber(tempState.state));
    const tempUnit = tempState?.attributes?.unit_of_measurement || "°C";

    const list = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      list.push({ t: d.getTime(), v: byDay.get(d.getTime()) ?? null, temp: tempByDay.get(d.getTime()) ?? null });
    }
    if (!list.some((d) => d.v !== null)) return `<div class="section"><span>${esc(this.t("days"))}</span></div><div class="empty">${esc(this.t("chart_empty"))}</div>`;

    const W = this._chartWidth();
    const temps = list.map((d) => d.temp).filter((v) => v !== null);
    const hasTemp = temps.length > 0;
    const H = hasTemp ? 116 : 100;
    const plot = { x0: 4, x1: W - 4, y0: 12, y1: H - (hasTemp ? 30 : 14) };
    const max = Math.max(...list.map((d) => d.v ?? 0), 0.1);
    const slot = (plot.x1 - plot.x0) / days;
    const bw = Math.min(28, slot * 0.7);
    const parts = [];
    list.forEach((d, i) => {
      const cx = plot.x0 + slot * (i + 0.5);
      const h = d.v === null ? 0 : (d.v / max) * (plot.y1 - plot.y0);
      const current = d.t === todayKey;
      if (d.v !== null) {
        parts.push(`<rect class="bar ${current ? "current" : ""}" x="${(cx - bw / 2).toFixed(1)}" y="${(plot.y1 - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(h, 0.5).toFixed(1)}" rx="2"><title>${esc(
          `${this.weekday(d.t)}: ${this.n(d.v, 2)} kWh${d.temp !== null ? ` · ${this.n(d.temp, 1)} ${tempUnit}` : ""}`,
        )}</title></rect>`);
        parts.push(`<text class="bar-label" x="${cx.toFixed(1)}" y="${(plot.y1 - h - 3).toFixed(1)}" text-anchor="middle">${esc(this.n(d.v, d.v >= 100 ? 0 : 1))}</text>`);
      }
      const dayY = hasTemp ? plot.y1 + 13 : H - 2;
      parts.push(`<text x="${cx.toFixed(1)}" y="${dayY}" text-anchor="middle">${esc(current ? this.t("today") : this.weekday(d.t))}</text>`);
      if (d.temp !== null) parts.push(`<text class="temp-label" x="${cx.toFixed(1)}" y="${H - 2}" text-anchor="middle">${esc(this.n(d.temp, 1))}°</text>`);
    });
    if (hasTemp) {
      // Own scale for the temperature, padded so the line stays clear of the edges.
      const lo = Math.min(...temps);
      const hi = Math.max(...temps);
      const pad = Math.max(1, (hi - lo) * 0.15);
      const ty = (v) => plot.y1 - 4 - ((v - (lo - pad)) / (hi - lo + 2 * pad)) * (plot.y1 - plot.y0 - 8);
      const pts = list.map((d, i) => (d.temp === null ? null : { x: plot.x0 + slot * (i + 0.5), y: ty(d.temp), d }));
      let path = "";
      let pen = false;
      for (const p of pts) {
        if (!p) {
          pen = false;
          continue;
        }
        path += `${pen ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`;
        pen = true;
      }
      parts.push(`<path class="temp-line" d="${path}"/>`);
      for (const p of pts.filter(Boolean)) {
        parts.push(`<circle class="temp-dot" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3"><title>${esc(
          `${this.weekday(p.d.t)}: ${this.n(p.d.temp, 1)} ${tempUnit}`,
        )}</title></circle>`);
      }
    }
    const legend = hasTemp
      ? `<span class="day-legend"><span><i class="swatch bar-swatch"></i>kWh</span><span><i class="swatch line-swatch"></i>${esc(this.t("mean_temp"))}</span></span>`
      : "<span>kWh</span>";
    return `<div class="section"><span>${esc(this.t("days"))}</span>${legend}</div>
      <button class="link chart" data-more="total"><svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(this.t("days"))}">${parts.join("")}</svg></button>`;
  }
}

if (!customElements.get("power-meter-card")) customElements.define("power-meter-card", PowerMeterCard);
window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === "power-meter-card")) {
  window.customCards.push({
    type: "power-meter-card",
    name: "Power Meter Card",
    description: "Current power, per-phase load, 24 h chart and daily energy for a Currently One meter.",
    preview: true,
  });
}

console.info(
  `%c Power Meter card %c ${VERSION} `,
  "background:#ffa600;color:#fff;border-radius:3px 0 0 3px",
  "background:#555;color:#fff;border-radius:0 3px 3px 0",
);
