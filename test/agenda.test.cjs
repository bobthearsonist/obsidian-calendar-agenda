"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

class Element {
  constructor(tag = "div", options = {}) {
    this.tag = tag;
    this.children = [];
    this.attrs = { ...options.attr };
    this.text = options.text || "";
    this.classes = new Set((options.cls || "").split(" "));
    this.handlers = {};
    this.style = { props: {}, setProperty(k, v) { this.props[k] = v; } };
  }
  createEl(tag, options = {}) {
    const child = new Element(tag, options);
    this.children.push(child);
    return child;
  }
  createDiv(options = {}) { return this.createEl("div", options); }
  createSpan(options = {}) { return this.createEl("span", options); }
  addClass(value) { this.classes.add(value); }
  setAttribute(name, value) { this.attrs[name] = value; }
  addEventListener(name, callback) { this.handlers[name] = callback; }
  empty() { this.children = []; }
  all() { return [this, ...this.children.flatMap((child) => child.all())]; }
  content() { return this.all().map((node) => node.text).join(" "); }
}

function load() {
  let time = new Date("2026-10-26T10:00:00").getTime();
  const timers = new Map();
  const domEvents = new Set();
  const errors = [];
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [time])); }
    static now() { return time; }
  }
  const window = {
    setInterval(callback) { timers.set(callback, callback); return callback; },
    clearInterval(id) { timers.delete(id); },
  };
  class Component {
    constructor(containerEl) { this.containerEl = containerEl; this.cleanups = []; }
    register(callback) { this.cleanups.push(callback); }
    registerInterval(id) { this.register(() => window.clearInterval(id)); }
    registerDomEvent(target, event, callback) {
      domEvents.add(callback);
      this.register(() => domEvents.delete(callback));
    }
    unload() { for (const cleanup of this.cleanups.reverse()) cleanup(); }
  }
  const context = {
    module: { exports: {} },
    require(name) {
      assert.equal(name, "obsidian");
      return { Plugin: class {}, MarkdownRenderChild: Component };
    },
    Date: Clock,
    URL,
    Intl,
    queueMicrotask,
    window,
    console: { error(...args) { errors.push(args); } },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8"), context);
  return {
    ...context.module.exports.internals,
    timers, domEvents, errors,
    setTime(value) { time = new Date(value).getTime(); },
  };
}

const api = load();
const now = new Date("2026-10-26T10:00:00");
const span = api.bounds("2026-10-26");
const event = (id, start, end, extra = {}) => ({
  id, sourceId: "work", title: id, allDay: false,
  startMs: new Date(`2026-10-26T${start}:00`).getTime(),
  endMs: new Date(`2026-10-26T${end}:00`).getTime(),
  calendarName: "Work", ...extra,
});
function provider(events = [], state = {}) {
  return {
    listeners: new Set(),
    settings: { refreshMinutes: 5, use24h: true },
    calls: [],
    states: [{ def: { label: "Work" }, st: {
      error: null, inFlight: false, fetchedAt: now.getTime(),
      fromMs: span.from, toMs: span.to, ...state,
    } }],
    events,
    sourceStates() { return this.states; },
    eventsForWindow() { return this.events; },
    ensureWindow(...args) { this.calls.push(args); },
  };
}
function mount(runtime, integration, source = "date: today", sourcePath = "00 Home.md") {
  const root = new Element();
  const opened = [];
  const app = {
    plugins: { plugins: integration ? { powerdesk: integration } : {} },
    setting: { open() {}, openTabById(id) { opened.push(id); } },
  };
  const block = new runtime.AgendaBlock(root, { app }, source, sourcePath);
  block.onload();
  return { root, block, app, opened };
}

test("strict block options reject unknown, duplicate and invalid values", () => {
  assert.equal(api.parseOptions("").date, "note");
  assert.equal(api.parseOptions("# comment\ndate: today").date, "today");
  assert.equal(api.parseOptions("date: 2028-02-29").date, "2028-02-29");
  for (const input of ["days: 3", "date: today\ndate: note", "date: 2026-02-29", "date: 2026-13-01", "date: tomorrow"]) {
    assert.throws(() => api.parseOptions(input));
  }
});

test("compact, ISO and numbered daily-note filenames resolve the note date", () => {
  for (const filename of ["20261022.md", "2026-10-22.md", "20261022-2.md", "2026-10-22 Thursday.md"]) {
    assert.equal(api.resolveDate({ date: "note" }, `folder/${filename}`, now), "2026-10-22");
  }
  for (const filename of ["Home.md", "20260230.md", "202610220.md"]) {
    assert.throws(() => api.resolveDate({ date: "note" }, filename, now));
  }
});

test("explicit dates stay pinned while today follows the clock", () => {
  assert.equal(api.resolveDate({ date: "2026-01-01" }, "Home.md", now), "2026-01-01");
  assert.equal(api.resolveDate({ date: "today" }, "20260101.md", now), "2026-10-26");
});

