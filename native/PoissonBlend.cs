/// <summary>
/// Gradient-domain Poisson seamless blending via cascadic multigrid + SOR membrane solver
/// (clean-room C# implementation inspired by PhotoCraft's poisson.rs and Pérez et al., SIGGRAPH 2003).
/// </summary>
internal static class PoissonBlend
{
    private const float Tol = 2e-5f;
    private const int FineIters = 30;
    private const float FineOmega = 1.7f;
    private const int CoarseIters = 1500;
    private const float CoarseOmega = 1.85f;
    private const int MaxDepth = 14;

    internal static void SolveMembrane(int w, int h, byte[] unknown, float[] v)
    {
        SolveRecursive(w, h, unknown, v, 0);
    }

    private static void SolveRecursive(int w, int h, byte[] unknown, float[] v, int depth)
    {
        var len = w * h;
        var unknownCount = 0;
        var knownCount = 0;
        var knownSum = 0d;
        for (var i = 0; i < len; i++)
        {
            if (unknown[i] != 0) unknownCount++;
            else
            {
                knownCount++;
                knownSum += v[i];
            }
        }
        if (unknownCount == 0 || knownCount == 0) return;

        if (w >= 8 && h >= 8 && unknownCount > 64 && depth < MaxDepth)
        {
            var cw = (w + 1) / 2;
            var ch = (h + 1) / 2;
            var cu = new byte[cw * ch];
            var cv = new float[cw * ch];
            Array.Fill(cu, (byte)1);

            for (var cy = 0; cy < ch; cy++)
            {
                var cRow = cy * cw;
                for (var cx = 0; cx < cw; cx++)
                {
                    var s = 0f;
                    var n = 0;
                    for (var dy = 0; dy < 2; dy++)
                    {
                        var y = cy * 2 + dy;
                        if (y >= h) continue;
                        var row = y * w;
                        for (var dx = 0; dx < 2; dx++)
                        {
                            var x = cx * 2 + dx;
                            if (x >= w || unknown[row + x] != 0) continue;
                            s += v[row + x];
                            n++;
                        }
                    }
                    if (n > 0)
                    {
                        cu[cRow + cx] = 0;
                        cv[cRow + cx] = s / n;
                    }
                }
            }

            SolveRecursive(cw, ch, cu, cv, depth + 1);

            // Bilinear prolongation onto unknown pixels.
            for (var y = 0; y < h; y++)
            {
                var fy = Math.Clamp((y + 0.5f) / 2f - 0.5f, 0f, ch - 1);
                var y0 = (int)MathF.Floor(fy);
                var y1 = Math.Min(y0 + 1, ch - 1);
                var ty = fy - y0;
                var row = y * w;
                var cRow0 = y0 * cw;
                var cRow1 = y1 * cw;

                for (var x = 0; x < w; x++)
                {
                    if (unknown[row + x] == 0) continue;
                    var fx = Math.Clamp((x + 0.5f) / 2f - 0.5f, 0f, cw - 1);
                    var x0 = (int)MathF.Floor(fx);
                    var x1 = Math.Min(x0 + 1, cw - 1);
                    var tx = fx - x0;
                    var a = cv[cRow0 + x0] + (cv[cRow0 + x1] - cv[cRow0 + x0]) * tx;
                    var b = cv[cRow1 + x0] + (cv[cRow1 + x1] - cv[cRow1 + x0]) * tx;
                    v[row + x] = a + (b - a) * ty;
                }
            }

            Sor(w, h, unknown, v, FineIters, FineOmega);
        }
        else
        {
            var mean = (float)(knownSum / knownCount);
            for (var i = 0; i < len; i++)
            {
                if (unknown[i] != 0) v[i] = mean;
            }
            Sor(w, h, unknown, v, CoarseIters, CoarseOmega);
        }
    }

