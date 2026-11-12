"use strict";

const { Plugin, MarkdownRenderChild } = require("obsidian");

function dayKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00`);
  return Number.isFinite(date.getTime()) && dayKey(date) === value;
}

function parseOptions(source) {
  let date = "note";
  let seen = false;
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^date:\s*(\S+)$/.exec(line);
    if (!match || seen) {
      throw new Error("Use one date option: today, note, or YYYY-MM-DD.");
    }
    date = match[1];
    seen = true;
    if (date !== "today" && date !== "note" && !validDate(date)) {
      throw new Error("Invalid agenda date. Use today, note, or YYYY-MM-DD.");
    }
  }
  return { date };
}

function resolveDate(options, sourcePath, now) {
  if (options.date === "today") return dayKey(now);
  if (options.date !== "note") return options.date;
  const basename = sourcePath.split("/").pop().replace(/\.md$/i, "");
  const match = /^(\d{4})-?(\d{2})-?(\d{2})(?=$|[- _])/.exec(basename);
  const key = match && `${match[1]}-${match[2]}-${match[3]}`;
  if (!key || !validDate(key)) {
    throw new Error("This note has no valid date filename. Set date: today or date: YYYY-MM-DD.");
  }
  return key;
}

function bounds(key) {
  const from = new Date(`${key}T00:00:00`);
  const to = new Date(from);
  to.setDate(to.getDate() + 1);
  return { from: from.getTime(), to: to.getTime() };
}

function safeLink(raw) {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return ["https:", "http:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

// CSS only accepts 3, 4, 6 or 8 hex digits; anything else would invalidate
// every declaration that reads --agenda-color instead of using its fallback.
function validColor(value) {
  return typeof value === "string" && /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value);
}

function normalizeEventDuration(event) {
  if (
    Number.isFinite(event.startMs) &&
    Number.isFinite(event.endMs) &&
    event.endMs === event.startMs
  ) {
    return { ...event, endMs: event.startMs + (event.allDay ? 864e5 : 6e4) };
  }
  return event;
}

function buildModel(provider, key, now) {
  const span = bounds(key);
  const states = provider.sourceStates();
  const failures = states.filter(({ st }) => st?.error).map(({ def }) => def.label);
  const loading = states.some(({ st }) => !st || st.inFlight);
  const uncovered = states.some(({ st }) => !st || st.fromMs > span.from || st.toMs < span.to);
  const seen = new Set();
  const events = provider.eventsForWindow(key, key).map(normalizeEventDuration).filter((event) => {
    if (
      typeof event.id !== "string" ||
      typeof event.sourceId !== "string" ||
      typeof event.title !== "string" ||
      !Number.isFinite(event.startMs) ||
      !Number.isFinite(event.endMs) ||
      event.endMs <= event.startMs
    ) {
      throw new Error("Power Desk returned an invalid calendar event. Update the integration.");
    }
    const id = JSON.stringify([event.sourceId, event.id]);
    if (seen.has(id) || event.endMs <= span.from || event.startMs >= span.to) return false;
    seen.add(id);
    return true;
  }).sort((a, b) =>
    Number(b.allDay) - Number(a.allDay) ||
    a.startMs - b.startMs ||
    a.title.localeCompare(b.title),
  );
  const timed = events.filter((event) => !event.allDay);
  const next = timed.find((event) => event.startMs > now.getTime());
  const fetched = states.map(({ st }) => st?.fetchedAt).filter((value) => value > 0);
  return {
    events,
    failures,
    loading,
    uncovered,
    connected: states.length > 0,
    lastUpdated: fetched.length ? Math.min(...fetched) : null,
    nextId: next ? JSON.stringify([next.sourceId, next.id]) : null,
  };
}

function eventStatus(event, nextId, now) {
  if (event.allDay) return "";
  const time = now.getTime();
  if (event.startMs <= time && time < event.endMs) return "Now";
  if (JSON.stringify([event.sourceId, event.id]) === nextId) return "Next";
  return event.endMs <= time ? "Ended" : "";
}

function formatTime(ms, use24h) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    ...(use24h ? { hourCycle: "h23" } : {}),
  }).format(new Date(ms));
}

class AgendaBlock extends MarkdownRenderChild {
  constructor(containerEl, plugin, source, sourcePath) {
    super(containerEl);
    this.plugin = plugin;
    this.source = source;
    this.sourcePath = sourcePath;
    this.provider = null;
    this.lastPoll = 0;
    this.lastDay = null;
    this.renderPending = false;
    this.disposed = false;
    this.lastError = null;
  }

  onload() {
    this.onProviderData = () => {
      if (this.renderPending || this.disposed) return;
      this.renderPending = true;
      queueMicrotask(() => {
        this.renderPending = false;
        if (!this.disposed) this.update(false);
      });
    };
    this.register(() => {
      this.disposed = true;
      this.provider?.listeners.delete(this.onProviderData);
    });
    this.registerInterval(window.setInterval(() => this.update(false), 30_000));
    this.registerDomEvent(window, "focus", () => this.update(false));
    this.update(false);
  }

  openSettings() {
    this.plugin.app.setting.open();
    this.plugin.app.setting.openTabById("powerdesk");
  }

  update(force) {
    if (this.disposed) return;
    try {
      const options = parseOptions(this.source);
      const now = new Date();
      const key = resolveDate(options, this.sourcePath, now);
      const candidate = this.plugin.app.plugins.plugins.powerdesk;
      if (candidate !== this.provider) {
        this.provider?.listeners.delete(this.onProviderData);
        this.provider = null;
        this.lastPoll = 0;
        if (candidate) {
          for (const method of ["sourceStates", "ensureWindow", "eventsForWindow"]) {
            if (typeof candidate[method] !== "function") {
              throw new Error("Incompatible Power Desk version. Calendar Agenda supports Power Desk 2.12.2.");
            }
          }
          if (!candidate.listeners?.add || !candidate.listeners?.delete) {
            throw new Error("Power Desk is missing calendar update notifications.");
          }
          this.provider = candidate;
          this.provider.listeners.add(this.onProviderData);
        }
      }
      const el = this.containerEl;
      el.empty();
      el.addClass("calendar-agenda");
      el.setAttribute("aria-label", "Calendar agenda");
      el.setAttribute("data-date", key);
      const header = el.createDiv({ cls: "calendar-agenda-header" });
      header.createEl("strong", {
        text: new Intl.DateTimeFormat(undefined, { weekday: "long", month: "short", day: "numeric" })
          .format(new Date(`${key}T12:00:00`)),
      });
      const controls = header.createDiv({ cls: "calendar-agenda-controls" });
      const settings = controls.createEl("button", { text: "Calendars", attr: { type: "button" } });
      settings.addEventListener("click", () => this.openSettings());
      if (!this.provider) {
        el.createEl("p", { text: "Enable Power Desk to connect your calendar accounts.", cls: "calendar-agenda-state" });
        return;
      }
      const refresh = controls.createEl("button", { text: "Refresh", attr: { type: "button" } });
      refresh.addEventListener("click", () => this.update(true));
      const cadence = Math.max(1, Number(this.provider.settings.refreshMinutes) || 5) * 60_000;
      const due = force || key !== this.lastDay || now.getTime() - this.lastPoll >= cadence;
      const span = bounds(key);
      const missing = this.provider.sourceStates().some(({ st }) =>
        !st || (!st.inFlight && (st.fromMs > span.from || st.toMs < span.to)),
      );
      if (due) {
        this.lastDay = key;
        this.lastPoll = now.getTime();
      }
      if (due || missing) this.provider.ensureWindow(key, key, due);
      const model = buildModel(this.provider, key, now);
      el.setAttribute("aria-busy", String(model.loading));
      if (!model.connected) {
        el.createEl("p", {
          cls: "calendar-agenda-state",
          text: "No calendar accounts connected. Open Calendars to add an account or a read-only ICS feed.",
        });
        return;
      }
      if (model.failures.length) {
        el.createEl("p", {
          cls: "calendar-agenda-error",
          attr: { role: "alert" },
          text: `Could not refresh: ${model.failures.join(", ")}. Any events below may be cached. Retry Refresh or reconnect in Calendars.`,
        });
      }
      if (model.loading) {
        el.createEl("p", { text: "Refreshing calendar events...", cls: "calendar-agenda-state", attr: { role: "status" } });
      }
      if (!model.events.length && !model.loading && !model.failures.length) {
        el.createEl("p", {
          text: model.uncovered ? "Calendar data for this date is not available yet. Press Refresh." : "Nothing scheduled.",
          cls: "calendar-agenda-state",
        });
      }
      const list = el.createEl("ul", { cls: "calendar-agenda-events" });
      for (const event of model.events) {
        const status = eventStatus(event, model.nextId, now);
        const row = list.createEl("li", {
          cls: `calendar-agenda-event${status === "Now" ? " is-current" : ""}${status === "Ended" ? " is-ended" : ""}`,
        });
        const color = validColor(event.color) ? event.color : null;
        if (color) row.style.setProperty("--agenda-color", color);
        row.createDiv({
          cls: "calendar-agenda-time",
          text: event.allDay ? "All day" :
            `${formatTime(event.startMs, this.provider.settings.use24h)} - ${formatTime(event.endMs, this.provider.settings.use24h)}`,
        });
        const details = row.createDiv({ cls: "calendar-agenda-details" });
        details.createDiv({ cls: "calendar-agenda-title", text: event.title });
        const meta = details.createDiv({ cls: "calendar-agenda-meta" });
        const calendar = meta.createSpan({ cls: "calendar-agenda-calendar" });
        if (color) calendar.createSpan({ cls: "calendar-agenda-swatch", attr: { "aria-hidden": "true" } });
        calendar.createSpan({ text: event.calendarName || "Calendar" });
        if (event.location) meta.createSpan({ text: event.location });
        if (status) meta.createSpan({ text: status, cls: "calendar-agenda-badge" });
        const actions = row.createDiv({ cls: "calendar-agenda-actions" });
        for (const [label, raw] of [["Join", event.joinUrl], ["Open", event.url]]) {
          const href = safeLink(raw);
          if (href) {
            actions.createEl("a", {
              text: label,
              attr: { href, target: "_blank", rel: "noopener noreferrer", "aria-label": `${label}: ${event.title}` },
            });
          }
        }
      }
      if (model.lastUpdated) {
        el.createDiv({
          cls: "calendar-agenda-updated",
          text: `Calendar cache updated ${formatTime(model.lastUpdated, this.provider.settings.use24h)}. Times are local.`,
        });
      }
      this.lastError = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== this.lastError) {
        console.error("Calendar Agenda:", message);
        this.lastError = message;
      }
      this.containerEl.empty();
      this.containerEl.addClass("calendar-agenda");
      this.containerEl.createEl("p", { text: message, cls: "calendar-agenda-error", attr: { role: "alert" } });
    }
  }
}

class CalendarAgendaPlugin extends Plugin {
  onload() {
    this.registerMarkdownCodeBlockProcessor("calendar-agenda", (source, el, context) => {
      context.addChild(new AgendaBlock(el, this, source, context.sourcePath));
    });
    this.addCommand({
      id: "open-calendar-settings",
      name: "Connect calendar accounts",
      callback: () => {
        this.app.setting.open();
        this.app.setting.openTabById("powerdesk");
      },
    });
  }
}

module.exports = CalendarAgendaPlugin;
module.exports.internals = { dayKey, validDate, parseOptions, resolveDate, bounds, safeLink, validColor, normalizeEventDuration, buildModel, eventStatus, AgendaBlock };
