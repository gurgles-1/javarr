# JavArr

A Violentmonkey/Tampermonkey userscript that wires JavStash and StashDB
scene pages directly to **Whisparr** — status, adds, searches and grabs,
without leaving the page. (v3.0.0 replaced the old Prowlarr backend with
Whisparr entirely.)

## What it does

**Scene pages (both sites)**
- One **Whisparr** button opens a status panel: already in Whisparr?
  Has a file? In your Stash library? On your skip list?
- Not in Whisparr yet: **Add to Whisparr + Search** or **Add only**
  (monitored, with your chosen root folder + quality profile — you're
  asked once, on the first add, and can reset it from the menu).
- In Whisparr without a file: **Search in Whisparr now** fires
  Whisparr's own automatic search, and **Show releases** lists what its
  indexers return — grouped by resolution, with Whisparr's rejection
  reasons shown — for a manual grab straight from the panel.

**Listing pages**
- **Batch Add** with a confirmation step and a **Scan only** dry run.
  Every scene is checked against your skip list, your Stash library and
  Whisparr's library first; the run ends with a full tally (added / has
  file / in Whisparr / owned / skip-list / not in metadata / errors).
- Per-card buttons with live state: **✓** with resolution = in your
  Stash, **✓ file** / **＝ in Whisparr** from Whisparr's inventory,
  **⬇** = click to add (+ search).

**JavStash bridging**
- Whisparr's metadata provider is StashDB, so JavStash scenes are
  resolved through Whisparr's own lookup by their code. An exact code
  match in the result title wins; a lone result is accepted; ambiguity
  resolves to "not in metadata" rather than guessing. Scenes Whisparr
  has no record of are reported as such, never force-added.

## Install

With Violentmonkey installed, open the raw script URL and Violentmonkey
will offer to install it:

https://raw.githubusercontent.com/gurgles-1/javarr/main/javarr.user.js

The script carries @updateURL/@downloadURL pointing at that same raw URL,
so Violentmonkey's update check picks up new versions automatically.

## Configure

From the Violentmonkey menu on any JavStash/StashDB page:

- **JavArr: Configure Whisparr** — Whisparr URL + API key (stored in
  Violentmonkey storage, never in the script). Required.
- **JavArr: Configure Stash (owned badges)** — Stash URL + API key
  (blank key if Stash auth is off). Optional; enables owned badges.
- **JavArr: Reset Whisparr root folder / profile** — re-pick on next add.
- **JavArr: Edit skip list** — JAV codes or StashDB scene IDs automation
  must never add.

## Design credits

Behaviors adapted as *ideas* from two other StashDB tools —
[enymawse/stasharr](https://github.com/enymawse/stasharr) (GPL-3.0:
scene-status model, bulk add with confirmation, the Whisparr API shapes)
and [brewing8309/stasharr](https://github.com/brewing8309/stasharr)
(PolyForm Noncommercial: accent folding, Stash-owned card badges).
No code was copied from either; this implementation is original and
MIT-licensed. GraphQL usage is verified against the stash-box and Stash
schemas; Whisparr calls use its Radarr-family /api/v3.

## Notes / limits

- The interactive release list uses Whisparr's `release` endpoint; the
  automatic Search button uses the verified `MoviesSearch` command.
  If a future Whisparr build renames the release endpoint, Search keeps
  working and the panel says so.
- Date-style codes (1pondo, Caribbeancom) don't parse as codes; those
  JavStash scenes resolve by their literal code string or not at all.
- Owned detection keys on the stash IDs Stash recorded from the site
  you're browsing.

## Tests

Pure matching logic (code parsing/matching, accent folding, lookup
resolution, skip list) is unit-tested with plain node, no dependencies:

```
node tests/javarr.test.js
```
