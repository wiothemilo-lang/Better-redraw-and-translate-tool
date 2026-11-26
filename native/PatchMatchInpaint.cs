using System.Text.Json.Nodes;

/// <summary>
/// Multi-scale PatchMatch + EM similarity-weighted voting + per-channel colour adaptation
/// for Content-Aware hole filling on complex comic backgrounds (clean-room C# implementation
/// inspired by PhotoCraft's inpaint solver, Wexler et al. 2007, Barnes et al. 2009, Darabi et al. 2012).
/// </summary>
internal static class PatchMatchInpaint
{
    private const float FlatThreshold = 0.02f;
    private const float AdaptGainMin = 0.90f;
    private const float AdaptGainMax = 1.10f;
    private const float AdaptBiasMax = 0.04f;
    private const int MaxPyramidLevels = 5;
    private const int RefineOnlyExtent = 192;

    private readonly record struct Box(int X0, int Y0, int X1, int Y1)
    {
        internal int Width => X1 - X0;
        internal int Height => Y1 - Y0;
        internal int Area => Width * Height;
        internal Box Grow(int r, int w, int h) => new(
            Math.Max(0, X0 - r),
            Math.Max(0, Y0 - r),
            Math.Min(w, X1 + r),
            Math.Min(h, Y1 + r));
    }

    private sealed class PyramidLevel
    {
        internal int Width;
        internal int Height;
        internal float[] Rgb = [];
        internal byte[] Hole = []; // 1 = hole, 0 = known source
        internal Box HoleBox;
    }

    internal static (JsonObject, byte[]) Execute(JsonObject options, byte[] data)
    {
        var width = (int)options["width"]!;
        var height = (int)options["height"]!;
        if (width <= 0 || height <= 0 || (long)width * height > 4_000_000)
            throw new InvalidDataException("Invalid inpaint dimensions.");
        var rgbaLen = width * height * 4;
        var maskLen = width * height;
        if (data.Length != rgbaLen + maskLen)
            throw new InvalidDataException("Invalid inpaint payload length.");

        var patchRadius = Math.Clamp((int?)options["patchRadius"] ?? 3, 1, 5);
        var colorAdapt = (bool?)options["colorAdapt"] ?? true;
        var seamless = (bool?)options["seamless"] ?? true;
        var seed = (ulong)((long?)options["seed"] ?? 1L);

        var output = new byte[rgbaLen];
        Buffer.BlockCopy(data, 0, output, 0, rgbaLen);

        var fullHole = new byte[maskLen];
        var hx0 = width;
        var hy0 = height;
        var hx1 = 0;
        var hy1 = 0;
        var holeCount = 0;
        for (var y = 0; y < height; y++)
        {
            var row = y * width;
            for (var x = 0; x < width; x++)
            {
                if (data[rgbaLen + row + x] == 0) continue;
                fullHole[row + x] = 1;
                holeCount++;
                if (x < hx0) hx0 = x;
                if (y < hy0) hy0 = y;
                if (x + 1 > hx1) hx1 = x + 1;
                if (y + 1 > hy1) hy1 = y + 1;
            }
        }
        if (holeCount == 0 || holeCount == maskLen)
            return (new JsonObject { ["filled"] = 0 }, output);

        // Compute PhotoCraft-style sampling window: 4 * sqrt(max(w, 50) * max(h, 50)) slid inside bounds.
        var win = SamplingWindow(new Box(hx0, hy0, hx1, hy1), width, height);
        var ww = win.Width;
        var wh = win.Height;
        var rgb = new float[ww * wh * 3];
        var hole = new byte[ww * wh];
        for (var y = 0; y < wh; y++)
        {
            var srcRow = (win.Y0 + y) * width + win.X0;
            var dstRow = y * ww;
            for (var x = 0; x < ww; x++)
            {
                var si = (srcRow + x) * 4;
                var di = (dstRow + x) * 3;
                rgb[di] = output[si] / 255f;
                rgb[di + 1] = output[si + 1] / 255f;
                rgb[di + 2] = output[si + 2] / 255f;
                hole[dstRow + x] = fullHole[srcRow + x];
            }
        }

        var originalRgb = seamless ? (float[])rgb.Clone() : null;
        var localHoleBox = new Box(hx0 - win.X0, hy0 - win.Y0, hx1 - win.X0, hy1 - win.Y0);
        Complete(ww, wh, rgb, hole, localHoleBox, patchRadius, colorAdapt, seed);
        if (seamless && originalRgb is not null)
        {
            PoissonBlend.SeamlessInpaintBlendRgb(ww, wh, rgb, originalRgb, hole);
        }

        // Copy back ONLY masked pixels so unmasked artwork is preserved bit-for-bit.
        for (var y = 0; y < wh; y++)
        {
            var dstRow = (win.Y0 + y) * width + win.X0;
            var srcRow = y * ww;
            for (var x = 0; x < ww; x++)
            {
                if (hole[srcRow + x] == 0) continue;
                var si = (srcRow + x) * 3;
                var di = (dstRow + x) * 4;
                output[di] = ToByte(rgb[si]);
                output[di + 1] = ToByte(rgb[si + 1]);
                output[di + 2] = ToByte(rgb[si + 2]);
                output[di + 3] = 255;
            }
        }

        return (new JsonObject { ["filled"] = holeCount }, output);
    }

