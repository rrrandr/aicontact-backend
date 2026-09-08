import manifest from "../../src/v2/legalVersionManifest.json";

import { CURRENT_DOCUMENT_VERSIONS } from "../../src/v2/legalDocuments";

/**
 * The versions the server enforces, against the manifest of what the client
 * ships.
 *
 * These drifted once and blocked everybody: the documents were revised to
 * "2026-09-06.4" and "2026-09-06.2" during the legal corrections while the
 * server's list stayed at the unsuffixed date, so every acceptance came back as
 * a stale version and nobody could get past the consent screen.
 *
 * The first attempt at this test read the Unity documents directly from a
 * sibling checkout and skipped itself when that was absent - which in a
 * backend-only CI job is not a test at all, just a green tick for work not
 * done. The manifest is committed here instead, so this always runs. Keeping
 * the manifest honest against the real documents is
 * scripts/verify-legal-versions.mjs, which is a release step and fails loudly
 * when it cannot see them.
 */
describe("the versions in force", () => {
  for (const document of ["terms", "privacy", "camera"]) {
    it(`${document} matches the manifest of what the client ships`, () => {
      expect(manifest[document]).toBeTruthy();
      expect(CURRENT_DOCUMENT_VERSIONS[document]).toBe(manifest[document]);
    });
  }

  it("the age attestation carries the Terms version it rides on", () => {
    expect(CURRENT_DOCUMENT_VERSIONS.age_attestation).toBe(
      CURRENT_DOCUMENT_VERSIONS.terms
    );
  });

  it("every document in force is covered by the manifest", () => {
    for (const document of Object.keys(CURRENT_DOCUMENT_VERSIONS)) {
      if (document === "age_attestation") continue;   // no document of its own
      expect(manifest[document]).toBeTruthy();
    }
  });
});
