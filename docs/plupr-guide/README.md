# PLUPR player guide

A plain-language guide to PLUPR for players: what moves it, what stays inside a league season, and how to use it to find a good game.

## Files

| File | What it is |
| --- | --- |
| `plupr-guide.html` | The source. One HTML file, 8 Letter-size pages, all infographics as inline SVG. Edit this. |
| `PLUPR-Guide.pdf` | The printable guide, rendered from the HTML. 8 pages. |
| `infographics/*.png` | Each infographic on its own, 1200px wide, white background, for chat, social or slides. |
| `render.mjs` | Re-renders the PDF and all PNGs from the HTML. No npm install needed. |

The PNGs, one per `<figure class="infographic" id="ig-...">` in the HTML:

| PNG | Shows |
| --- | --- |
| `ig-plupr-hub.png` | Overall PLUPR and the numbers around it (singles, doubles, mixed, league) |
| `ig-scale.png` | The PLUPR scale and skill bands |
| `ig-match-flow.png` | Record, confirm, update; what never moves PLUPR |
| `ig-move-size.png` | How far your PLUPR moves in seven common results |
| `ig-season-timeline.png` | A league season: periods, locks, season end; overall keeps flowing |
| `ig-gap-bands.png` | What a PLUPR gap means for the game |
| `ig-doubles-balance.png` | Balancing doubles teams |

## Re-render after editing the HTML

Run from the repo root (needs Node and Microsoft Edge or Chrome, plus internet for the Google Fonts):

```powershell
node docs/plupr-guide/render.mjs
```

It prints each file with its size and the PDF page count, and exits with a `FAILED:` line if anything goes wrong. About 15 seconds. To use a specific browser, set `$env:BROWSER_EXE` to the full path of `msedge.exe` or `chrome.exe` first.

What it does:

1. Prints `plupr-guide.html` to `PLUPR-Guide.pdf` with headless Edge.
2. Writes one standalone HTML per infographic into `_png_src/` (same `<style>` block, 1200px wide, white background), measures its height, screenshots it to `infographics/<id>.png` at exactly that size, then deletes `_png_src/`.

### PDF only, by hand

```powershell
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --headless=new --disable-gpu --no-pdf-header-footer --user-data-dir="$env:TEMP\plupr-guide-render-profile" --virtual-time-budget=15000 --print-to-pdf="C:\Users\Brian\source\repos\pickleague\docs\plupr-guide\PLUPR-Guide.pdf" "file:///C:/Users/Brian/source/repos/pickleague/docs/plupr-guide/plupr-guide.html"
```

`--virtual-time-budget` gives the web fonts time to load. The separate `--user-data-dir` stops headless Edge from clashing with an Edge window you already have open.

## Editing notes

- Each `<section class="sheet">` is one printed page with a fixed height and `overflow: hidden`. If you add text and the page footer (`n / 8`) disappears from the PDF, the page overflowed: trim the text or move a block to another page.
- Page numbers in the cover's contents list and in each footer are typed by hand. Update them if you add or remove a page.
- SVG text does not wrap. Keep new SVG labels short, and check them in both the PDF and the PNGs after re-rendering.
