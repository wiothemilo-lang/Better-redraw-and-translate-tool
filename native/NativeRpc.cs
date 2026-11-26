using System.Buffers.Binary;
using System.Text;
using System.Text.Json.Nodes;

internal static class NativeRpc
{
    internal const int MaximumData = 512 * 1024 * 1024;
    internal static async Task<int> Run()
    {
        using var input = Console.OpenStandardInput();
        using var output = Console.OpenStandardOutput();
        using var storage = new ProjectStorage();
        var header = new byte[12];
        while (input.ReadByte() is var first && first != -1)
        {
            header[0] = (byte)first;
            input.ReadExactly(header.AsSpan(1));
            var metaLength = BinaryPrimitives.ReadInt32LittleEndian(header.AsSpan(4));
            var dataLength = BinaryPrimitives.ReadInt32LittleEndian(header.AsSpan(8));
            if (Encoding.ASCII.GetString(header, 0, 4) != "KTR1" ||
                metaLength < 2 || metaLength > 4 * 1024 * 1024 || dataLength < 0 || dataLength > MaximumData) return 1;
            var metadata = new byte[metaLength];
            var data = new byte[dataLength];
            input.ReadExactly(metadata);
            input.ReadExactly(data);
            JsonObject reply;
            byte[] bytes = [];
            try
            {
                var request = JsonNode.Parse(metadata)!.AsObject();
                if (request["version"]?.GetValue<int>() != 1) throw new InvalidDataException("Unsupported protocol version.");
                var options = request["options"]?.AsObject() ?? new JsonObject();
                var operation = request["operation"]!.GetValue<string>();
                NativeProgress.Report = (progress, stage) => Write(new JsonObject {
                    ["version"] = 1, ["event"] = "progress", ["progress"] = progress, ["stage"] = stage,
                }, []);
                (reply, bytes) = operation switch
                {
                    "capabilities" => (await LocalOcr.Capabilities(), []),
                    "redraw" => Redraw(options, data),
                    "mask" => (new JsonObject(), NativeImaging.Mask(options, data)),
                    "preprocess" => NativeImaging.Preprocess(options, data),
                    "ocr" => (await LocalOcr.Recognize(options, data), []),
                    "png" => (new JsonObject(), NativeImaging.CompositePng(options, data)),
                    _ => storage.Execute(operation, options, data),
                };
                reply["ok"] = true;
            }
            catch (Exception error)
            {
                reply = new JsonObject { ["ok"] = false, ["error"] = error.Message };
            }
            NativeProgress.Report = null;
            reply["version"] = 1;
            Write(reply, bytes);
        }
        return 0;

        void Write(JsonObject reply, byte[] bytes)
        {
            var metadata = Encoding.UTF8.GetBytes(reply.ToJsonString());
            Span<byte> responseHeader = stackalloc byte[12];
            "KTR1"u8.CopyTo(responseHeader);
            BinaryPrimitives.WriteInt32LittleEndian(responseHeader[4..], metadata.Length);
            BinaryPrimitives.WriteInt32LittleEndian(responseHeader[8..], bytes.Length);
            output.Write(responseHeader);
            output.Write(metadata);
            output.Write(bytes);
            output.Flush();
        }
    }

    private static (JsonObject, byte[]) Redraw(JsonObject options, byte[] data)
    {
        var (width, height) = NativeImaging.Dimensions(options, data.Length, 1_600_000);
        var region = options["inner"]!;
        var area = new Region((int)region["left"]!, (int)region["top"]!, (int)region["right"]!, (int)region["bottom"]!);
        if (area.Left < 0 || area.Top < 0 || area.Right > width || area.Bottom > height || area.Width < 2 || area.Height < 2)
            throw new InvalidDataException("Invalid redraw region.");
        return (new JsonObject(), RedrawEngine.Recover(data, width, height, area) ?? []);
    }
}
