// One-command release build: `npm run release`.
//
// Wraps `tauri build` so the updater signing key is always passed correctly.
// Doing this in Node rather than the shell is deliberate — in PowerShell,
// `$env:VAR = ""` deletes the variable instead of setting it empty, so a
// passwordless key silently fails to decrypt partway through a 15-minute
// build. Node's spawn env has no such quirk.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const keyPath = process.env.TAURI_SIGNING_PRIVATE_KEY_PATH ?? join(homedir(), ".tauri/openterm.key");
if (!existsSync(keyPath)) {
  console.error(
    `No signing key at ${keyPath}.\n` +
      `Restore your backup, or generate a new one with:\n` +
      `  npx tauri signer generate -w "${keyPath}" -p ""\n` +
      `Note: a NEW key breaks updates for everyone already running OpenTerm.`
  );
  process.exit(1);
}

const env = {
  ...process.env,
  TAURI_SIGNING_PRIVATE_KEY: readFileSync(keyPath, "utf8").trim(),
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "",
  // Panic locations embed absolute source paths, which would ship the build
  // machine's user folder inside the public binary. Remap them away.
  RUSTFLAGS: [
    process.env.RUSTFLAGS,
    `--remap-path-prefix=${join(homedir(), ".cargo")}=cargo`,
    `--remap-path-prefix=${join(process.cwd(), "src-tauri")}=src-tauri`,
  ].filter(Boolean).join(" "),
};

for (const args of [["tauri", "build"], ["node", "scripts/make-latest-json.mjs", ...process.argv.slice(2)]]) {
  const [cmd, ...rest] = args;
  const r = spawnSync(cmd === "tauri" ? "npx" : cmd, cmd === "tauri" ? ["tauri", ...rest] : rest, {
    stdio: "inherit",
    env,
    // Only npx needs a shell on Windows; a shell would split the release notes
    // argument at spaces for the node step.
    shell: cmd === "tauri" && process.platform === "win32",
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