    private static void Sor(int w, int h, byte[] unknown, float[] v, int maxIter, float omega)
    {
        var len = w * h;
        var indices = new List<int>(len / 4 + 16);
        var masks = new List<byte>(len / 4 + 16);
        for (var y = 0; y < h; y++)
        {
            var row = y * w;
            for (var x = 0; x < w; x++)
            {
                var idx = row + x;
                if (unknown[idx] == 0) continue;
                byte m = 0;
                if (x > 0) m |= 1;
                if (x + 1 < w) m |= 2;
                if (y > 0) m |= 4;
                if (y + 1 < h) m |= 8;
                indices.Add(idx);
                masks.Add(m);
            }
        }

        var count = indices.Count;
        for (var iter = 0; iter < maxIter; iter++)
        {
            var maxDelta = 0f;
            for (var k = 0; k < count; k++)
            {
                var idx = indices[k];
                var m = masks[k];
                float avg;
                if (m == 0b1111)
                {
                    avg = (v[idx - 1] + v[idx + 1] + v[idx - w] + v[idx + w]) * 0.25f;
                }
                else
                {
                    var sum = 0f;
                    var n = 0f;
                    if ((m & 1) != 0) { sum += v[idx - 1]; n += 1f; }
                    if ((m & 2) != 0) { sum += v[idx + 1]; n += 1f; }
                    if ((m & 4) != 0) { sum += v[idx - w]; n += 1f; }
                    if ((m & 8) != 0) { sum += v[idx + w]; n += 1f; }
                    if (n == 0f) continue;
                    avg = sum / n;
                }
                var d = omega * (avg - v[idx]);
                v[idx] += d;
                var ad = MathF.Abs(d);
                if (ad > maxDelta) maxDelta = ad;
            }
            if (maxDelta < Tol) break;
        }
    }

    /// <summary>
    /// Standard Pérez et al. seamless cloning when <paramref name="srcRgb"/> is a distinct source image.
    /// </summary>
    internal static void SeamlessCloneRgb(int w, int h, float[] srcRgb, float[] dstRgb, byte[] hole)
    {
        var len = w * h;
        var hv = new float[len];
        for (var c = 0; c < 3; c++)
        {
            for (var i = 0; i < len; i++)
            {
                hv[i] = hole[i] != 0 ? 0f : dstRgb[i * 3 + c] - srcRgb[i * 3 + c];
            }
            SolveMembrane(w, h, hole, hv);
            for (var i = 0; i < len; i++)
            {
                srcRgb[i * 3 + c] = hole[i] != 0
                    ? Math.Clamp(srcRgb[i * 3 + c] + hv[i], 0f, 1f)
                    : dstRgb[i * 3 + c];
            }
        }
    }

    /// <summary>
    /// Seamless boundary harmonization for an in-place inpainted patch: measures boundary lighting drift
    /// across the 1-pixel rim between untouched background (<paramref name="dstRgb"/>) and reconstructed
    /// interior (<paramref name="inpaintedRgb"/>), solves a harmonic membrane over the hole, and applies
    /// a bounded illumination shift so texture gradients remain sharp while seams vanish.
    /// </summary>
    internal static void SeamlessInpaintBlendRgb(int w, int h, float[] inpaintedRgb, float[] dstRgb, byte[] hole, float maxShift = 0.16f)
    {
        var len = w * h;
        var hv = new float[len];
        for (var c = 0; c < 3; c++)
        {
            Array.Clear(hv, 0, len);
            for (var y = 0; y < h; y++)
            {
                var row = y * w;
                for (var x = 0; x < w; x++)
                {
                    var idx = row + x;
                    if (hole[idx] != 0) continue;
                    // Check if this known boundary pixel touches the hole.
                    var sumInterior = 0f;
                    var count = 0;
                    if (x > 0 && hole[idx - 1] != 0) { sumInterior += inpaintedRgb[(idx - 1) * 3 + c]; count++; }
                    if (x + 1 < w && hole[idx + 1] != 0) { sumInterior += inpaintedRgb[(idx + 1) * 3 + c]; count++; }
                    if (y > 0 && hole[idx - w] != 0) { sumInterior += inpaintedRgb[(idx - w) * 3 + c]; count++; }
                    if (y + 1 < h && hole[idx + w] != 0) { sumInterior += inpaintedRgb[(idx + w) * 3 + c]; count++; }
                    if (count == 0) continue;
                    var diff = dstRgb[idx * 3 + c] - (sumInterior / count);
                    hv[idx] = Math.Clamp(diff, -maxShift, maxShift);
                }
            }

            SolveMembrane(w, h, hole, hv);
            for (var i = 0; i < len; i++)
            {
                if (hole[i] != 0)
                {
                    inpaintedRgb[i * 3 + c] = Math.Clamp(inpaintedRgb[i * 3 + c] + Math.Clamp(hv[i], -maxShift, maxShift), 0f, 1f);
                }
                else
                {
                    inpaintedRgb[i * 3 + c] = dstRgb[i * 3 + c];
                }
            }
        }
    }
}