    private static Box SamplingWindow(Box hole, int width, int height)
    {
        var side = (int)Math.Round(4.0 * Math.Sqrt(Math.Max(hole.Width, 50) * (double)Math.Max(hole.Height, 50)));
        var (x0, x1) = SlideSpan(hole.X0 + hole.X1, Math.Max(side, hole.Width), width);
        var (y0, y1) = SlideSpan(hole.Y0 + hole.Y1, Math.Max(side, hole.Height), height);
        return new Box(x0, y0, x1, y1);

        static (int, int) SlideSpan(int center2, int span, int limit)
        {
            if (span >= limit) return (0, limit);
            var start = Math.Clamp((center2 - span) / 2, 0, limit - span);
            return (start, start + span);
        }
    }

    private static void Complete(int w, int h, float[] rgb, byte[] hole, Box hb0, int r, bool colorAdapt, ulong seed)
    {
        var pyramid = BuildPyramid(w, h, rgb, hole, hb0, r);
        var levels = pyramid.Count;
        int[]? prevNnfX = null;
        int[]? prevNnfY = null;
        Box prevTBox = default;
        float[]? prevRgb = null;
        int prevW = 0, prevH = 0;

        for (var li = levels - 1; li >= 0; li--)
        {
            NativeProgress.Emit(10 + 85d * (levels - 1 - li) / Math.Max(1, levels), "Tái tạo nền PatchMatch");
            var level = pyramid[li];
            var lw = level.Width;
            var lh = level.Height;
            var hb = level.HoleBox;
            var tb = hb.Grow(r, lw, lh);
            var valid = BuildValidSources(lw, lh, r, level.Hole, out var sources);

            if (sources.Length == 0)
            {
                MembraneFill(lw, lh, level.Rgb, level.Hole, hb);
                prevRgb = level.Rgb;
                prevW = lw;
                prevH = lh;
                prevNnfX = null;
                prevNnfY = null;
                continue;
            }

            // Initialize hole pixels at this level.
            if (prevRgb is not null)
            {
                CopyUpCoarser(lw, lh, level.Rgb, level.Hole, hb, prevW, prevH, prevRgb);
            }
            else if (hb.Area <= 2500 && sources.Length <= 8000)
            {
                OnionPeel(lw, lh, r, level.Rgb, level.Hole, hb, sources);
            }
            else
            {
                MembraneFill(lw, lh, level.Rgb, level.Hole, hb);
            }

            var targets = BuildTargets(lw, lh, r, level.Hole, tb);
            var nnfX = new int[tb.Area];
            var nnfY = new int[tb.Area];
            var cost = new float[tb.Area];
            Array.Fill(cost, float.PositiveInfinity);

            var rngState = seed ^ ((ulong)(li + 1) * 0x9E3779B97F4A7C15UL);
            if (rngState == 0) rngState = 1;

            var upsampled = SeedNnf(
                lw, lh, tb, targets, valid, sources,
                prevNnfX, prevNnfY, prevTBox,
                nnfX, nnfY, ref rngState);

            if (upsampled)
            {
                ComputeCosts(lw, lh, r, level.Rgb, tb, targets, nnfX, nnfY, cost, colorAdapt);
                Vote(lw, lh, r, level.Rgb, level.Hole, tb, targets, nnfX, nnfY, cost, colorAdapt);
            }

            var extent = Math.Max(hb.Width, hb.Height);
            var refineOnly = li + 1 < levels && extent > RefineOnlyExtent;
            var emIters = refineOnly ? 1 : (li == levels - 1 ? 8 : (li == 0 ? 3 : 5));
            var pmIters = refineOnly ? 1 : 2;

            for (var em = 0; em < emIters; em++)
            {
                ComputeCosts(lw, lh, r, level.Rgb, tb, targets, nnfX, nnfY, cost, colorAdapt);
                for (var pm = 0; pm < pmIters; pm++)
                {
                    var forward = (pm & 1) == 0;
                    PatchMatchPass(lw, lh, r, level.Rgb, tb, targets, valid, nnfX, nnfY, cost, forward, colorAdapt, ref rngState);
                }
                Vote(lw, lh, r, level.Rgb, level.Hole, tb, targets, nnfX, nnfY, cost, colorAdapt);
            }

            prevNnfX = nnfX;
            prevNnfY = nnfY;
            prevTBox = tb;
            prevRgb = level.Rgb;
            prevW = lw;
            prevH = lh;
        }
    }

