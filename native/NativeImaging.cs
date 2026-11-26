using System.Buffers.Binary;
using System.IO.Compression;
using System.Text;
using System.Text.Json.Nodes;

internal static class NativeImaging
{
    private static readonly uint[] CrcTable = BuildCrcTable();

    private static uint[] BuildCrcTable()
    {
        var table = new uint[256];
        for (uint i = 0; i < 256; i++)
        {
            var crc = i;
            for (var bit = 0; bit < 8; bit++)
                crc = (crc >> 1) ^ ((crc & 1) == 0 ? 0u : 0xedb88320u);
            table[i] = crc;
        }
        return table;
    }

    internal static (int Width, int Height) Dimensions(JsonObject options, int bytes, int maximum = 28_000_000)
    {
        var width = (int)options["width"]!;
        var height = (int)options["height"]!;
        if (width <= 0 || height <= 0 || (long)width * height > maximum || (long)width * height * 4 != bytes)
            throw new InvalidDataException("Invalid RGBA image dimensions.");
        return (width, height);
    }

    internal static byte[] Mask(JsonObject options, byte[] data)
    {
        var (width, height) = Dimensions(options, data.Length);
        var mask = Enumerable.Repeat((byte)255, width * height).ToArray();
        var originX = (double?)options["left"] ?? 0;
        var originY = (double?)options["top"] ?? 0;
        var imageWidth = (double?)options["imageWidth"] ?? width;
        var imageHeight = (double?)options["imageHeight"] ?? height;
        if (imageWidth <= 0 || imageHeight <= 0 || !double.IsFinite(imageWidth + imageHeight + originX + originY))
            throw new InvalidDataException("Invalid mask coordinates.");
        foreach (var stroke in options["strokes"]?.AsArray() ?? [])
        {
            var radius = (double)stroke!["size"]! * Math.Min(imageWidth, imageHeight) / 2;
            var mode = (string)stroke["mode"]!;
            var points = stroke["points"]!.AsArray();
            if (!double.IsFinite(radius) || radius <= 0 || radius > 10000 || points.Count == 0 ||
                (mode != "erase" && mode != "restore")) throw new InvalidDataException("Invalid brush stroke.");
            for (var index = 0; index < points.Count; index++)
            {
                var a = points[Math.Max(0, index - 1)]!;
                var b = points[index]!;
                var ax = (double)a["x"]! * imageWidth - originX;
                var ay = (double)a["y"]! * imageHeight - originY;
                var bx = (double)b["x"]! * imageWidth - originX;
                var by = (double)b["y"]! * imageHeight - originY;
                if (!double.IsFinite(ax + ay + bx + by)) throw new InvalidDataException("Invalid brush coordinates.");
                var dx = bx - ax;
                var dy = by - ay;
                var squared = dx * dx + dy * dy;
                for (var y = Math.Max(0, (int)Math.Floor(Math.Min(ay, by) - radius - 1)); y < Math.Min(height, Math.Ceiling(Math.Max(ay, by) + radius + 1)); y++)
                for (var x = Math.Max(0, (int)Math.Floor(Math.Min(ax, bx) - radius - 1)); x < Math.Min(width, Math.Ceiling(Math.Max(ax, bx) + radius + 1)); x++)
                {
                    var t = squared == 0 ? 0 : Math.Clamp(((x + .5 - ax) * dx + (y + .5 - ay) * dy) / squared, 0, 1);
                    var distance = Math.Sqrt(Math.Pow(x + .5 - ax - t * dx, 2) + Math.Pow(y + .5 - ay - t * dy, 2));
                    var coverage = Math.Clamp(radius + .5 - distance, 0, 1);
                    var offset = y * width + x;
                    mask[offset] = (byte)Math.Round(mode == "erase" ? mask[offset] * (1 - coverage) : mask[offset] + (255 - mask[offset]) * coverage);
                }
            }
        }
        var expand = Math.Clamp((int?)options["expand"] ?? 0, -8, 8);
        if (expand != 0)
        {
            var temp = new byte[width * height];
            var radius = Math.Abs(expand);
            var dilate = expand > 0;
            for (var y = 0; y < height; y++)
            {
                var row = y * width;
                for (var x = 0; x < width; x++)
                {
                    if (!dilate && (x < radius || x + radius >= width))
                    {
                        temp[row + x] = 0;
                        continue;
                    }
                    var alpha = dilate ? 0 : 255;
                    var start = Math.Max(0, x - radius);
                    var end = Math.Min(width - 1, x + radius);
                    for (var xx = start; xx <= end; xx++)
                    {
                        var sample = mask[row + xx];
                        alpha = dilate ? Math.Max(alpha, sample) : Math.Min(alpha, sample);
                    }
                    temp[row + x] = (byte)alpha;
                }
            }
            for (var y = 0; y < height; y++)
            {
                var row = y * width;
                if (!dilate && (y < radius || y + radius >= height))
                {
                    Array.Clear(mask, row, width);
                    continue;
                }
                var start = Math.Max(0, y - radius);
                var end = Math.Min(height - 1, y + radius);
                for (var x = 0; x < width; x++)
                {
                    var alpha = dilate ? 0 : 255;
                    for (var yy = start; yy <= end; yy++)
                    {
                        var sample = temp[yy * width + x];
                        alpha = dilate ? Math.Max(alpha, sample) : Math.Min(alpha, sample);
                    }
                    mask[row + x] = (byte)alpha;
                }
            }
        }
        for (var index = 0; index < mask.Length; index++)
            data[index * 4 + 3] = (byte)((data[index * 4 + 3] * mask[index] + 127) / 255);
        return data;
    }

