#!/usr/bin/env node
/**
 * Checks the committed legal-version manifest against the documents the Unity
 * client actually ships.
 *
 * A release step, not a unit test. It needs both checkouts, and it fails when
 * it cannot see the Unity one rather than skipping - the whole point is to
 * catch the two repositories disagreeing, and a check that quietly passes when
 * half its input is missing is what let this drift ship in the first place.
 *
 *   node scripts/verify-legal-versions.mjs [path-to-unity-checkout]
 *
 * Exits non-zero on any mismatch, with the differences printed.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));

const manifestPath = path.join(here, "../src/v2/legalVersionManifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

const unityRoot =
  process.argv[2] || process.env.UNITY_REPO || path.join(here, "../../unity");
const legalDir = path.join(unityRoot, "Assets/Resources/Legal");

const FILES = {
  terms: "terms-of-service.txt",
  privacy: "privacy-notice.txt",
  camera: "camera-and-face-processing.txt",
};

if (!fs.existsSync(legalDir)) {
  console.error(
    `Cannot see the client's legal documents at ${legalDir}.\n` +
      "Pass the Unity checkout as an argument or set UNITY_REPO. This check " +
      "exists to compare the two repositories and cannot do that with one."
  );
  process.exit(2);
}

const problems = [];

for (const [document, file] of Object.entries(FILES)) {
  const full = path.join(legalDir, file);

  if (!fs.existsSync(full)) {
    problems.push(`${document}: ${file} is missing from the client.`);
    continue;
  }

  const match = fs.readFileSync(full, "utf8").match(/^Version\s+(.+)$/im);
  const shipped = match ? match[1].trim() : null;

  if (!shipped) {
    problems.push(`${document}: ${file} has no parseable Version line.`);
  } else if (shipped !== manifest[document]) {
    problems.push(
      `${document}: the client ships ${shipped}, the manifest says ${manifest[document]}.`
    );
  }
}

if (problems.length > 0) {
  console.error("Legal versions disagree between the client and the server:\n");
  for (const problem of problems) console.error("  - " + problem);
  console.error(
    "\nUpdating a legal document means changing the document, this manifest, " +
      "the server's CURRENT_DOCUMENT_VERSIONS and the published web page together."
  );
  process.exit(1);
}

console.log("Legal versions agree:");
for (const [document, version] of Object.entries(manifest)) {
  if (document.startsWith("_")) continue;
  console.log(`  ${document.padEnd(8)} ${version}`);
}