    private static List<PyramidLevel> BuildPyramid(int w, int h, float[] rgb, byte[] hole, Box hb0, int r)
    {
        var list = new List<PyramidLevel>
        {
            new() { Width = w, Height = h, Rgb = rgb, Hole = hole, HoleBox = hb0 }
        };
        var patchSide = 2 * r + 1;
        while (list.Count < MaxPyramidLevels)
        {
            var cur = list[^1];
            var thickness = HoleThickness(cur.Width, cur.Height, cur.Hole, cur.HoleBox);
            var extent = Math.Max(cur.HoleBox.Width, cur.HoleBox.Height);
            if (cur.Width < patchSide * 3 || cur.Height < patchSide * 3) break;
            if (extent <= patchSide * 4 || thickness <= patchSide * 2) break;

            var nw = cur.Width / 2;
            var nh = cur.Height / 2;
            var nRgb = new float[nw * nh * 3];
            var nHole = new byte[nw * nh];
            int nx0 = nw, ny0 = nh, nx1 = 0, ny1 = 0;

            for (var y = 0; y < nh; y++)
            for (var x = 0; x < nw; x++)
            {
                var anyHole = false;
                float sr = 0, sg = 0, sb = 0;
                var knownCount = 0;
                for (var dy = 0; dy < 2; dy++)
                for (var dx = 0; dx < 2; dx++)
                {
                    var sx = x * 2 + dx;
                    var sy = y * 2 + dy;
                    var si = sy * cur.Width + sx;
                    if (cur.Hole[si] != 0)
                    {
                        anyHole = true;
                    }
                    else
                    {
                        sr += cur.Rgb[si * 3];
                        sg += cur.Rgb[si * 3 + 1];
                        sb += cur.Rgb[si * 3 + 2];
                        knownCount++;
                    }
                }
                var di = y * nw + x;
                if (anyHole)
                {
                    nHole[di] = 1;
                    if (x < nx0) nx0 = x;
                    if (y < ny0) ny0 = y;
                    if (x + 1 > nx1) nx1 = x + 1;
                    if (y + 1 > ny1) ny1 = y + 1;
                }
                if (knownCount > 0)
                {
                    nRgb[di * 3] = sr / knownCount;
                    nRgb[di * 3 + 1] = sg / knownCount;
                    nRgb[di * 3 + 2] = sb / knownCount;
                }
            }
            if (nx1 <= nx0 || ny1 <= ny0) break;
            list.Add(new PyramidLevel
            {
                Width = nw,
                Height = nh,
                Rgb = nRgb,
                Hole = nHole,
                HoleBox = new Box(nx0, ny0, nx1, ny1),
            });
        }
        return list;
    }

    private static int HoleThickness(int w, int h, byte[] hole, Box hb)
    {
        var bw = hb.Width;
        var bh = hb.Height;
        if (bw <= 0 || bh <= 0) return 0;
        var dist = new int[bw * bh];
        var maxDist = 0;
        for (var y = 0; y < bh; y++)
        for (var x = 0; x < bw; x++)
        {
            if (hole[(hb.Y0 + y) * w + hb.X0 + x] == 0) continue;
            var up = y > 0 ? dist[(y - 1) * bw + x] : 0;
            var left = x > 0 ? dist[y * bw + x - 1] : 0;
            dist[y * bw + x] = Math.Min(up, left) + 1;
        }
        for (var y = bh - 1; y >= 0; y--)
        for (var x = bw - 1; x >= 0; x--)
        {
            var idx = y * bw + x;
            if (dist[idx] == 0) continue;
            var down = y + 1 < bh ? dist[(y + 1) * bw + x] : 0;
            var right = x + 1 < bw ? dist[y * bw + x + 1] : 0;
            var d = Math.Min(dist[idx], Math.Min(down, right) + 1);
            dist[idx] = d;
            if (d > maxDist) maxDist = d;
        }
        return maxDist * 2;
    }

