using System.Diagnostics;
using System.Text;
using System.Globalization;
using System.Text.Json.Nodes;

internal static class LocalOcr
{
    private static string Executable => Environment.GetEnvironmentVariable("KHUNG_THOAI_TESSERACT") ?? "tesseract";

    private static async Task<string> Run(params string[] arguments)
    {
        using var process = new Process { StartInfo = new ProcessStartInfo(Executable) {
            RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8,
        }};
        foreach (var argument in arguments) process.StartInfo.ArgumentList.Add(argument);
        try { process.Start(); }
        catch { throw new InvalidOperationException("Chưa tìm thấy Tesseract. Cài Tesseract hoặc đặt KHUNG_THOAI_TESSERACT."); }
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(arguments[0] == "--list-langs" ? 5 : 75));
        try { await process.WaitForExitAsync(timeout.Token); }
        catch (OperationCanceledException)
        {
            process.Kill(true);
            await process.WaitForExitAsync();
            throw new TimeoutException("OCR vượt thời gian xử lý.");
        }
        var output = await stdout;
        var error = await stderr;
        if (process.ExitCode != 0) throw new InvalidOperationException("Tesseract: " + error.Trim());
        return output;
    }

    internal static async Task<JsonObject> Capabilities()
    {
        var result = new JsonObject {
            ["protocol"] = 1,
            ["operations"] = new JsonArray("redraw", "mask", "inpaint", "preprocess", "ocr", "png", "zip", "project"),
            ["languages"] = new JsonArray(),
        };
        try
        {
            var output = await Run("--list-langs");
            result["languages"] = new JsonArray(output.Split('\n').Skip(1).Select(line => line.Trim())
                .Where(line => line.Length > 0).Select(line => (JsonNode?)JsonValue.Create(line)).ToArray());
        }
        catch (Exception error) { result["ocrError"] = error.Message; }
        return result;
    }

    internal static async Task<JsonObject> Recognize(JsonObject options, byte[] data)
    {
        var (width, height) = NativeImaging.Dimensions(options, data.Length);
        var language = (string?)options["language"] ?? "eng";
        if (!language.All(ch => char.IsAsciiLetterOrDigit(ch) || ch is '_' or '+') || language.Length > 100)
            throw new InvalidDataException("Invalid OCR language.");
        var psm = (int?)options["psm"] ?? 11;
        if (psm is not (3 or 5 or 6 or 11)) throw new InvalidDataException("Invalid OCR segmentation.");
        var (processed, pixels) = NativeImaging.Preprocess(options, data);
        var scaledWidth = (int)processed["width"]!;
        var scaledHeight = (int)processed["height"]!;
        var path = Path.Combine(Path.GetTempPath(), "khung-thoai-ocr-" + Guid.NewGuid() + ".png");
        try
        {
            await File.WriteAllBytesAsync(path, NativeImaging.Png(pixels, scaledWidth, scaledHeight));
            NativeProgress.Emit(75, "Tesseract đang nhận dạng chữ");
            var tsv = await Run(path, "stdout", "-l", language, "--psm", psm.ToString(), "tsv");
            NativeProgress.Emit(90, "Ghép dòng và chuẩn hóa tọa độ");
            var groups = new Dictionary<string, List<string[]>>();
            foreach (var row in tsv.Split('\n').Skip(1))
            {
                var cells = row.TrimEnd('\r').Split('\t', 12);
                if (cells.Length != 12 || cells[0] != "5" || string.IsNullOrWhiteSpace(cells[11]) ||
                    !double.TryParse(cells[10], CultureInfo.InvariantCulture, out var confidence) || confidence < 0) continue;
                var key = string.Join("-", cells.Take(5));
                if (!groups.TryGetValue(key, out var words)) groups[key] = words = [];
                words.Add(cells);
            }
            var lines = new JsonArray();
            foreach (var words in groups.Values)
            {
                var left = words.Min(word => int.Parse(word[6]));
                var top = words.Min(word => int.Parse(word[7]));
                var right = words.Max(word => int.Parse(word[6]) + int.Parse(word[8]));
                var bottom = words.Max(word => int.Parse(word[7]) + int.Parse(word[9]));
                var l = Normalize(left, scaledWidth);
                var t = Normalize(top, scaledHeight);
                var r = Normalize(right, scaledWidth);
                var b = Normalize(bottom, scaledHeight);
                var (rl, rt, rr, rb) = ((int?)options["rotation"] ?? 0) switch {
                    90 => (t, 1000 - r, b, 1000 - l),
                    180 => (1000 - r, 1000 - b, 1000 - l, 1000 - t),
                    270 => (1000 - b, l, 1000 - t, r),
                    _ => (l, t, r, b),
                };
                var normLeft = Math.Clamp(rl, 0, 999);
                var normTop = Math.Clamp(rt, 0, 999);
                var normRight = Math.Clamp(rr, normLeft + 1, 1000);
                var normBottom = Math.Clamp(rb, normTop + 1, 1000);
                var joined = language.StartsWith("jpn") || language.StartsWith("chi")
                    ? string.Join("", words.Select(word => word[11]))
                    : JoinWords(words.Select(word => word[11]));
                lines.Add((JsonNode)new JsonObject {
                    ["id"] = "L" + (lines.Count + 1),
                    ["text"] = joined,
                    ["box"] = new JsonArray(normLeft, normTop, normRight, normBottom),
                    ["confidence"] = words.Average(word => double.Parse(word[10], CultureInfo.InvariantCulture)),
                });
            }
            return new JsonObject { ["lines"] = lines, ["width"] = width, ["height"] = height };
        }
        finally { File.Delete(path); }
    }

    private static string JoinWords(IEnumerable<string> words)
    {
        var builder = new StringBuilder();
        char? previous = null;
        foreach (var word in words)
        {
            if (string.IsNullOrEmpty(word)) continue;
            if (previous is { } prev && !(IsCjk(prev) && IsCjk(word[0])))
                builder.Append(' ');
            builder.Append(word);
            previous = word[^1];
        }
        return builder.ToString();
    }

    private static bool IsCjk(char ch) =>
        ch is (>= '\u3000' and <= '\u9fff') or (>= '\uf900' and <= '\ufaff') or (>= '\uff00' and <= '\uffef');

    private static int Normalize(int value, int total) => Math.Clamp((int)Math.Round(value * 1000d / total), 0, 1000);
}
