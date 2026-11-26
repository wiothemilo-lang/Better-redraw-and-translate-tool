import test from "node:test"
import assert from "node:assert/strict"
import {
  buildDebianControl,
  buildDebianPostinst,
  buildDesktopEntry,
  buildInnoSetupScript,
  buildLinuxLauncher,
  buildMimeXml,
  buildRpmSpec,
  normalizeVersion,
  rpmVersionParts,
} from "../scripts/package-release.mjs"

test("normalizeVersion and rpmVersionParts handle stable and prerelease semver", () => {
  assert.equal(normalizeVersion("v1.0.0"), "1.0.0")
  assert.deepEqual(rpmVersionParts("1.0.0"), { version: "1.0.0", release: "1" })
  assert.deepEqual(rpmVersionParts("1.2.0-beta.1"), { version: "1.2.0", release: "0.1.beta.1" })
  assert.throws(() => normalizeVersion("invalid"))
})

test("Debian control & postinst support both Debian 12 and Ubuntu 24.04 t64 libraries", () => {
  const control = buildDebianControl({ version: "1.0.0", arch: "amd64", installedSizeKb: 123456 })
  assert.match(control, /^Package: khung-thoai/m)
  assert.match(control, /^Version: 1\.0\.0/m)
  assert.match(control, /libgtk-3-0 \| libgtk-3-0t64/)
  assert.match(control, /libasound2 \| libasound2t64/)
  assert.match(control, /Recommends: tesseract-ocr/)

  const postinst = buildDebianPostinst()
  assert.match(postinst, /chmod 4755 "\/opt\/khung-thoai\/chrome-sandbox"/)
  assert.match(buildDesktopEntry(), /Exec=\/usr\/bin\/khung-thoai %U/)
  assert.match(buildLinuxLauncher(), /exec \/opt\/khung-thoai\/Khung-Thoai/)
  assert.match(buildMimeXml(), /\*\.khungthoai/)
})

test("Fedora RPM spec configures non-stripping Electron build, Fedora deps, and sandbox permissions", () => {
  const spec = buildRpmSpec({
    version: "1.0.0",
    sourceDir: "/tmp/Khung-Thoai-linux-x64",
    iconPath: "/tmp/icon.svg",
  })
  assert.match(spec, /%define _build_id_links none/)
  assert.match(spec, /AutoReqProv:\s+no/)
  assert.match(spec, /Requires:\s+gtk3, nss, libXScrnSaver, mesa-libgbm, alsa-lib/)
  assert.match(spec, /Recommends:\s+tesseract/)
  assert.match(spec, /chmod 4755 "\/opt\/khung-thoai\/chrome-sandbox"/)
})

test("Inno Setup script generates Windows 10/11 64-bit installer with stable AppId and .khungthoai association", () => {
  const iss = buildInnoSetupScript({
    version: "1.0.0",
    sourceDir: "C:\\work\\Khung-Thoai-win32-x64",
    outputDir: "C:\\work\\release-dist",
    outputBaseName: "Khung-Thoai-1.0.0-win-x64-setup",
  })
  assert.match(iss, /AppId=\{\{7B6A2E3F-9C4D-4E5A-8B1F-4A9E6D2C8F01\}/)
  assert.match(iss, /ArchitecturesInstallIn64BitMode=x64compatible/)
  assert.match(iss, /PrivilegesRequired=lowest/)
  assert.match(iss, /\.khungthoai/)
})