    internal static (JsonObject, byte[]) Preprocess(JsonObject options, byte[] data)
    {
        var (width, height) = Dimensions(options, data.Length);
        var scale = Math.Clamp((int?)options["scale"] ?? 2, 1, 3);
        if ((long)width * height * scale * scale > 28_000_000) scale = 1;
        var gray = new byte[width * height];
        var histogram = new int[256];
        for (var index = 0; index < gray.Length; index++)
        {
            var offset = index * 4;
            var value = (data[offset] * 54 + data[offset + 1] * 183 + data[offset + 2] * 19) / 256;
            gray[index] = (byte)((value * data[offset + 3] + 255 * (255 - data[offset + 3])) / 255);
            histogram[gray[index]]++;
        }
        var low = Percentile(.01);
        var high = Math.Max(low + 1, Percentile(.99));
        var denoise = (bool?)options["denoise"] ?? true;
        var cleaned = new byte[width * height];
        Span<byte> neighbors = stackalloc byte[5];
        for (var y = 0; y < height; y++)
        for (var x = 0; x < width; x++)
        {
            var value = (int)gray[y * width + x];
            if (denoise && x > 0 && y > 0 && x < width - 1 && y < height - 1)
            {
                neighbors[0] = gray[y * width + x - 1];
                neighbors[1] = gray[y * width + x + 1];
                neighbors[2] = gray[(y - 1) * width + x];
                neighbors[3] = gray[(y + 1) * width + x];
                neighbors[4] = (byte)value;
                neighbors.Sort();
                value = neighbors[2];
            }
            cleaned[y * width + x] = (byte)Math.Clamp((value - low) * 255 / (high - low), 0, 255);
        }
        var outWidth = width * scale;
        var outHeight = height * scale;
        var output = new byte[outWidth * outHeight * 4];
        if (scale == 1)
        {
            for (var i = 0; i < cleaned.Length; i++)
            {
                var value = cleaned[i];
                var offset = i * 4;
                output[offset] = output[offset + 1] = output[offset + 2] = value;
                output[offset + 3] = 255;
            }
        }
        else
        {
            for (var oy = 0; oy < outHeight; oy++)
            {
                var sy = Math.Clamp((oy + .5) / scale - .5, 0, height - 1);
                var y0 = (int)Math.Floor(sy);
                var y1 = Math.Min(height - 1, y0 + 1);
                var fy = sy - y0;
                for (var ox = 0; ox < outWidth; ox++)
                {
                    var sx = Math.Clamp((ox + .5) / scale - .5, 0, width - 1);
                    var x0 = (int)Math.Floor(sx);
                    var x1 = Math.Min(width - 1, x0 + 1);
                    var fx = sx - x0;
                    var top = cleaned[y0 * width + x0] * (1 - fx) + cleaned[y0 * width + x1] * fx;
                    var bottom = cleaned[y1 * width + x0] * (1 - fx) + cleaned[y1 * width + x1] * fx;
                    var value = (byte)Math.Clamp(Math.Round(top * (1 - fy) + bottom * fy), 0, 255);
                    var offset = (oy * outWidth + ox) * 4;
                    output[offset] = output[offset + 1] = output[offset + 2] = value;
                    output[offset + 3] = 255;
                }
            }
        }
        return (new JsonObject { ["width"] = outWidth, ["height"] = outHeight }, output);

        int Percentile(double fraction)
        {
            var count = 0;
            for (var i = 0; i < histogram.Length; i++)
            {
                count += histogram[i];
                if (count >= gray.Length * fraction) return i;
            }
            return 255;
        }
    }

