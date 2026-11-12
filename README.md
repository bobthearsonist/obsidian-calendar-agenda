# Calendar Agenda

A read-only daily agenda block for Obsidian, backed by calendar accounts already connected through [Power Desk](https://github.com/obsidian-power-plugins).

## Requirements

- Obsidian 1.8.7 or later
- Power Desk 2.12.2 enabled with at least one calendar source

Calendar Agenda does not authenticate accounts or store credentials. It reads Power Desk's in-memory calendar sources and cache.

## Usage

Add a `calendar-agenda` code block to any note:

````markdown
```calendar-agenda
date: today
```
````

Supported date values:

- `today` - always show the current day.
- `note` - derive the date from a filename beginning with `YYYYMMDD` or `YYYY-MM-DD`.
- `YYYY-MM-DD` - show a fixed date.

If `date` is omitted, `note` is used.

## Features

- All-day and timed events
- Localized dates and 12/24-hour time from Power Desk settings
- Current, next, and ended status indicators
- Per-calendar colors: a colored bar, light row tint, and swatch beside the calendar name
- Locations, join links, and event links
- Manual refresh and direct access to Power Desk calendar settings
- Cached-event display when a source cannot refresh
- Read-only operation; Calendar Agenda never creates, edits, or deletes events

Equal start and end timestamps are displayed as one minute for timed events or one day for all-day events. Negative durations remain invalid.

## Installation

Download `main.js`, `manifest.json`, and `styles.css` from the latest release and place them in:

```text
<vault>/.obsidian/plugins/calendar-agenda/
```

Enable Power Desk, connect the desired calendar accounts, then enable Calendar Agenda in Obsidian's Community plugins settings.

## Release files

This repository contains the runtime plugin directly; no build step is required.

## Development

Tests use Node's built-in test runner and a stubbed Obsidian API, so there are no dependencies to install:

```sh
npm test
```

## License

[MIT](LICENSE)
