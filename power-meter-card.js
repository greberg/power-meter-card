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

const VERSION = "1.0.0";
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
  .legend { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 11px; color: var(--secondary-text-color); }
  .legend i { display: inline-block; width: 12px; height: 8px; margin-right: 4px; vertical-align: middle; border-radius: 2px; }
  .legend i.line { height: 2px; }
  .empty { color: var(--secondary-text-color); font-size: 14px; padding: 8px 0; }
  button.link.chart { display: block; width: 100%; }
  svg { display: block; width: 100%; height: auto; overflow: visible; }
  svg text { font-size: 10px; fill: var(--secondary-text-color); font-family: inherit; }
  .grid-line { stroke: var(--divider-color); stroke-width: 1; }
  .now { stroke: var(--primary-text-color); stroke-width: 1; opacity: 0.6; }
  .area { fill: color-mix(in srgb, var(--warning-color, #ffa600) 30%, transparent); stroke: var(--warning-color, #ffa600); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
  .pl { fill: none; stroke-width: 1.5; vector-effect: non-scaling-stroke; }
  .bar { fill: var(--warning-color, #ffa600); opacity: 0.55; }
  .bar.current { opacity: 1; }
  .bar-label { font-size: 9px; }
`;

class PowerMeterCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._seen = new Map();
    this.shadowRoot.addEventListener("click", (ev) => this._onClick(ev));
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
    this._timer = setInterval(() => {
      this._history = null;
      this._stats = null;
      this._render();
    }, HISTORY_REFRESH_MS);
  }

  disconnectedCallback() {
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
    if (this._loadingStats || !this._hass?.callWS || !id || !this._hass.states[id]) return;
    this._loadingStats = true;
    try {
      const data = await this._hass.callWS({
        type: "recorder/statistics_during_period",
        start_time: new Date(start).toISOString(),
        statistic_ids: [id],
        period: "day",
        types: ["change"],
        units: { energy: "kWh" },
      });
      this._stats = { start, rows: data?.[id] || [] };
    } catch (err) {
      console.warn("Power meter card: statistics unavailable", err);
      this._stats = { start, rows: [] };
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
    const t0 = now - hours * 3600000;
    const W = 300;
    const H = 120;
    const plot = { x0: 30, x1: W - 4, y0: 6, y1: H - 16 };
    const x = (t) => plot.x0 + ((t - t0) / (now - t0)) * (plot.x1 - plot.x0);

    // Step series clipped to the window, extended to now with the live value.
    const series = (key) => {
      const pts = this.points(key);
      let before = null;
      const inside = [];
      for (const p of pts) (p.t < t0 ? (before = p) : inside.push(p));
      if (before) inside.unshift({ t: t0, v: before.v });
      const live = this.val(key);
      if (inside.length && live !== null) inside.push({ t: now, v: live });
      return inside;
    };
    const total = this._ids.power ? series("power") : [];
    const phases = PHASES.map((p) => ({ p, pts: this._ids[`l${p}`] ? series(`l${p}`) : [] })).filter((s) => s.pts.length > 1);
    if (total.length < 2 && !phases.length) {
      return `<div class="section"><span>${esc(this.t("chart", { hours }))}</span></div><div class="empty">${esc(this.t(this._history ? "chart_empty" : "chart_empty"))}</div>`;
    }

    const max = niceMax(Math.max(1, ...total.map((p) => p.v), ...phases.flatMap((s) => s.pts.map((p) => p.v))));
    const y = (v) => plot.y1 - (Math.max(0, v) / max) * (plot.y1 - plot.y0);
    const step = (pts) => {
      let d = "";
      pts.forEach((p, i) => {
        const px = x(p.t).toFixed(1);
        d += i === 0 ? `M${px},${y(p.v).toFixed(1)}` : `H${px}V${y(p.v).toFixed(1)}`;
      });
      return d;
    };

    const parts = [];
    for (const f of [0, 0.5, 1]) {
      const yy = y(max * f).toFixed(1);
      parts.push(`<line class="grid-line" x1="${plot.x0}" x2="${plot.x1}" y1="${yy}" y2="${yy}"/>`);
      parts.push(`<text x="${plot.x0 - 4}" y="${Number(yy) + 3}" text-anchor="end">${esc(max >= 2000 ? this.n((max * f) / 1000, max * f % 1000 ? 1 : 0) : this.n(max * f, 0))}</text>`);
    }
    if (total.length > 1) {
      const line = step(total);
      parts.push(`<path class="area" d="${line}V${plot.y1}H${x(total[0].t).toFixed(1)}Z"><title>${esc(this.t("total_power"))}</title></path>`);
    }
    for (const s of phases) parts.push(`<path class="pl" style="stroke:${PHASE_COLORS[s.p]}" d="${step(s.pts)}"><title>L${s.p}</title></path>`);

    const tickEvery = hours <= 12 ? 3 : hours <= 24 ? 6 : 12;
    const first = new Date(t0);
    first.setMinutes(0, 0, 0);
    for (let t = first.getTime() + 3600000; t < now; t += 3600000) {
      if (new Date(t).getHours() % tickEvery) continue;
      const xx = x(t).toFixed(1);
      parts.push(`<line class="grid-line" x1="${xx}" x2="${xx}" y1="${plot.y0}" y2="${plot.y1}" opacity="0.5"/>`);
      parts.push(`<text x="${xx}" y="${H - 2}" text-anchor="middle">${esc(this.clock(t))}</text>`);
    }
    parts.push(`<line class="now" x1="${plot.x1}" x2="${plot.x1}" y1="${plot.y0}" y2="${plot.y1}"/>`);

    const legend = [
      total.length > 1 ? `<span><i style="background:color-mix(in srgb,var(--warning-color,#ffa600) 45%,transparent)"></i>${esc(this.t("total_power"))}</span>` : "",
      ...phases.map((s) => `<span><i class="line" style="background:${PHASE_COLORS[s.p]}"></i>L${s.p}</span>`),
      `<span>${max >= 2000 ? "kW" : "W"}</span>`,
    ].join("");

    return `<div class="section"><span>${esc(this.t("chart", { hours }))}</span></div>
      <button class="link chart" data-more="power"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(this.t("chart", { hours }))}">${parts.join("")}</svg></button>
      <div class="legend">${legend}</div>`;
  }

  renderDays(now) {
    const days = Math.max(2, Math.min(31, Number(this._config.days_to_show) || 7));
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (days - 1));
    if (!this._stats || this._stats.start !== start.getTime()) queueMicrotask(() => this._loadStats(start.getTime()));

    const byDay = new Map();
    for (const r of this._stats?.rows || []) {
      const d = new Date(typeof r.start === "number" ? r.start : Date.parse(r.start));
      d.setHours(0, 0, 0, 0);
      byDay.set(d.getTime(), toNumber(r.change));
    }
    // Statistics lag up to an hour; today's bar uses the live figure.
    const todayKey = new Date(now).setHours(0, 0, 0, 0);
    const today = this._today(now);
    if (today !== null) byDay.set(todayKey, today);

    const list = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      list.push({ t: d.getTime(), v: byDay.get(d.getTime()) ?? null });
    }
    if (!list.some((d) => d.v !== null)) return `<div class="section"><span>${esc(this.t("days"))}</span></div><div class="empty">${esc(this.t("chart_empty"))}</div>`;

    const W = 300;
    const H = 90;
    const plot = { x0: 4, x1: W - 4, y0: 12, y1: H - 14 };
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
          `${this.weekday(d.t)}: ${this.n(d.v, 2)} kWh`,
        )}</title></rect>`);
        parts.push(`<text class="bar-label" x="${cx.toFixed(1)}" y="${(plot.y1 - h - 3).toFixed(1)}" text-anchor="middle">${esc(this.n(d.v, d.v >= 100 ? 0 : 1))}</text>`);
      }
      parts.push(`<text x="${cx.toFixed(1)}" y="${H - 2}" text-anchor="middle">${esc(current ? this.t("today") : this.weekday(d.t))}</text>`);
    });
    return `<div class="section"><span>${esc(this.t("days"))}</span><span>kWh</span></div>
      <button class="link chart" data-more="total"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(this.t("days"))}">${parts.join("")}</svg></button>`;
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
