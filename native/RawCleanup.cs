using System.Text.Json.Nodes;

/// <summary>
/// Smart manga raw page cleanup: adaptive auto-levels (whitens yellowed/gray paper
/// and deepens faded ink) + edge-preserving bilateral denoise (removes JPEG artifacts
/// without destroying screentones) + gentle unsharp mask.
/// </summary>
internal static class RawCleanup
{
    internal static (JsonObject, byte[]) Execute(JsonObject options, byte[] data)
    {
        var (width, height) = NativeImaging.Dimensions(options, data.Length, 28_000_000);
        var strength = Math.Clamp((double?)options["strength"] ?? 0.7, 0.0, 1.0);
        var denoise = (bool?)options["denoise"] ?? true;
        var sharpen = (bool?)options["sharpen"] ?? true;

        var pixelCount = width * height;
        var output = new byte[data.Length];
        Buffer.BlockCopy(data, 0, output, 0, data.Length);

        // 1. Luminance + per-channel histograms & near-grayscale detection.
        var histL = new int[256];
        var histR = new int[256];
        var histG = new int[256];
        var histB = new int[256];
        var lowSatCount = 0;
        for (var i = 0; i < pixelCount; i++)
        {
            var o = i * 4;
            int r = output[o], g = output[o + 1], b = output[o + 2];
            var luma = (r * 77 + g * 150 + b * 29) >> 8;
            histL[luma]++;
            histR[r]++;
            histG[g]++;
            histB[b]++;
            var maxC = Math.Max(r, Math.Max(g, b));
            var minC = Math.Min(r, Math.Min(g, b));
            if (maxC - minC <= 26) lowSatCount++;
        }

        var isMostlyGrayscale = lowSatCount > pixelCount * 0.88;
        var blackTarget = (int)(pixelCount * (0.012 * strength + 0.003));
        var whiteTarget = (int)(pixelCount * (1.0 - (0.055 * strength + 0.01)));

        static int Percentile(int[] hist, int target)
        {
            var acc = 0;
            for (var i = 0; i < 256; i++)
            {
                acc += hist[i];
                if (acc >= target) return i;
            }
            return 255;
        }

        static byte[] BuildLut(int lo, int hi)
        {
            lo = Math.Min(lo, 68);
            hi = Math.Max(hi, 185);
            if (hi - lo < 40) { lo = 0; hi = 255; }
            var lut = new byte[256];
            var span = (double)(hi - lo);
            for (var i = 0; i < 256; i++)
            {
                var norm = Math.Clamp((i - lo) / span, 0.0, 1.0);
                lut[i] = (byte)Math.Clamp((int)Math.Round(norm * 255.0), 0, 255);
            }
            return lut;
        }

        var low = Percentile(histL, blackTarget);
        var high = Percentile(histL, whiteTarget);

        // On mostly grayscale/sepia scans, stretch R/G/B white points independently to neutralize paper yellowing.
        var lutR = isMostlyGrayscale ? BuildLut(Percentile(histR, blackTarget), Percentile(histR, whiteTarget)) : BuildLut(low, high);
        var lutG = isMostlyGrayscale ? BuildLut(Percentile(histG, blackTarget), Percentile(histG, whiteTarget)) : lutR;
        var lutB = isMostlyGrayscale ? BuildLut(Percentile(histB, blackTarget), Percentile(histB, whiteTarget)) : lutR;

        for (var i = 0; i < pixelCount; i++)
        {
            var o = i * 4;
            output[o] = lutR[output[o]];
            output[o + 1] = lutG[output[o + 1]];
            output[o + 2] = lutB[output[o + 2]];
        }

        // 2. Fast edge-preserving 3x3 bilateral denoise (preserves crisp ink & screentones).
        if (denoise && strength > 0.05)
        {
            var rangeSigma = (float)(12.0 + 18.0 * strength);
            var invTwoSigmaSq = 1f / (2f * rangeSigma * rangeSigma);
            var src = (byte[])output.Clone();
            for (var y = 1; y < height - 1; y++)
            {
                var row = y * width;
                for (var x = 1; x < width - 1; x++)
                {
                    var co = (row + x) * 4;
                    float cr = src[co], cg = src[co + 1], cb = src[co + 2];
                    float sr = 0, sg = 0, sb = 0, wSum = 0;
                    for (var dy = -1; dy <= 1; dy++)
                    {
                        var nRow = (y + dy) * width;
                        for (var dx = -1; dx <= 1; dx++)
                        {
                            var no = (nRow + x + dx) * 4;
                            float nr = src[no], ng = src[no + 1], nb = src[no + 2];
                            var dr = nr - cr;
                            var dg = ng - cg;
                            var db = nb - cb;
                            var distSq = (dr * dr + dg * dg + db * db) * (1f / 3f);
                            var spatial = (dx == 0 && dy == 0) ? 1.5f : (dx == 0 || dy == 0 ? 1.0f : 0.65f);
                            var w = spatial * MathF.Exp(-distSq * invTwoSigmaSq);
                            sr += nr * w;
                            sg += ng * w;
                            sb += nb * w;
                            wSum += w;
                        }
                    }
                    var inv = 1f / wSum;
                    output[co] = ClampByte(sr * inv);
                    output[co + 1] = ClampByte(sg * inv);
                    output[co + 2] = ClampByte(sb * inv);
                }
            }
        }

        // 3. Gentle unsharp mask for crisp lineart.
        if (sharpen && strength > 0.1)
        {
            var amount = (float)(0.25 + 0.35 * strength);
            var src = (byte[])output.Clone();
            for (var y = 1; y < height - 1; y++)
            {
                var row = y * width;
                for (var x = 1; x < width - 1; x++)
                {
                    var co = (row + x) * 4;
                    var up = ((y - 1) * width + x) * 4;
                    var dn = ((y + 1) * width + x) * 4;
                    var lf = (row + x - 1) * 4;
                    var rt = (row + x + 1) * 4;
                    for (var c = 0; c < 3; c++)
                    {
                        var center = (float)src[co + c];
                        var blur = (center * 4f + src[up + c] + src[dn + c] + src[lf + c] + src[rt + c]) * 0.125f;
                        var diff = center - blur;
                        // Threshold tiny differences so paper background stays noise-free.
                        if (MathF.Abs(diff) < 3f) continue;
                        output[co + c] = ClampByte(center + diff * amount);
                    }
                }
            }
        }

        return (new JsonObject
        {
            ["width"] = width,
            ["height"] = height,
            ["blackPoint"] = low,
            ["whitePoint"] = high,
            ["grayscale"] = isMostlyGrayscale,
        }, output);
    }

    private static byte ClampByte(float v) => v <= 0f ? (byte)0 : v >= 255f ? (byte)255 : (byte)MathF.Round(v);
}
