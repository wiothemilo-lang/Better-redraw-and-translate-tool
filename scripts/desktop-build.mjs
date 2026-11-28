import { cpSync } from "node:fs"
import { packager } from "@electron/packager"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { macPackagerOptions } from "./package-release.mjs"

const root = fileURLToPath(new URL("..", import.meta.url))
const platformByRid = { linux: "linux", win: "win32", osx: "darwin" }
const ridByPlatform = { linux: "linux", win32: "win", darwin: "osx" }
const [mode = "app", rid = ridByPlatform[process.platform] + "-" + process.arch] = process.argv.slice(2)
const [family, arch] = rid.split("-")
const platform = platformByRid[family]
if (!["app", "native"].includes(mode) || !platform || !["x64", "arm64"].includes(arch)) {
  throw new Error("Use app|native with linux-x64, win-x64, osx-x64 or an arm64 equivalent.")
}
const worker = path.join(root, "native", "out", rid, "native-worker")

run(process.env.KHUNG_THOAI_DOTNET ?? "dotnet", [
  "publish", "native/KhungThoai.Redraw.csproj", "-c", "Release", "-r", rid,
  "--self-contained", "-p:PublishSingleFile=true", "-p:PublishTrimmed=true",
  "-p:RestoreLockedMode=true", "-o", worker,
])

if (process.env.KHUNG_THOAI_OCR_BUNDLE) {
  cpSync(process.env.KHUNG_THOAI_OCR_BUNDLE, path.join(worker, "ocr"), { recursive: true })
}

if (mode === "app") {
  run(process.execPath, [path.join(root, "node_modules", "vite", "bin", "vite.js"), "build"])
  const paths = await packager({
    dir: root,
    name: "Nixio",
    executableName: "Nixio",
    platform,
    arch,
    ...(platform === "darwin" ? macPackagerOptions() : {}),
    asar: true,
    overwrite: true,
    out: path.join(root, "desktop-dist"),
    extraResource: [worker],
    ignore: /^(\/(?:node_modules|native|scripts|src|test|desktop-dist|release-dist|release-stage|release-verify|artifacts|\.git)(?:\/|$)|\/(?:package-lock\.json|index\.html|vite\.config\.js|.*\.md)$)/,
  })
  paths.forEach((location) => console.log(location))
}

function run(executable, args) {
  const result = spawnSync(executable, args, { cwd: root, stdio: "inherit" })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status || 1)
}
