// Builds the `latest.json` manifest the updater fetches from GitHub Releases.
//
// Run it after `npm run tauri build`. It reads the version from
// tauri.conf.json, finds the NSIS updater bundle plus its .sig, and writes
// latest.json next to them. Upload that file and the .exe to the release.
//
//   node scripts/make-latest-json.mjs ["release notes"]

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const conf = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
const version = conf.version;
const repoUrl = conf.plugins.updater.endpoints[0].replace(
  /\/releases\/latest\/download\/latest\.json$/,
  ""
);

const bundleDir = join(root, "src-tauri/target/release/bundle/nsis");
let files;
try {
  files = readdirSync(bundleDir);
} catch {
  console.error(`No NSIS bundle at ${bundleDir}. Run: npm run tauri build`);
  process.exit(1);
}

// Old releases stay in the bundle dir, so match on this build's version —
// picking the first *-setup.exe would happily ship a stale installer.
const setup = files.find((f) => f.includes(`_${version}_`) && f.endsWith("-setup.exe"));
const sigFile = files.find((f) => f.includes(`_${version}_`) && f.endsWith("-setup.exe.sig"));
if (!setup || !sigFile) {
  console.error(
    "Missing setup.exe or its .sig. Ensure bundle.createUpdaterArtifacts is true and\n" +
      "TAURI_SIGNING_PRIVATE_KEY(_PATH) was set during the build."
  );
  process.exit(1);
}

const manifest = {
  version,
  notes: process.argv[2] ?? `OpenTerm ${version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature: readFileSync(join(bundleDir, sigFile), "utf8").trim(),
      // The updater downloads this URL directly, so the asset name on the
      // release must match the built file name exactly.
      url: `${repoUrl}/releases/download/v${version}/${setup}`,
    },
  },
};

const out = join(bundleDir, "latest.json");
writeFileSync(out, JSON.stringify(manifest, null, 2));
console.log(`Wrote ${out}\n\nUpload to release v${version}:\n  ${join(bundleDir, setup)}\n  ${out}`);