    private static bool[] BuildValidSources(int w, int h, int r, byte[] hole, out (int X, int Y)[] sources)
    {
        var integral = new int[(w + 1) * (h + 1)];
        for (var y = 0; y < h; y++)
        {
            var rowSum = 0;
            var row = (y + 1) * (w + 1);
            var prev = y * (w + 1);
            for (var x = 0; x < w; x++)
            {
                rowSum += hole[y * w + x];
                integral[row + x + 1] = integral[prev + x + 1] + rowSum;
            }
        }
        var valid = new bool[w * h];
        var list = new List<(int, int)>();
        for (var y = r; y < h - r; y++)
        for (var x = r; x < w - r; x++)
        {
            var x0 = x - r;
            var y0 = y - r;
            var x1 = x + r + 1;
            var y1 = y + r + 1;
            var count = integral[y1 * (w + 1) + x1]
                - integral[y0 * (w + 1) + x1]
                - integral[y1 * (w + 1) + x0]
                + integral[y0 * (w + 1) + x0];
            if (count == 0)
            {
                valid[y * w + x] = true;
                list.Add((x, y));
            }
        }
        sources = list.ToArray();
        return valid;
    }

    private static bool[] BuildTargets(int w, int h, int r, byte[] hole, Box tb)
    {
        var targets = new bool[tb.Area];
        for (var ty = 0; ty < tb.Height; ty++)
        {
            var cy = tb.Y0 + ty;
            if (cy < r || cy + r >= h) continue;
            for (var tx = 0; tx < tb.Width; tx++)
            {
                var cx = tb.X0 + tx;
                if (cx < r || cx + r >= w) continue;
                var overlaps = false;
                for (var dy = -r; dy <= r && !overlaps; dy++)
                {
                    var row = (cy + dy) * w;
                    for (var dx = -r; dx <= r; dx++)
                    {
                        if (hole[row + cx + dx] != 0) { overlaps = true; break; }
                    }
                }
                targets[ty * tb.Width + tx] = overlaps;
            }
        }
        return targets;
    }

    private static void OnionPeel(int w, int h, int r, float[] rgb, byte[] hole, Box hb, (int X, int Y)[] sources)
    {
        var known = new bool[w * h];
        for (var i = 0; i < hole.Length; i++) known[i] = hole[i] == 0;
        var srcIndex = new int[w * h];
        Array.Fill(srcIndex, -1);
        for (var i = 0; i < sources.Length; i++) srcIndex[sources[i].Y * w + sources[i].X] = i;
        var took = new int[w * h];
        Array.Fill(took, -1);

        var side = 2 * r + 1;
        var offs = new int[side * side];
        var tv = new float[side * side * 3];
        var front = new List<int>();
        var values = new List<(int Idx, float R, float G, float B, int SrcIdx)>();

        while (true)
        {
            front.Clear();
            for (var y = hb.Y0; y < hb.Y1; y++)
            for (var x = hb.X0; x < hb.X1; x++)
            {
                var idx = y * w + x;
                if (known[idx]) continue;
                var edge = false;
                for (var dy = -1; dy <= 1 && !edge; dy++)
                for (var dx = -1; dx <= 1; dx++)
                {
                    var nx = x + dx;
                    var ny = y + dy;
                    if ((uint)nx < w && (uint)ny < h && known[ny * w + nx]) { edge = true; break; }
                }
                if (edge) front.Add(idx);
            }
            if (front.Count == 0) break;

            values.Clear();
            foreach (var idx in front)
            {
                var x = idx % w;
                var y = idx / w;
                var n = 0;
                for (var dy = -r; dy <= r; dy++)
                {
                    var ty = y + dy;
                    if ((uint)ty >= h) continue;
                    for (var dx = -r; dx <= r; dx++)
                    {
                        var tx = x + dx;
                        if ((uint)tx >= w || !known[ty * w + tx]) continue;
                        offs[n] = dy * w + dx;
                        var ti = (ty * w + tx) * 3;
                        tv[n * 3] = rgb[ti];
                        tv[n * 3 + 1] = rgb[ti + 1];
                        tv[n * 3 + 2] = rgb[ti + 2];
                        n++;
                    }
                }
                var bestCost = float.PositiveInfinity;
                var bestSrc = 0;
                if (n > 0)
                {
                    // Try shifted sources of already-filled neighbors first for a tight early-out cutoff.
                    for (var dy = -1; dy <= 1; dy++)
                    for (var dx = -1; dx <= 1; dx++)
                    {
                        var qx = x + dx;
                        var qy = y + dy;
                        if ((uint)qx >= w || (uint)qy >= h) continue;
                        var ti = took[qy * w + qx];
                        if (ti < 0) continue;
                        var cx = sources[ti].X - dx;
                        var cy = sources[ti].Y - dy;
                        if ((uint)cx >= w || (uint)cy >= h) continue;
                        var cand = srcIndex[cy * w + cx];
                        if (cand >= 0) TrySource(cand);
                    }
                    for (var s = 0; s < sources.Length; s++) TrySource(s);
                }
                var chosen = sources[bestSrc];
                var si = (chosen.Y * w + chosen.X) * 3;
                values.Add((idx, rgb[si], rgb[si + 1], rgb[si + 2], bestSrc));

                void TrySource(int s)
                {
                    var baseIdx = sources[s].Y * w + sources[s].X;
                    var sum = 0f;
                    for (var k = 0; k < n; k++)
                    {
                        var p = (baseIdx + offs[k]) * 3;
                        var dr = rgb[p] - tv[k * 3];
                        var dg = rgb[p + 1] - tv[k * 3 + 1];
                        var db = rgb[p + 2] - tv[k * 3 + 2];
                        sum += dr * dr + dg * dg + db * db;
                        if (sum >= bestCost) return;
                    }
                    bestCost = sum;
                    bestSrc = s;
                }
            }

            foreach (var v in values)
            {
                rgb[v.Idx * 3] = v.R;
                rgb[v.Idx * 3 + 1] = v.G;
                rgb[v.Idx * 3 + 2] = v.B;
                known[v.Idx] = true;
                took[v.Idx] = v.SrcIdx;
            }
        }
    }

