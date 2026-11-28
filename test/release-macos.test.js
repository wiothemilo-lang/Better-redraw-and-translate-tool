import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  MAC_APP_BUNDLE,
  MAC_ARCHITECTURES,
  MAC_BUNDLE_ID,
  MAC_TARGETS,
  buildMacCodesignArgs,
  buildMacDmgArgs,
  buildMacNotarytoolArgs,
  buildMacZipArgs,
  macArtifactNames,
  macEntitlements,
  macInheritedEntitlements,
  macPackagerOptions,
  macSigningConfig,
  releaseTarget,
} from "../scripts/package-release.mjs"

const root = fileURLToPath(new URL("..", import.meta.url))

test("macOS packaging ships a .app, a .dmg, and a .zip for both architectures", () => {
  assert.deepEqual(MAC_TARGETS, ["app", "dmg", "zip"])
  assert.deepEqual(MAC_ARCHITECTURES, ["arm64", "x64"])
  assert.deepEqual(macPackagerOptions(), {
    appBundleId: MAC_BUNDLE_ID,
    appCategoryType: "public.app-category.graphics-design",
  })
  assert.equal(MAC_APP_BUNDLE, "Nixio.app")
})

test("the osx RID maps onto packager's darwin output alongside linux and win", () => {
  assert.deepEqual(releaseTarget("osx-arm64"), { rid: "osx-arm64", family: "osx", arch: "arm64", platformName: "darwin" })
  assert.deepEqual(releaseTarget("osx-x64"), { rid: "osx-x64", family: "osx", arch: "x64", platformName: "darwin" })
  assert.equal(releaseTarget("linux-x64").platformName, "linux")
  assert.equal(releaseTarget("win-arm64").platformName, "win32")
  assert.equal(releaseTarget("darwin-x64"), null)
  assert.equal(releaseTarget("osx-ia32"), null)
})

test("the hardened runtime entitlements match the committed plists", () => {
  const entitlements = macEntitlements()
  assert.equal(entitlements, readFileSync(path.join(root, "desktop/assets/entitlements.mac.plist"), "utf8"))
  assert.equal(
    macInheritedEntitlements(),
    readFileSync(path.join(root, "desktop/assets/entitlements.mac.inherit.plist"), "utf8"),
  )
  for (const key of [
    "com.apple.security.cs.allow-jit",
    "com.apple.security.cs.allow-unsigned-executable-memory",
    "com.apple.security.cs.disable-library-validation",
    "com.apple.security.network.client",
    "com.apple.security.files.user-selected.read-write",
  ]) {
    assert.match(entitlements, new RegExp(`<key>${key.replace(/\./g, "\\.")}</key>\\s*<true/>`))
  }
  const inherited = macInheritedEntitlements()
  assert.match(inherited, /<key>com\.apple\.security\.inherit<\/key>\s*<true\/>/)
  assert.doesNotMatch(inherited, /network\.client/)
})

test("notarisation reads credentials from the environment and fails in Vietnamese when they are missing", () => {
  assert.deepEqual(
    macSigningConfig({ CODESIGN_IDENTITY: "Developer ID Application: Nixio (ABCDE12345)", MAC_NOTARIZE: "1" }),
    { identity: "Developer ID Application: Nixio (ABCDE12345)", notarize: true },
  )
  assert.deepEqual(macSigningConfig({}), { identity: "", notarize: false })
  assert.throws(
    () => macSigningConfig({ MAC_NOTARIZE: "1" }),
    /Không thể notarise bản macOS khi chưa đặt CODESIGN_IDENTITY/,
  )

  const target = "/tmp/Nixio.app"
  assert.throws(
    () => buildMacNotarytoolArgs({ target, env: {} }),
    /Thiếu thông tin xác thực notarisation \(APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID\)/,
  )
  assert.throws(
    () => buildMacNotarytoolArgs({ target, env: { APPLE_ID: "dev@example.com", APPLE_TEAM_ID: "ABCDE12345" } }),
    /Thiếu thông tin xác thực notarisation \(APPLE_APP_SPECIFIC_PASSWORD\)/,
  )
  assert.deepEqual(
    buildMacNotarytoolArgs({
      target,
      env: {
        APPLE_ID: "dev@example.com",
        APPLE_APP_SPECIFIC_PASSWORD: "app-specific",
        APPLE_TEAM_ID: "ABCDE12345",
      },
    }),
    [
      "notarytool",
      "submit",
      "--apple-id",
      "dev@example.com",
      "--password",
      "app-specific",
      "--team-id",
      "ABCDE12345",
      "--wait",
      target,
    ],
  )
})

test("artifact names follow the Nixio-<version>-mac-<arch> convention", () => {
  assert.deepEqual(macArtifactNames({ version: "1.3.0", arch: "arm64" }), {
    app: "Nixio.app",
    dmg: "Nixio-1.3.0-mac-arm64.dmg",
    zip: "Nixio-1.3.0-mac-arm64.zip",
  })
  assert.deepEqual(macArtifactNames({ version: "v1.4.0-beta.2", arch: "x64" }), {
    app: "Nixio.app",
    dmg: "Nixio-1.4.0-beta.2-mac-x64.dmg",
    zip: "Nixio-1.4.0-beta.2-mac-x64.zip",
  })
  assert.throws(() => macArtifactNames({ version: "latest", arch: "arm64" }), /Invalid release version/)
})

test("codesign, dmg, and zip commands target the bundle with hardened runtime and entitlements", () => {
  assert.deepEqual(
    buildMacCodesignArgs({ identity: "Developer ID Application: X", target: "/tmp/Nixio.app", entitlements: "/tmp/entitlements.mac.plist" }),
    [
      "--force",
      "--timestamp",
      "--options",
      "runtime",
      "--entitlements",
      "/tmp/entitlements.mac.plist",
      "--sign",
      "Developer ID Application: X",
      "/tmp/Nixio.app",
    ],
  )
  assert.deepEqual(
    buildMacDmgArgs({ appPath: "/tmp/Nixio.app", outputFile: "/tmp/release/Nixio-1.3.0-mac-arm64.dmg" }),
    [
      "create",
      "-volname",
      "Nixio",
      "-srcfolder",
      "/tmp/Nixio.app",
      "-ov",
      "-format",
      "UDZO",
      "/tmp/release/Nixio-1.3.0-mac-arm64.dmg",
    ],
  )
  assert.deepEqual(
    buildMacZipArgs({ appPath: "/tmp/Nixio.app", outputFile: "/tmp/release/Nixio-1.3.0-mac-arm64.zip" }),
    ["-c", "-k", "--sequesterRsrc", "--keepParent", "/tmp/Nixio.app", "/tmp/release/Nixio-1.3.0-mac-arm64.zip"],
  )
})