test("local day bounds follow calendar midnight across daylight saving", () => {
  const before = process.env.TZ;
  try {
    process.env.TZ = "America/New_York";
    assert.equal((api.bounds("2026-03-08").to - api.bounds("2026-03-08").from) / 3_600_000, 23);
    assert.equal((api.bounds("2026-11-01").to - api.bounds("2026-11-01").from) / 3_600_000, 25);
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
});

test("events sort all-day first, preserve overlaps, and deduplicate only within a source", () => {
  const one = event("same", "10:00", "11:00");
  const allDay = { ...one, id: "all-day", allDay: true, startMs: span.from, endMs: span.to };
  const model = api.buildModel(provider([
    one, allDay, one, { ...one, sourceId: "personal" }, event("overlap", "10:30", "11:30"), event("earlier", "09:00", "10:00"),
  ]), "2026-10-26", now);
  assert.equal(model.events[0].id, "all-day");
  assert.equal(model.events[1].id, "earlier");
  assert.equal(model.events.length, 5);
});

test("exclusive boundaries exclude events ending at midnight and include spanning events", () => {
  const base = event("spanning", "09:00", "10:00");
  const model = api.buildModel(provider([
    { ...base, startMs: span.from - 1000, endMs: span.from },
    { ...base, id: "spanning", startMs: span.from - 1000, endMs: span.to + 1000 },
    { ...base, id: "tomorrow", startMs: span.to, endMs: span.to + 1000 },
  ]), "2026-10-26", now);
  assert.equal(model.events.length, 1);
  assert.equal(model.events[0].id, "spanning");
});

test("now, next and ended statuses use exact event boundaries", () => {
  const ended = event("ended", "09:00", "10:00");
  const current = event("current", "10:00", "11:00");
  const upcoming = event("next", "11:00", "12:00");
  const model = api.buildModel(provider([upcoming, ended, current]), "2026-10-26", now);
  assert.equal(api.eventStatus(ended, model.nextId, now), "Ended");
  assert.equal(api.eventStatus(current, model.nextId, now), "Now");
  assert.equal(api.eventStatus(upcoming, model.nextId, now), "Next");
  assert.equal(api.eventStatus({ ...current, allDay: true }, model.nextId, now), "");
});

test("failures retain cached data and loading/coverage remain distinguishable", () => {
  const model = api.buildModel(provider([event("cached", "10:00", "11:00")], { error: "expired token" }), "2026-10-26", now);
  assert.equal(model.failures[0], "Work");
  assert.equal(model.events.length, 1);
  assert.equal(model.loading, false);
  const p = provider();
  p.states[0].st = null;
  const waiting = api.buildModel(p, "2026-10-26", now);
  assert.equal(waiting.loading, true);
  assert.equal(waiting.uncovered, true);
});

test("invalid provider events fail explicitly", () => {
  assert.throws(() => api.buildModel(provider([{ id: "bad" }]), "2026-10-26", now), /invalid calendar event/);
});

test("links permit web URLs only", () => {
  assert.equal(api.safeLink("https://teams.microsoft.com/meet"), "https://teams.microsoft.com/meet");
  for (const raw of ["javascript:alert(1)", "file:///C:/secret", "data:text/html,test", "invalid", ""]) {
    assert.equal(api.safeLink(raw), null);
  }
});

test("missing and disconnected providers render honest setup states", () => {
  const runtime = load();
  const missing = mount(runtime);
  assert.match(missing.root.content(), /Enable Power Desk/);
  missing.block.unload();
  const p = provider();
  p.states = [];
  const disconnected = mount(runtime, p);
  assert.match(disconnected.root.content(), /No calendar accounts connected/);
  assert.doesNotMatch(disconnected.root.content(), /Nothing scheduled/);
  disconnected.block.unload();
});

test("render shows local range, source, status, safe links and no executable title markup", () => {
  const runtime = load();
  const p = provider([event("current", "10:00", "11:00", {
    title: "<img onerror=alert(1)>", joinUrl: "https://example.com/meet", url: "javascript:alert(1)",
  })]);
  const { root, block } = mount(runtime, p);
  assert.match(root.content(), /10:00 - 11:00/);
  assert.match(root.content(), /Work/);
  assert.match(root.content(), /Now/);
  assert.equal(root.all().filter((node) => node.tag === "img").length, 0);
  assert.equal(root.all().filter((node) => node.tag === "a").length, 1);
  block.unload();
});

test("fetch errors never render as an empty successful calendar", () => {
  const runtime = load();
  const { root, block } = mount(runtime, provider([], { error: "forbidden" }));
  assert.match(root.content(), /Could not refresh: Work/);
  assert.doesNotMatch(root.content(), /Nothing scheduled/);
  block.unload();
});

test("empty, loading and out-of-window states have distinct messages", () => {
  for (const [state, expected] of [
    [{}, /Nothing scheduled/],
    [{ inFlight: true }, /Refreshing calendar events/],
    [{ fromMs: span.to }, /not available yet/],
  ]) {
    const runtime = load();
    const { root, block } = mount(runtime, provider([], state));
    assert.match(root.content(), expected);
    block.unload();
  }
});

test("manual refresh, cadence and midnight rollover work with only an embedded block open", () => {
  const runtime = load();
  const p = provider();
  const { root, block } = mount(runtime, p);
  assert.equal(p.calls.length, 1);
  block.update(false);
  assert.equal(p.calls.length, 1);
  root.all().find((node) => node.text === "Refresh").handlers.click();
  assert.equal(p.calls.length, 2);
  runtime.setTime("2026-10-26T10:05:01");
  block.update(false);
  assert.equal(p.calls.length, 3);
  runtime.setTime("2026-10-27T00:00:01");
  block.update(false);
  assert.equal(root.attrs["data-date"], "2026-10-27");
  assert.equal(p.calls.at(-1)[0], "2026-10-27");
  block.unload();
});

test("source updates coalesce and listeners/timers clean up when a note closes", async () => {
  const runtime = load();
  const p = provider();
  const { root, block } = mount(runtime, p);
  assert.equal(p.listeners.size, 1);
  assert.equal(runtime.timers.size, 1);
  assert.equal(runtime.domEvents.size, 1);
  p.events = [event("arrived", "10:00", "11:00")];
  for (const listener of p.listeners) { listener(); listener(); }
  await Promise.resolve();
  assert.match(root.content(), /arrived/);
  for (const listener of p.listeners) listener();
  block.unload();
  await Promise.resolve();
  assert.equal(p.listeners.size, 0);
  assert.equal(runtime.timers.size, 0);
  assert.equal(runtime.domEvents.size, 0);
});

test("connecting a new calendar fetches immediately without waiting for the polling interval", async () => {
  const runtime = load();
  const p = provider();
  p.states = [];
  const { root, block } = mount(runtime, p);
  assert.match(root.content(), /No calendar accounts connected/);
  p.states = [{ def: { label: "New calendar" }, st: null }];
  for (const listener of p.listeners) listener();
  await Promise.resolve();
  assert.equal(p.calls.length, 2);
  assert.equal(p.calls[1][2], false);
  assert.match(root.content(), /Refreshing calendar events/);
  block.unload();
});

test("provider replacement unsubscribes the old instance and recovers after enable", () => {
  const runtime = load();
  const old = provider();
  const { app, block, root } = mount(runtime, old);
  delete app.plugins.plugins.powerdesk;
  block.update(false);
  assert.equal(old.listeners.size, 0);
  assert.match(root.content(), /Enable Power Desk/);
  const replacement = provider();
  app.plugins.plugins.powerdesk = replacement;
  block.update(false);
  assert.equal(replacement.listeners.size, 1);
  assert.equal(replacement.calls.length, 1);
  block.unload();
});

test("invalid configuration and incompatible providers show visible errors", () => {
  for (const [p, source, expected] of [
    [provider(), "days: 3", /Use one date option/],
    [{ listeners: new Set() }, "date: today", /Incompatible Power Desk/],
  ]) {
    const runtime = load();
    const { root, block } = mount(runtime, p, source);
    assert.match(root.content(), expected);
    assert.equal(runtime.errors.length, 1);
    block.unload();
  }
});

test("Settings control opens the provider settings", () => {
  const runtime = load();
  const { root, block, opened } = mount(runtime, provider());
  root.all().find((node) => node.text === "Calendars").handlers.click();
  assert.deepEqual(opened, ["powerdesk"]);
  block.unload();
});

test("rows carry a valid source colour and swatch; invalid colours get neither", () => {
  const runtime = load();
  const p = provider([
    event("work", "09:00", "10:00", { color: "#4c7bd9" }),
    event("home", "11:00", "12:00", { color: "red;background:url(x)", calendarName: "Personal" }),
    event("typo", "13:00", "14:00", { color: "#12345", calendarName: "Typo" }),
  ]);
  const { root, block } = mount(runtime, p);
  const rows = root.all().filter((node) => node.classes.has("calendar-agenda-event"));
  const swatches = (row) => row.all().filter((node) => node.classes.has("calendar-agenda-swatch")).length;
  assert.equal(rows.length, 3);
  assert.equal(rows[0].style.props["--agenda-color"], "#4c7bd9");
  assert.equal(swatches(rows[0]), 1);
  for (const row of rows.slice(1)) {
    assert.equal(row.style.props["--agenda-color"], undefined);
    assert.equal(swatches(row), 0);
  }
  assert.match(root.content(), /Personal/);
  for (const ok of ["#abc", "#abcd", "#4c7bd9", "#4c7bd9ff"]) assert.equal(runtime.validColor(ok), true, ok);
  for (const bad of ["#12345", "#1234567", "red", "#4c7bd9;x", "", null, undefined]) {
    assert.equal(runtime.validColor(bad), false, String(bad));
  }
  block.unload();
});