    private static void MembraneFill(int w, int h, float[] rgb, byte[] hole, Box hb)
    {
        var known = new bool[w * h];
        for (var i = 0; i < hole.Length; i++) known[i] = hole[i] == 0;
        var frontier = new List<int>();
        var next = new List<int>();
        for (var y = hb.Y0; y < hb.Y1; y++)
        for (var x = hb.X0; x < hb.X1; x++)
        {
            var idx = y * w + x;
            if (known[idx]) continue;
            if ((x > 0 && known[idx - 1]) || (x + 1 < w && known[idx + 1]) ||
                (y > 0 && known[idx - w]) || (y + 1 < h && known[idx + w]))
                frontier.Add(idx);
        }
        while (frontier.Count > 0)
        {
            next.Clear();
            foreach (var idx in frontier)
            {
                var x = idx % w;
                var y = idx / w;
                float sr = 0, sg = 0, sb = 0;
                var c = 0;
                if (x > 0 && known[idx - 1]) { sr += rgb[(idx - 1) * 3]; sg += rgb[(idx - 1) * 3 + 1]; sb += rgb[(idx - 1) * 3 + 2]; c++; }
                if (x + 1 < w && known[idx + 1]) { sr += rgb[(idx + 1) * 3]; sg += rgb[(idx + 1) * 3 + 1]; sb += rgb[(idx + 1) * 3 + 2]; c++; }
                if (y > 0 && known[idx - w]) { sr += rgb[(idx - w) * 3]; sg += rgb[(idx - w) * 3 + 1]; sb += rgb[(idx - w) * 3 + 2]; c++; }
                if (y + 1 < h && known[idx + w]) { sr += rgb[(idx + w) * 3]; sg += rgb[(idx + w) * 3 + 1]; sb += rgb[(idx + w) * 3 + 2]; c++; }
                if (c > 0)
                {
                    rgb[idx * 3] = sr / c;
                    rgb[idx * 3 + 1] = sg / c;
                    rgb[idx * 3 + 2] = sb / c;
                }
            }
            foreach (var idx in frontier) known[idx] = true;
            foreach (var idx in frontier)
            {
                var x = idx % w;
                var y = idx / w;
                if (x > 0 && !known[idx - 1]) { known[idx - 1] = true; next.Add(idx - 1); }
                if (x + 1 < w && !known[idx + 1]) { known[idx + 1] = true; next.Add(idx + 1); }
                if (y > 0 && !known[idx - w]) { known[idx - w] = true; next.Add(idx - w); }
                if (y + 1 < h && !known[idx + w]) { known[idx + w] = true; next.Add(idx + w); }
            }
            // Mark newly queued as unknown until next ring computes their average.
            foreach (var idx in next) known[idx] = false;
            (frontier, next) = (next, frontier);
        }
    }

    private static void CopyUpCoarser(int w, int h, float[] rgb, byte[] hole, Box hb, int cw, int ch, float[] cRgb)
    {
        for (var y = hb.Y0; y < hb.Y1; y++)
        {
            var cy = Math.Min(ch - 1, y / 2);
            for (var x = hb.X0; x < hb.X1; x++)
            {
                var idx = y * w + x;
                if (hole[idx] == 0) continue;
                var cx = Math.Min(cw - 1, x / 2);
                var ci = (cy * cw + cx) * 3;
                rgb[idx * 3] = cRgb[ci];
                rgb[idx * 3 + 1] = cRgb[ci + 1];
                rgb[idx * 3 + 2] = cRgb[ci + 2];
            }
        }
    }

