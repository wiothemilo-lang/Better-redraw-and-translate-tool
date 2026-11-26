# Comic ground truth fixtures

The clean greenhouse panel is original art generated for this repository with OpenAI ImageGen. The character and scene are original. Canvas added the benchmark lettering after the clean image was saved. The small English and Japanese OCR cards were rendered with Canvas using Arial and Noto Sans CJK JP. No published manga pages or font files are included.

PNG files allow visual review. Gzipped RGBA files contain the same decoded pixels so Node tests work on Windows and Linux without an image decoder or canvas dependency. The manifest records dimensions, cleanup rectangles, lettering and expected OCR strings.

The white balloon and caption have restoration targets. The caption uses a four-pixel sampling ring contained inside the caption frame. The jacket and greenhouse glass are irregular-background cases. Their preservation checks require the worker to defer when it cannot reliably restore the background. Their remaining lettering error is reported explicitly.

Run `npm run desktop:native`, then `npm run benchmark -- --output artifacts/benchmark.json`. The report contains lettering MAE, unintended background change rate, per-case timing and OCR character error rate. The vertical OCR card requires the Tesseract `jpn_vert` language. Missing language data is recorded in the report. CI requires English on both platforms and installs vertical Japanese on Linux.

These fixtures are a small regression corpus. Add licensed or original examples with their clean reference, lettered input, annotations and provenance to expand coverage. Threshold changes should document the quality tradeoff alongside the image difference.
