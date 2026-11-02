# JavArr

A Violentmonkey/Tampermonkey userscript that turns JavStash and StashDB
pages into Prowlarr grabs — automated where the catalog is code-addressed
(JAV), carefully manual where it isn't (western scenes).

## What it does

**JavStash (automated)**
- Scene pages: an **Auto-Grab (Code)** button. Searches Prowlarr for the
  scene's code in all its forms (hyphenated, no-separator, unpadded),
  treats an exact code match as decisive, and grabs the best release
  (resolution first, then seeders/grabs, with a minimum-size floor).
- Listing pages: a **Batch Grab** button with a confirmation step and a
  **Scan only** dry-run mode. Every scene is checked against your skip
  list, your Stash library, and your Prowlarr grab history before anything
  is grabbed; the run ends with a full tally and an explicit miss list.
- Per-card **⬇ buttons** on grids for one-off grabs without a full batch.

**StashDB (full support, manual picks)**
- Scene pages: a **Search Prowlarr** button running a staged, escalating
  search — stage 1 fires five parallel queries (performers/studio/date/
  title combinations), **Try Harder** widens to the parent studio and
  performer aliases, **Last Chance** runs an unfiltered performer-only
  sweep sorted by publish-date proximity. Results are scored against five
  facts (studio, performers, title, date, code), accent-folded so "Zoë"
  matches "Zoe", and grouped by resolution.
- Listing pages: per-card buttons open the same staged search in a panel.

**Both sites**
- **Stash-owned badges**: with Stash configured, scenes already in your
  library show a green **✓ <resolution>** badge on cards and a banner on
  scene pages (one GraphQL query per page, not per scene), and automation
  never re-grabs what you own.
- **History-aware**: codes already grabbed through Prowlarr are detected
  and skipped by automation; manual override is always one click away.
- **Skip list**: codes automation must never touch (editable from the
  Violentmonkey menu, or per-scene via "Exclude this code").

## Install

With Violentmonkey installed, open the raw script URL and Violentmonkey
will offer to install it:

https://raw.githubusercontent.com/gurgles-1/javarr/main/javarr.user.js

The script carries @updateURL/@downloadURL pointing at that same raw URL,
so Violentmonkey's update check picks up new versions automatically.

## Configure

From the Violentmonkey menu on any JavStash/StashDB page:

- **JavArr: Configure Prowlarr** — Prowlarr URL + API key (stored in
  Violentmonkey storage, never in the script). Required.
- **JavArr: Configure Stash (owned badges)** — Stash URL + API key (blank
  key if Stash auth is off). Optional; enables owned badges/checks.
- **JavArr: Configure automation** — minimum auto-grab size (MB), batch
  per-run scene cap.
- **JavArr: Edit skip list** — the never-touch codes.

Grabs go through Prowlarr's API (POST /api/v1/search) to whatever download
client Prowlarr is configured with.

## Design credits

Several behaviors were adapted as *ideas* from two other StashDB tools —
[enymawse/stasharr](https://github.com/enymawse/stasharr) (GPL-3.0:
scene-status awareness, exclusion lists, bulk confirmation) and
[brewing8309/stasharr](https://github.com/brewing8309/stasharr) (PolyForm
Noncommercial: staged escalating search, aliases/parent-studio queries,
accent folding, Stash-owned card badges). No code was copied from either;
this implementation is original and MIT-licensed.

## Notes / limits

- Date-style codes (1pondo, Caribbeancom) don't parse as codes; those
  scenes fall back to literal search and manual picking.
- Exact-match logic is strict on purpose: SSIS-0012 does not match
  SSIS-001, and the studio prefix must agree, not just the number.
- Owned detection keys on the stash IDs Stash recorded from the site
  you're browsing; a scene tagged in Stash from a *different* source
  won't badge until it carries this site's ID.

## Tests

Pure matching logic (code parsing/matching, accent folding, scoring) is
unit-tested with plain node, no dependencies:

```
node tests/javarr.test.js
```