    private static bool SeedNnf(
        int w, int h, Box tb, bool[] targets, bool[] valid, (int X, int Y)[] sources,
        int[]? prevX, int[]? prevY, Box prevTb,
        int[] nnfX, int[] nnfY, ref ulong rng)
    {
        var upsampled = false;
        for (var ty = 0; ty < tb.Height; ty++)
        for (var tx = 0; tx < tb.Width; tx++)
        {
            var k = ty * tb.Width + tx;
            if (!targets[k]) continue;
            var x = tb.X0 + tx;
            var y = tb.Y0 + ty;
            var assigned = false;
            if (prevX is not null && prevY is not null)
            {
                var px = x / 2 - prevTb.X0;
                var py = y / 2 - prevTb.Y0;
                if ((uint)px < prevTb.Width && (uint)py < prevTb.Height)
                {
                    var pk = py * prevTb.Width + px;
                    var sx = prevX[pk] * 2 + (x & 1);
                    var sy = prevY[pk] * 2 + (y & 1);
                    if ((uint)sx < w && (uint)sy < h && valid[sy * w + sx])
                    {
                        nnfX[k] = sx;
                        nnfY[k] = sy;
                        assigned = true;
                        upsampled = true;
                    }
                }
            }
            if (!assigned)
            {
                var pick = sources[(int)(NextRand(ref rng) % (ulong)sources.Length)];
                nnfX[k] = pick.X;
                nnfY[k] = pick.Y;
            }
        }
        return upsampled;
    }

    private static void ComputeCosts(int w, int h, int r, float[] rgb, Box tb, bool[] targets, int[] nnfX, int[] nnfY, float[] cost, bool colorAdapt)
    {
        for (var ty = 0; ty < tb.Height; ty++)
        for (var tx = 0; tx < tb.Width; tx++)
        {
            var k = ty * tb.Width + tx;
            if (!targets[k]) continue;
            cost[k] = PatchDistance(w, r, rgb, tb.X0 + tx, tb.Y0 + ty, nnfX[k], nnfY[k], float.PositiveInfinity, colorAdapt);
        }
    }

    private static void PatchMatchPass(
        int w, int h, int r, float[] rgb, Box tb, bool[] targets, bool[] valid,
        int[] nnfX, int[] nnfY, float[] cost, bool forward, bool colorAdapt, ref ulong rng)
    {
        var yStart = forward ? 0 : tb.Height - 1;
        var yEnd = forward ? tb.Height : -1;
        var xStart = forward ? 0 : tb.Width - 1;
        var xEnd = forward ? tb.Width : -1;
        var step = forward ? 1 : -1;
        var maxRadius = Math.Max(w, h) / 2;

        for (var ty = yStart; ty != yEnd; ty += step)
        for (var tx = xStart; tx != xEnd; tx += step)
        {
            var k = ty * tb.Width + tx;
            if (!targets[k]) continue;
            var x = tb.X0 + tx;
            var y = tb.Y0 + ty;
            var bx = nnfX[k];
            var by = nnfY[k];
            var bc = cost[k];

            // Propagation from already-visited neighbors along scan direction.
            var ntx = tx - step;
            if ((uint)ntx < tb.Width)
            {
                var nk = ty * tb.Width + ntx;
                if (targets[nk])
                {
                    var cx = nnfX[nk] + step;
                    var cy = nnfY[nk];
                    if ((uint)cx < w && (uint)cy < h && valid[cy * w + cx])
                    {
                        var d = PatchDistance(w, r, rgb, x, y, cx, cy, bc, colorAdapt);
                        if (d < bc) { bc = d; bx = cx; by = cy; }
                    }
                }
            }
            var nty = ty - step;
            if ((uint)nty < tb.Height)
            {
                var nk = nty * tb.Width + tx;
                if (targets[nk])
                {
                    var cx = nnfX[nk];
                    var cy = nnfY[nk] + step;
                    if ((uint)cx < w && (uint)cy < h && valid[cy * w + cx])
                    {
                        var d = PatchDistance(w, r, rgb, x, y, cx, cy, bc, colorAdapt);
                        if (d < bc) { bc = d; bx = cx; by = cy; }
                    }
                }
            }

            // Exponentially shrinking random search around current best.
            for (var rad = maxRadius; rad >= 1; rad >>= 1)
            {
                var xMin = Math.Max(r, bx - rad);
                var xMax = Math.Min(w - 1 - r, bx + rad);
                var yMin = Math.Max(r, by - rad);
                var yMax = Math.Min(h - 1 - r, by + rad);
                if (xMax < xMin || yMax < yMin) continue;
                var cx = xMin + (int)(NextRand(ref rng) % (ulong)(xMax - xMin + 1));
                var cy = yMin + (int)(NextRand(ref rng) % (ulong)(yMax - yMin + 1));
                if (!valid[cy * w + cx]) continue;
                var d = PatchDistance(w, r, rgb, x, y, cx, cy, bc, colorAdapt);
                if (d < bc) { bc = d; bx = cx; by = cy; }
            }

            nnfX[k] = bx;
            nnfY[k] = by;
            cost[k] = bc;
        }
    }

