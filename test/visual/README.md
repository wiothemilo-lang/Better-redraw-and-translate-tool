# Visual regression baselines

These screenshots catch layout, theme and library regressions that unit tests cannot see. They complement the desktop smoke test, which only captures an image when a flow fails.

## Views

| View | What it renders |
|---|---|
| `editor-light` | Editor with a committed fixture page, light theme |
| `editor-dark` | Same page, dark theme |
| `library` | Library with the committed catalog fixture, one series selected |

`npm run build` output is served by `vite preview` on `127.0.0.1:4173`, then headless Playwright Chromium renders each view with normal scrollbar geometry at 1280x800, device scale 1, locale `vi-VN`, reduced motion, greyscale text (`--disable-lcd-text`) and the sRGB colour profile (`--force-color-profile=srgb`). Each view uses a fresh browser context, blocks every non-local request, disables CSS animations and transitions, disables IndexedDB so autosave and recovery state cannot appear, waits for `document.fonts.ready`, blurs the focused element and screenshots after two animation frames. The editor page is the committed `test/fixtures/comic/screentone.lettered.png` fixture; the library catalog points at the same committed file copied into the preview output. No network, clock, random, storage or canvas-text dependency is part of a baseline.

## Canonical environment

Baselines are supported on Linux x64 only: Node 24 and the Chromium build installed by `npx playwright install chromium` (Playwright 1.65 / Chromium 159 when the baselines were captured). CI runs the comparison on `ubuntu-latest`.

Windows and macOS are intentionally not calibrated: they have no committed baselines, and the comparison exits with a skip message instead of passing silently. `test/visual/config.json` holds the per-platform tolerance, so a platform becomes supported only when a baseline set is captured and reviewed there.

The baselines in this repository were captured on Debian 13 with Playwright Chromium 159, and the Ubuntu runner compares against them with the same text and colour flags, so glyph rasterization stays independent of the host's fontconfig. Without `--disable-lcd-text` the runner drew LCD subpixel text where this machine draws greyscale: every glyph differed while layout, images and palette matched. A diff on CI now means the baseline or a real rendering change needs review, not that the gate is wrong.

## Tolerance

`channelThreshold: 8` means a channel must move by more than 8 levels before a pixel counts as different. `maxDiffPixels: 40` and `maxDiffPixelRatio: 0.000039` allow at most 40 of the 1,024,000 pixels to differ.

Measured before choosing those values:

- Repeated comparisons on the same machine: 0 differing pixels at ±8. The largest raw channel movement between runs was 1 level on 68 channels.
- Playwright Chromium 159 vs the system Chromium 154 on this machine: largest raw movement 1 level on 36 pixels, 0 differing pixels at ±8.
- 40 pixels is smaller than one rendered character at the app's 13-14 px sizes (~100+ px), so a changed word, control, layout block or theme colour fails. Palette tokens differ by more than 8 levels per channel, so a colour change is never hidden by the channel threshold.

Raising a tolerance requires a measured image difference and an explanation in review, the same rule as the fixture `maxMae` values.

## Compare (default)

```bash
npm run test:visual
```

Exit code 1 on any mismatch. Every run writes `artifacts/visual/<view>.actual.png` and `artifacts/visual/report.json`; a mismatch also writes `artifacts/visual/<view>.diff.png` with changed pixels in magenta over a faded actual page. CI uploads `artifacts/visual/` as `visual-diff-<os>` with `if: always()`.

## Update (operator only)

```bash
VISUAL_BASELINE_APPROVAL=1 npm run test:visual:update
```

The update path refuses to run when `CI` is set or when `VISUAL_BASELINE_APPROVAL` is not exactly `1`, and it refuses on an uncalibrated platform. It is not reachable from `npm test` or the CI workflow.

After an update, review the committed PNG diff before committing:

```bash
git diff --stat -- test/visual/baselines
git diff -- test/visual/baselines
```

A baseline change is an image review, not a test rerun: confirm every changed region is intended, and mention the reason in the commit message. Never commit a baseline diff that was not looked at.

## Files

- `scripts/visual-regression.mjs`: builds, serves, captures, compares, writes artifacts and owns the approval guard.
- `scripts/lib/visual-diff.mjs`: platform tolerance, image comparison, diff image and update guard.
- `scripts/lib/png.mjs`: dependency-free RGBA8 PNG encoder/decoder shared with the fixture generator.
- `test/visual/config.json`: views, viewport and per-platform tolerance.
- `test/visual/catalog.json`: library catalog used by the `library` view.
- `test/visual/baselines/linux/*.png`: committed baselines.
