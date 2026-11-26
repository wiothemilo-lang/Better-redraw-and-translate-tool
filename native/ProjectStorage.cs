using System.IO.Compression;
using System.Text.Json.Nodes;

internal sealed class ProjectStorage : IDisposable
{
    private sealed record Transfer(string Path, string Temporary, FileStream Stream, bool Backup, ZipArchive? Zip);
    private readonly Dictionary<string, Transfer> transfers = [];
    private readonly Dictionary<string, int> pageCounts = [];
    private readonly Dictionary<string, FileStream> readers = [];

    internal (JsonObject, byte[]) Execute(string operation, JsonObject options, byte[] data)
    {
        switch (operation)
        {
            case "fileBegin":
            case "zipBegin":
            {
                var path = Path.GetFullPath((string)options["path"]!);
                if (Path.GetDirectoryName(path) is { Length: > 0 } directory)
                    Directory.CreateDirectory(directory);
                var temporary = path + "." + Guid.NewGuid() + ".tmp";
                var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write);
                var id = Guid.NewGuid().ToString();
                var zip = operation == "zipBegin" ? new ZipArchive(stream, ZipArchiveMode.Create, true) : null;
                pageCounts[id] = 0;
                transfers.Add(id, new Transfer(path, temporary, stream, (bool?)options["backup"] ?? false, zip));
                return (new JsonObject { ["id"] = id }, []);
            }
            case "fileOpen":
            {
                var stream = new FileStream((string)options["path"]!, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                var id = Guid.NewGuid().ToString();
                readers.Add(id, stream);
                return (new JsonObject { ["id"] = id, ["size"] = stream.Length }, []);
            }
            case "fileReadNext":
            {
                if (!readers.TryGetValue((string)options["id"]!, out var stream)) throw new InvalidDataException("Unknown reader.");
                var bytes = new byte[(int)Math.Min(4 * 1024 * 1024, stream.Length - stream.Position)];
                stream.ReadExactly(bytes);
                return (new JsonObject { ["size"] = stream.Length }, bytes);
            }
            case "fileClose":
            {
                if (readers.Remove((string)options["id"]!, out var stream)) stream.Dispose();
                return (new JsonObject(), []);
            }
            case "fileRead":
            {
                using var stream = File.OpenRead((string)options["path"]!);
                var offset = (long?)options["offset"] ?? 0;
                if (offset < 0 || offset > stream.Length) throw new InvalidDataException("Invalid project size or offset.");
                stream.Position = offset;
                var bytes = new byte[(int)Math.Min(4 * 1024 * 1024, stream.Length - offset)];
                stream.ReadExactly(bytes);
                return (new JsonObject { ["size"] = stream.Length }, bytes);
            }
            case "fileAppend":
            {
                var item = Get(options);
                if (item.Zip != null) throw new InvalidDataException("Invalid project transfer.");
                item.Stream.Write(data);
                return (new JsonObject(), []);
            }
            case "zipAppend":
            case "zipPage":
            {
                var item = Get(options);
                if (item.Zip == null) throw new InvalidDataException("Expected a ZIP transfer.");
                var name = (string)options["name"]!;
                if (name != Path.GetFileName(name) || name.Contains('\\') || !name.EndsWith(".png", StringComparison.OrdinalIgnoreCase) ||
                    pageCounts[(string)options["id"]!] >= 50) throw new InvalidDataException("Invalid ZIP page name.");
                pageCounts[(string)options["id"]!]++;
                using var entry = item.Zip.CreateEntry(name, CompressionLevel.NoCompression).Open();
                var png = operation == "zipPage" ? NativeImaging.CompositePng(options, data) : data;
                if (png.Length < 8 || !png.AsSpan(0, 8).SequenceEqual(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }))
                    throw new InvalidDataException("Invalid PNG page.");
                entry.Write(png);
                return (new JsonObject(), []);
            }
            case "fileCommit":
            {
                var id = (string)options["id"]!;
                var item = Get(options);
                transfers.Remove(id);
                pageCounts.Remove(id);
                try
                {
                    item.Zip?.Dispose();
                    item.Stream.Flush(true);
                    item.Stream.Dispose();
                    if (item.Backup && File.Exists(item.Path))
                    {
                        File.Copy(item.Path, item.Temporary + ".bak");
                        ReplaceCommittedFile(item.Temporary + ".bak", item.Path + ".bak");
                    }
                    ReplaceCommittedFile(item.Temporary, item.Path);
                }
                finally { item.Stream.Dispose(); File.Delete(item.Temporary); File.Delete(item.Temporary + ".bak"); }
                return (new JsonObject(), []);
            }
            case "fileCancel":
            {
                var id = (string)options["id"]!;
                if (transfers.Remove(id, out var item)) Delete(item);
                pageCounts.Remove(id);
                return (new JsonObject(), []);
            }
            default: throw new InvalidDataException("Unknown native operation: " + operation);
        }
    }

    private static void ReplaceCommittedFile(string source, string destination)
    {
        // ReplaceFile preserves open readers on Windows. MoveFileEx overwrite can deny access
        // even when those readers explicitly share deletion.
        if (OperatingSystem.IsWindows() && File.Exists(destination))
            File.Replace(source, destination, null);
        else
            File.Move(source, destination, true);
    }

    private Transfer Get(JsonObject options) => transfers.TryGetValue((string)options["id"]!, out var item)
        ? item : throw new InvalidDataException("Unknown transfer.");

    private static void Delete(Transfer item)
    {
        try { item.Zip?.Dispose(); }
        finally
        {
            item.Stream.Dispose();
            File.Delete(item.Temporary);
        }
    }

    public void Dispose()
    {
        foreach (var item in transfers.Values) Delete(item);
        transfers.Clear();
        foreach (var reader in readers.Values) reader.Dispose();
        readers.Clear();
    }
}
