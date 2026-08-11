# CODE CITY — Visual Spec (derived from the reference screenshot)

Reference frame: **1672 × 941** px. All coordinates below are measured in that
frame. The viewer is built to reproduce it 1:1 at that viewport, and to degrade
gracefully at other sizes.

> Note on method: the reference is an image attachment in the conversation, which
> subagents do not receive. The measurements below were taken directly off the
> image and are the single source of truth for the build; the screenshot-compare
> loop checks the render against this list item by item.

---

## 0. Global

| Token | Value | Use |
|---|---|---|
| `--bg` | `#000000` | page background |
| `--panel` | `#04070800` → effectively transparent over black | panel fill |
| `--panel-head` | `rgba(255,255,255,0.018)` | panel header strip |
| `--line` | `rgba(140,170,168,0.155)` | 1px hairline borders / dividers |
| `--line-strong` | `rgba(190,215,212,0.30)` | button borders |
| `--text` | `#e4ebea` | values, headings |
| `--text-2` | `#a7b5b2` | log body text |
| `--dim` | `#5d6b69` | micro labels, urls, axis |
| `--dim-2` | `#3c4746` | separators `·` |
| `--cyan` | `#00E5FF` | the one accent: LIVE dots, icons, underline |
| `--ok` | `#4fd07f` | `✓` in system status |

Recency gradient (buildings, timeline bars, legend) — 5 stops:
`#22C7D6` → `#63D66A` → `#E3D23C` → `#F0902B` → `#E23B2B`

Font: **JetBrains Mono** (self-hosted, weights 400/500), fallback
`ui-monospace, SFMono-Regular, Menlo, monospace`. Everything is monospace.
No gradients on surfaces, no shadows, no border-radius (except the playhead dot
and LIVE dots), 1px hairlines only.

---

## 1. Top bar — full width, height 56, bottom hairline

- `CODE CITY` — x22, 15px, `letter-spacing: .30em`, `--text`.
- cyan dot (ø6) at x188 + `LIVE` 9.5px `.18em` `--text-2`.
- vertical hairline at **x418**, full bar height (aligns with the left rail edge).
- `MODEL VIEW` at x445, 11px `.10em`; `MODEL` dim / `VIEW` bright, 1px underline
  under the pair.
- status line from x545, 11px:
  `$ rendering frame N / M · X buildings · Y LOC`; `$` cyan, text `--text-2`,
  `·` in `--dim-2`.
- right: `§03 EXPORT` 11px with underline, ending x1465.
- `⬆ EXPORT MP4` button: x1493→1655, y10→42 (h32), 1px `--line-strong`,
  10.5px `.16em`.

## 2. Left rail — x10→409 (w 399), gutter 10 left / 9 right of the x418 divider

Panels are 1px-bordered boxes. Each has a 36px header row with a bottom
hairline: `§NN TITLE` at 11px `.14em` on the left (padding-left 16), and
`● LIVE` right-aligned (padding-right 16).

### §01 REPOSITORY — y68→348 (h280)
- body padding 20.
- repo mark 34×34 at x30,y118 (cyan stroke icon).
- `owner / name` at x80, 19px, `--text`; the `/` is `--dim`.
- clone url below at x80, 10px, `--dim`.
- **stats grid, full-bleed** (no side padding): 3 equal columns, vertical
  hairlines at 1/3 and 2/3; 2 rows with a horizontal hairline between and above.
  Cell padding: 19 left, 14 top, 14 bottom.
  - label 9px `.11em` `--dim`; value 15px `--text`.
  - row 1: `STARS` / `FORKS` / `CONTRIBUTORS`
  - row 2: `COMMITS` / `FILES` / `LINES OF CODE`
- footer row (top hairline, h34): `UPDATED n MIN AGO` 9px `.11em` `--dim`, and
  `● LIVE` on the right — this dot is **yellow-green** (`#9BD64A`), not cyan.

### §02 CITY METRICS — y365→583 (h218)
- grid, full-bleed, columns `1fr 1fr 1.3fr`, 2 rows, hairline dividers.
  - row 1: `DENSITY` / `CHURN` / `GROWTH`
  - row 2: `BUILDINGS` / `DISTRICTS` / `AVG HEIGHT`
- legend row at the bottom (padding 20): `OLDER` 9px dim · gradient bar
  (h7, flex-1, the 5-stop ramp) · `NEWER` 9px dim.

### §03 SYSTEM STATUS — y600→790
- 6 log rows, 11px, line-height 22, padding 20:
  `$ ` in `--cyan` at 70% opacity, message in `--text-2`, right-aligned result
  which is either `✓` in `--ok` or a dim value like `240 frames`.

### Meta strip — bottom of the rail, 3 cells, vertical hairlines
`MODEL / CODECITY-1` · `RESOLUTION / N FRAMES` · `SAMPLE / ADAPTIVE`
label 8.5px `.11em` dim, value 11.5px `--text`.

## 3. City view — x420→1672, y56→~690

- `CITY VIEW ● LIVE` overlay at x443,y86 — 11px `.16em`.
- district labels floated over the canvas at the projected district centre:
  11px `.16em`, `#c9d4d2`, no background.
- compass: bordered box x1523→1652, y72→188. `N/E/S/W` 8px dim at the edges,
  a white chevron/needle pointing to north, rotating with camera azimuth.
- `TOP VIEW` button directly under it, x1523→1652, y190→228, shares the border.
- canvas: near-black `#000`, exponential fog, district plates as thin dark
  slabs with hairline edges, buildings as instanced boxes, top faces lit.

## 4. §02 TIMELINE — x432→1660, y700→925

- header (h36): `§02 TIMELINE ● LIVE`; `FRAME n / m` 10px, **centred over the
  playhead**, not right-aligned to the panel.
- histogram: bars 3px wide / 2px gap, baseline hairline; bar colour = recency
  ramp position of that frame.
- playhead: 1px white vertical line + ø16 white dot sitting on the baseline.
- year axis: 10px `--dim`; the current frame's year is `--text` + underlined.
- hairline above the control row.
- control row (h70), left→right, vertical hairlines between groups:
  `▶` (bordered 57×40) · `|◀` · `▶|` · `1x` ·
  `DATE / 2022-06-14` · `COMMIT / a1b2c3d` · `BUILDINGS / 1,842` · `LOC / 2.47M` ·
  `⛶ FLYTHROUGH` (bordered) · fullscreen icon (bordered 40×40).
  label 8.5px dim / value 12.5px `--text`.

---

## Day 1 scope

Everything above is built. **Interaction that is explicitly Day 2** and therefore
present but inert on Day 1: timeline scrubbing, play/step, speed, flythrough,
export MP4, top view toggle. The timeline renders **real** histogram data and
the playhead is pinned to the final frame.