    private static float PatchDistance(int w, int r, float[] rgb, int tx, int ty, int sx, int sy, float cutoff, bool colorAdapt)
    {
        var side = 2 * r + 1;
        var count = side * side;
        if (!colorAdapt)
        {
            var limit = float.IsFinite(cutoff) ? cutoff * (count * 3f) : float.PositiveInfinity;
            var sum = 0f;
            for (var dy = -r; dy <= r; dy++)
            {
                var tRow = ((ty + dy) * w + (tx - r)) * 3;
                var sRow = ((sy + dy) * w + (sx - r)) * 3;
                for (var i = 0; i < side * 3; i++)
                {
                    var d = rgb[tRow + i] - rgb[sRow + i];
                    sum += d * d;
                }
                if (sum > limit) return float.PositiveInfinity;
            }
            return sum / (count * 3f);
        }

        // PhotoCraft / Darabi Image Melding per-channel gain+bias distance.
        float st0 = 0, st1 = 0, st2 = 0;
        float stt0 = 0, stt1 = 0, stt2 = 0;
        float ss0 = 0, ss1 = 0, ss2 = 0;
        float sss0 = 0, sss1 = 0, sss2 = 0;
        float sts0 = 0, sts1 = 0, sts2 = 0;
        for (var dy = -r; dy <= r; dy++)
        {
            var tRow = ((ty + dy) * w + (tx - r)) * 3;
            var sRow = ((sy + dy) * w + (sx - r)) * 3;
            for (var dx = 0; dx < side; dx++)
            {
                var o = dx * 3;
                var t0 = rgb[tRow + o]; var s0 = rgb[sRow + o];
                var t1 = rgb[tRow + o + 1]; var s1 = rgb[sRow + o + 1];
                var t2 = rgb[tRow + o + 2]; var s2 = rgb[sRow + o + 2];
                st0 += t0; stt0 += t0 * t0; ss0 += s0; sss0 += s0 * s0; sts0 += t0 * s0;
                st1 += t1; stt1 += t1 * t1; ss1 += s1; sss1 += s1 * s1; sts1 += t1 * s1;
                st2 += t2; stt2 += t2 * t2; ss2 += s2; sss2 += s2 * s2; sts2 += t2 * s2;
            }
        }
        var n = (float)count;
        var err = ChannelAdaptedError(n, st0, stt0, ss0, sss0, sts0)
            + ChannelAdaptedError(n, st1, stt1, ss1, sss1, sts1)
            + ChannelAdaptedError(n, st2, stt2, ss2, sss2, sts2);
        return err / (n * 3f);
    }

    private static (float Gain, float Bias) FitChannel(float n, float st, float stt, float ss, float sss)
    {
        var mt = st / n;
        var ms = ss / n;
        var vt = MathF.Max(0f, stt / n - mt * mt);
        var vs = MathF.Max(0f, sss / n - ms * ms);
        var g = vs > 1e-10f ? MathF.Sqrt(vt / vs) : 1f;
        var lo = AdaptGainMin;
        var hi = AdaptGainMax;
        // Flat-patch guard (from PhotoCraft solver.rs): avoid colour drift on smooth gradients.
        if (MathF.Max(vt, vs) < FlatThreshold * FlatThreshold && MathF.Abs(mt - ms) <= AdaptBiasMax && ms > 1e-6f)
        {
            var glo = (mt - AdaptBiasMax) / ms;
            var ghi = (mt + AdaptBiasMax) / ms;
            if (MathF.Max(glo, lo) <= MathF.Min(ghi, hi))
            {
                lo = MathF.Max(glo, lo);
                hi = MathF.Min(ghi, hi);
            }
        }
        g = Math.Clamp(g, lo, hi);
        var b = Math.Clamp(mt - g * ms, -AdaptBiasMax, AdaptBiasMax);
        return (g, b);
    }

