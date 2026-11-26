# Native processing

The Electron renderer calls a narrow preload API. The main process validates the calling frame, owns file dialogs and resolves file paths. A persistent C# worker handles pixel operations and project streams. The browser build uses Canvas and browser downloads.

## Build and OCR

Use .NET 10 SDK and run `npm run desktop:native`. The published executable includes its .NET runtime. `KHUNG_THOAI_DOTNET` can point to a specific SDK executable.

Local OCR uses Tesseract CLI. Install Tesseract and the language data needed by the project. The UI lists installed languages. Set `KHUNG_THOAI_TESSERACT` to override the executable and `TESSDATA_PREFIX` to select a data directory. Missing OCR dependencies leave the other native operations available.

To include OCR in a desktop package, set `KHUNG_THOAI_OCR_BUNDLE` to a directory containing `tesseract` (or `tesseract.exe`), `tessdata/`, and its platform dependencies and license notices before running `desktop:package`. This directory is copied into the native worker resources. Supply binaries for the packaging target. System Tesseract is used when an embedded bundle is absent.

Tesseract TSV output is grouped by line and coordinates are mapped back through crop and scale to the original page. Low-confidence words are omitted. See the [official CLI and TSV documentation](https://github.com/tesseract-ocr/tessdoc/blob/main/Command-Line-Usage.md).

## Protocol

The legacy 24-byte redraw input remains available when launching the executable without arguments. Electron uses `--rpc`.

Each RPC frame consists of the ASCII magic `KTR1`, a uint32 little-endian JSON byte count, a uint32 little-endian payload byte count, UTF-8 JSON, then binary bytes. JSON is limited to 4 MiB and payloads to 512 MiB. Requests contain `version: 1`, `operation` and `options`. Replies contain `version: 1`, `ok`, operation metadata and optional bytes. Failed operations return `ok: false` and `error`. A malformed frame terminates the process. Operation failures keep the stream synchronized.

- `capabilities` returns supported operation categories and installed OCR languages.
- `redraw` accepts sample RGBA plus an inner rectangle and returns a transparent recovered patch.
- `mask` accepts patch RGBA, original-image coordinates, brush strokes and a signed dilation/erosion radius. Stroke widths are normalized by the shorter original-image dimension.
- `preprocess` returns contrast-normalized grayscale RGBA with optional cross-median denoising and 1–3× scaling. Scaling is reduced to 1× when it would exceed the 28-million-pixel limit.
- `ocr` preprocesses RGBA and returns recognized lines with integer boxes in the 0–1000 coordinate space. Supported segmentation modes are automatic page, single block and sparse text.
- `png` composites original RGBA, a transparent text/background layer and ordered cleanup patches, then encodes PNG. Font measurement and text rasterization use Canvas, shared with the preview. Editable PSD layers use ag-psd.
- `zipBegin`, `zipPage` and `fileCommit` stream a batch into a temporary ZIP and replace the destination only when finished.
- `fileBegin`, `fileAppend`, `fileCommit` and `fileCancel` write projects in chunks. A previous file can be retained as `.bak`.
- `fileOpen`, `fileReadNext` and `fileClose` read in 4-MiB chunks through one open file handle. An atomic replacement during a read does not mix two project versions. `fileRead` also provides internal offset-based reads.

Only the main process can request file operations. Renderer-visible IDs are mapped to native handles. Paths are obtained from dialogs or the app recovery directory. Failed batch operations cancel the temporary transfer. A hard process crash can leave a uniquely named temporary file beside the destination, while the last committed project stays intact.

## Extending the worker

Add an operation implementation in a focused C# file and register it in `NativeRpc`. Include its category in `capabilities`. Expose it through the renderer allowlist only if it needs no filesystem access. File operations go through `ProjectFiles`, which owns their paths and handles.

Use binary payloads for images and retain structured metadata for coordinates and options. Change the protocol version for incompatible framing changes. Keep optional project fields backward compatible and validate them in `src/project.js`. Test error recovery, boundaries, alpha compositing and cancellation alongside successful requests.

## Recovery

The desktop renderer snapshots the current project every 20 seconds after edits, and flushes the latest snapshot when closing an idle window. Closing during an active user operation asks the user to wait for that operation to complete. A snapshot contains the same data as the portable project and excludes the Gemini API key. The current and previous recovery snapshots appear as separate restore buttons at startup. A failed or cancelled project load leaves the current editor intact.

The main window requests a renderer flush before closing. The worker shuts down at `will-quit`, after the final committed snapshot. Images and native export layers are processed page by page. PNG ZIP output is written to disk without holding the whole chapter archive in the renderer.

## Task isolation and progress

Long image operations run through `TaskQueue` in an isolated worker process. Each has an ID, queued/running/done/error/cancelled state, progress and stage text. The RPC stream accepts optional `event: "progress"` frames before the final reply. Receivers must handle several frames arriving in one stdout chunk.

Cancelling a queued task removes it before execution. Cancelling an active task terminates that isolated process and its OCR child process tree. A separate persistent image worker handles redraw/masks, and another persistent worker owns file handles. ZIP page encoding uses the image task queue and appends the finished PNG through the file worker. A failed or cancelled page aborts the uncommitted ZIP.

The renderer controllers live in `src/controllers/`. Project persistence, translation, OCR review, export preflight and task status are initialized through explicit dependencies from the editor. Pure OCR grouping and coordinate conversion are in `src/ocr.js`.

Project recovery now stores up to ten committed snapshots per portable project ID in `userData/projects/<id>/`. A metadata catalog records recent saved-file paths and names. Snapshot writes use the existing atomic C# transfer API, while the main process owns catalog paths and atomic metadata updates. The legacy recovery file and its backup remain readable.