    internal static byte[] CompositePng(JsonObject options, byte[] data)
    {
        var width = (int)options["width"]!;
        var height = (int)options["height"]!;
        if (width <= 0 || height <= 0 || (long)width * height > 28_000_000)
            throw new InvalidDataException("Invalid RGBA image dimensions.");
        var length = width * height * 4;
        if (data.Length < (long)length * 2) throw new InvalidDataException("Missing image layers.");
        var output = data.AsSpan(0, length).ToArray();
        var offset = length * 2;
        foreach (var patch in options["patches"]?.AsArray() ?? [])
        {
            var w = (int)patch!["width"]!;
            var h = (int)patch["height"]!;
            var left = (int)patch["left"]!;
            var top = (int)patch["top"]!;
            if (w <= 0 || h <= 0 || left < 0 || top < 0 || (long)left + w > width || (long)top + h > height ||
                (long)offset + (long)w * h * 4 > data.Length) throw new InvalidDataException("Invalid export patch.");
            for (var y = 0; y < h; y++)
            for (var x = 0; x < w; x++) Blend(output, ((top + y) * width + left + x) * 4, data, offset + (y * w + x) * 4);
            offset += w * h * 4;
        }
        if (offset != data.Length) throw new InvalidDataException("Unexpected export payload.");
        for (var index = 0; index < length; index += 4) Blend(output, index, data, length + index);
        return Png(output, width, height);
    }

    private static void Blend(byte[] target, int at, byte[] source, int from)
    {
        var srcAlphaByte = source[from + 3];
        if (srcAlphaByte == 0) return;
        if (srcAlphaByte == 255)
        {
            target[at] = source[from];
            target[at + 1] = source[from + 1];
            target[at + 2] = source[from + 2];
            target[at + 3] = 255;
            return;
        }
        var alpha = srcAlphaByte / 255d;
        var oldAlpha = target[at + 3] / 255d;
        var resultAlpha = alpha + oldAlpha * (1 - alpha);
        for (var channel = 0; channel < 3; channel++)
            target[at + channel] = resultAlpha == 0 ? (byte)0 : (byte)Math.Round((source[from + channel] * alpha + target[at + channel] * oldAlpha * (1 - alpha)) / resultAlpha);
        target[at + 3] = (byte)Math.Round(resultAlpha * 255);
    }

    internal static byte[] Png(byte[] rgba, int width, int height)
    {
        using var output = new MemoryStream();
        output.Write(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 });
        var header = new byte[13];
        BinaryPrimitives.WriteInt32BigEndian(header, width);
        BinaryPrimitives.WriteInt32BigEndian(header.AsSpan(4), height);
        header[8] = 8;
        header[9] = 6;
        Chunk("IHDR", header);
        using var compressed = new MemoryStream();
        using (var zlib = new ZLibStream(compressed, CompressionLevel.Fastest, true))
        {
            for (var y = 0; y < height; y++)
            {
                zlib.WriteByte(0);
                zlib.Write(rgba, y * width * 4, width * 4);
            }
        }
        Chunk("IDAT", compressed.ToArray());
        Chunk("IEND", []);
        return output.ToArray();

        void Chunk(string type, byte[] bytes)
        {
            var tag = Encoding.ASCII.GetBytes(type);
            Span<byte> size = stackalloc byte[4];
            BinaryPrimitives.WriteInt32BigEndian(size, bytes.Length);
            output.Write(size);
            output.Write(tag);
            output.Write(bytes);
            var crc = 0xffffffffu;
            foreach (var value in tag) crc = CrcTable[(crc ^ value) & 0xff] ^ (crc >> 8);
            foreach (var value in bytes) crc = CrcTable[(crc ^ value) & 0xff] ^ (crc >> 8);
            BinaryPrimitives.WriteUInt32BigEndian(size, ~crc);
            output.Write(size);
        }
    }
}
