using System.Numerics;

internal static partial class RedrawEngine
{
    private readonly record struct PaperPlane(Vector3 Mean, Vector3 SlopeX, Vector3 SlopeY, double X, double Y)
    {
        internal Vector3 DeltaAt(int x, int y) => SlopeX * (float)(x - X) + SlopeY * (float)(y - Y);
        internal Vector3 At(int x, int y) => Mean + DeltaAt(x, y);
    }

    private struct PlaneFit
    {
        private int count;
        private double sumX, sumY, sumXX, sumYY, sumXY;
        private double sumR, sumG, sumB;
        private double sumXR, sumXG, sumXB;
        private double sumYR, sumYG, sumYB;

        internal void Add(Sample sample)
        {
            count++;
            double sx = sample.X, sy = sample.Y;
            double r = sample.Red, g = sample.Green, b = sample.Blue;
            sumX += sx;
            sumY += sy;
            sumXX += sx * sx;
            sumYY += sy * sy;
            sumXY += sx * sy;
            sumR += r;
            sumG += g;
            sumB += b;
            sumXR += sx * r;
            sumXG += sx * g;
            sumXB += sx * b;
            sumYR += sy * r;
            sumYG += sy * g;
            sumYB += sy * b;
        }

        internal readonly PaperPlane? Solve()
        {
            if (count < 24)
                return null;
            var x = sumX / count;
            var y = sumY / count;
            var xx = sumXX - sumX * x;
            var yy = sumYY - sumY * y;
            var xy = sumXY - sumX * y;
            var determinant = xx * yy - xy * xy;
            if (determinant < 1)
                return null;
            var xcR = sumXR - x * sumR;
            var xcG = sumXG - x * sumG;
            var xcB = sumXB - x * sumB;
            var ycR = sumYR - y * sumR;
            var ycG = sumYG - y * sumG;
            var ycB = sumYB - y * sumB;
            var slopeX = new Vector3(
                (float)((xcR * yy - ycR * xy) / determinant),
                (float)((xcG * yy - ycG * xy) / determinant),
                (float)((xcB * yy - ycB * xy) / determinant));
            var slopeY = new Vector3(
                (float)((ycR * xx - xcR * xy) / determinant),
                (float)((ycG * xx - xcG * xy) / determinant),
                (float)((ycB * xx - xcB * xy) / determinant));
            var mean = new Vector3((float)(sumR / count), (float)(sumG / count), (float)(sumB / count));
            return new PaperPlane(mean, slopeX, slopeY, x, y);
        }
    }

    private static PaperPlane? ApproximatePaper(List<Sample> samples)
    {
        var fit = new PlaneFit();
        foreach (var sample in samples)
            fit.Add(sample);
        return fit.Solve();
    }

    private static PaperPlane? FitPaper(List<Sample> samples, Region area)
    {
        if (ApproximatePaper(samples) is not { } seed)
            return null;

        // Exclude ink passing through the outer ring, then verify that the fit still sees all sides.
        var fit = new PlaneFit();
        foreach (var sample in samples)
            if (ColorError(seed, sample) <= 24)
                fit.Add(sample);
        if (fit.Solve() is not { } paper)
            return null;

        var accepted = 0;
        var left = 0;
        var right = 0;
        var top = 0;
        var bottom = 0;
        foreach (var sample in samples)
        {
            if (ColorError(paper, sample) > 13)
                continue;
            accepted++;
            if (sample.X < area.Left) left++;
            if (sample.X >= area.Right) right++;
            if (sample.Y < area.Top) top++;
            if (sample.Y >= area.Bottom) bottom++;
        }
        return accepted >= samples.Count * .87 && left >= 4 && right >= 4 && top >= 4 && bottom >= 4
            ? paper : null;
    }

    private static float ColorError(PaperPlane paper, Sample sample)
    {
        var diff = Vector3.Abs(paper.At(sample.X, sample.Y) - new Vector3(sample.Red, sample.Green, sample.Blue));
        return Math.Max(diff.X, Math.Max(diff.Y, diff.Z));
    }

    private static byte[]? RecoverGradient(byte[] pixels, int width, int height, Region area, List<Sample> samples)
    {
        if (FitPaper(samples, area) is not { } paper)
            return null;

        var mask = new byte[area.Width * area.Height];
        var candidates = 0;
        for (var y = 0; y < area.Height; y++)
            for (var x = 0; x < area.Width; x++)
                if (IsInk(x + area.Left, y + area.Top))
                {
                    mask[y * area.Width + x] = 1;
                    candidates++;
                }
        if (candidates == 0 || candidates > mask.Length * .48)
            return null;

        var patch = new byte[mask.Length * 4];
        var component = new int[candidates];
        var changed = false;
        for (var index = 0; index < mask.Length; index++)
        {
            if (mask[index] != 1)
                continue;
            var end = 1;
            var touchesDrawing = false;
            component[0] = index;
            mask[index] = 2;
            for (var start = 0; start < end; start++)
            {
                var current = component[start];
                var x = current % area.Width;
                var y = current / area.Width;
                for (var dy = -1; dy <= 1; dy++)
                    for (var dx = -1; dx <= 1; dx++)
                    {
                        var nx = x + dx;
                        var ny = y + dy;
                        if ((uint)nx >= area.Width || (uint)ny >= area.Height)
                        {
                            var px = area.Left + nx;
                            var py = area.Top + ny;
                            if (!touchesDrawing && (uint)px < width && (uint)py < height && IsInk(px, py))
                                touchesDrawing = true;
                            continue;
                        }
                        var neighbor = ny * area.Width + nx;
                        if (mask[neighbor] != 1)
                            continue;
                        mask[neighbor] = 2;
                        component[end++] = neighbor;
                    }
            }
            if (touchesDrawing)
                continue;

            changed = true;
            foreach (var position in component.AsSpan(0, end))
            {
                var color = Vector3.Clamp(paper.At(area.Left + position % area.Width, area.Top + position / area.Width),
                    Vector3.Zero, new Vector3(255));
                var target = position * 4;
                patch[target] = (byte)MathF.Round(color.X);
                patch[target + 1] = (byte)MathF.Round(color.Y);
                patch[target + 2] = (byte)MathF.Round(color.Z);
                patch[target + 3] = 255;
            }
        }
        return changed ? patch : null;

        bool IsInk(int x, int y)
        {
            var index = (y * width + x) * 4;
            if (pixels[index + 3] < 240)
                return false;
            var expected = paper.At(x, y);
            var expectedLuma = (expected.X * 54 + expected.Y * 183 + expected.Z * 19) / 256;
            return expectedLuma - Luma(pixels[index], pixels[index + 1], pixels[index + 2]) >= 32;
        }
    }
}