    private static float ChannelAdaptedError(float n, float st, float stt, float ss, float sss, float sts)
    {
        var (g, b) = FitChannel(n, st, stt, ss, sss);
        var err = stt + g * g * sss + n * b * b - 2f * g * sts - 2f * b * st + 2f * g * b * ss;
        return MathF.Max(0f, err);
    }

    private static void Vote(
        int w, int h, int r, float[] rgb, byte[] hole, Box tb, bool[] targets,
        int[] nnfX, int[] nnfY, float[] cost, bool colorAdapt)
    {
        // Compute robust scale sigma from finite costs.
        var finite = new List<float>(tb.Area);
        for (var k = 0; k < tb.Area; k++)
            if (targets[k] && float.IsFinite(cost[k])) finite.Add(cost[k]);
        if (finite.Count == 0) return;
        finite.Sort();
        var sigma = MathF.Max(finite[finite.Count / 2], 1e-4f);

        var accR = new float[w * h];
        var accG = new float[w * h];
        var accB = new float[w * h];
        var accW = new float[w * h];
        var side = 2 * r + 1;
        var n = (float)(side * side);

        for (var ty = 0; ty < tb.Height; ty++)
        for (var tx = 0; tx < tb.Width; tx++)
        {
            var k = ty * tb.Width + tx;
            if (!targets[k] || !float.IsFinite(cost[k])) continue;
            var cx = tb.X0 + tx;
            var cy = tb.Y0 + ty;
            var sx = nnfX[k];
            var sy = nnfY[k];
            var weight = MathF.Exp(-cost[k] / (2f * sigma)) + 1e-6f;

            float g0 = 1f, b0 = 0f, g1 = 1f, b1 = 0f, g2 = 1f, b2 = 0f;
            if (colorAdapt)
            {
                float st0 = 0, st1 = 0, st2 = 0, stt0 = 0, stt1 = 0, stt2 = 0;
                float ss0 = 0, ss1 = 0, ss2 = 0, sss0 = 0, sss1 = 0, sss2 = 0;
                for (var dy = -r; dy <= r; dy++)
                {
                    var tRow = ((cy + dy) * w + (cx - r)) * 3;
                    var sRow = ((sy + dy) * w + (sx - r)) * 3;
                    for (var dx = 0; dx < side; dx++)
                    {
                        var o = dx * 3;
                        var t0 = rgb[tRow + o]; var s0 = rgb[sRow + o];
                        var t1 = rgb[tRow + o + 1]; var s1 = rgb[sRow + o + 1];
                        var t2 = rgb[tRow + o + 2]; var s2 = rgb[sRow + o + 2];
                        st0 += t0; stt0 += t0 * t0; ss0 += s0; sss0 += s0 * s0;
                        st1 += t1; stt1 += t1 * t1; ss1 += s1; sss1 += s1 * s1;
                        st2 += t2; stt2 += t2 * t2; ss2 += s2; sss2 += s2 * s2;
                    }
                }
                (g0, b0) = FitChannel(n, st0, stt0, ss0, sss0);
                (g1, b1) = FitChannel(n, st1, stt1, ss1, sss1);
                (g2, b2) = FitChannel(n, st2, stt2, ss2, sss2);
            }

            for (var dy = -r; dy <= r; dy++)
            {
                var py = cy + dy;
                var qy = sy + dy;
                for (var dx = -r; dx <= r; dx++)
                {
                    var px = cx + dx;
                    var pidx = py * w + px;
                    if (hole[pidx] == 0) continue;
                    var qidx = (qy * w + (sx + dx)) * 3;
                    accR[pidx] += weight * Math.Clamp(g0 * rgb[qidx] + b0, 0f, 1f);
                    accG[pidx] += weight * Math.Clamp(g1 * rgb[qidx + 1] + b1, 0f, 1f);
                    accB[pidx] += weight * Math.Clamp(g2 * rgb[qidx + 2] + b2, 0f, 1f);
                    accW[pidx] += weight;
                }
            }
        }

        for (var i = 0; i < hole.Length; i++)
        {
            if (hole[i] == 0 || accW[i] <= 0f) continue;
            var inv = 1f / accW[i];
            rgb[i * 3] = accR[i] * inv;
            rgb[i * 3 + 1] = accG[i] * inv;
            rgb[i * 3 + 2] = accB[i] * inv;
        }
    }

    private static ulong NextRand(ref ulong state)
    {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        return state;
    }

    private static byte ToByte(float v) => (byte)Math.Clamp((int)MathF.Round(v * 255f), 0, 255);
}
