# JavArr

A Violentmonkey/Tampermonkey userscript that turns JavStash and StashDB
scene pages into one-click (or zero-click) Prowlarr grabs.

## What it does

**JavStash (automated)**
- Scene pages: an **Auto-Grab (Code)** button. Searches Prowlarr for the
  scene's code in all its forms (hyphenated, no-separator, unpadded),
  treats an exact code match as decisive, and grabs the best release
  (resolution first, then seeders/grabs, with a minimum-size floor).
- Listing pages (performer / studio / search grids): a **Batch Grab**
  button that works through every scene on the page the same way, with a
  live progress panel and a final tally including the miss list.

**StashDB (manual)**
- Scene pages: a **Search Prowlarr** button with scored, ranked results
  (studio / performer / title / date / code) and per-release grab buttons.
  StashDB uses western naming, so human pick stays in charge there.

Grabs go through Prowlarr's API (POST /api/v1/search) to whatever download
client Prowlarr is configured with.

## Install

With Violentmonkey installed, open the raw script URL and Violentmonkey
will offer to install it:

https://raw.githubusercontent.com/gurgles-1/javarr/main/javarr.user.js

Updates: the script carries @updateURL/@downloadURL pointing at that same
raw URL, so Violentmonkey's update check picks up new versions from here
automatically.

## Configure

On any JavStash/StashDB page, open the Violentmonkey menu:

- **JavArr: Configure Prowlarr** — Prowlarr URL + API key (stored in
  Violentmonkey storage, never in the script).
- **JavArr: Configure automation** — minimum auto-grab size (MB) and the
  batch per-run scene cap.

## Notes / limits

- Date-style codes (1pondo, Caribbeancom) don't parse as codes; those
  scenes fall back to literal search and manual picking.
- Exact-match logic is strict on purpose: SSIS-0012 does not match
  SSIS-001, and the studio prefix must agree, not just the number.
