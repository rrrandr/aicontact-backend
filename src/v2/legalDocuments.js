/**
 * The document versions currently in force.
 *
 * These must match the `Version` line of the corresponding file in the Unity
 * repository under Assets/Legal. The client sends the version it actually
 * displayed; this list is what decides whether an account still owes an
 * acceptance. Bump both together or the app will ask people to re-accept text
 * that has not changed - or worse, will not ask when it has.
 */
export const CURRENT_DOCUMENT_VERSIONS = {
  terms: process.env.LEGAL_TERMS_VERSION || "2026-09-06",
  privacy: process.env.LEGAL_PRIVACY_VERSION || "2026-09-06",
  camera: process.env.LEGAL_CAMERA_VERSION || "2026-09-06",
  age_attestation: process.env.LEGAL_AGE_VERSION || "2026-09-06",
};

export const DOCUMENTS = Object.keys(CURRENT_DOCUMENT_VERSIONS);

/**
 * Acceptances required before the application may be used at all. The camera
 * notice is deliberately absent: it gates the camera, not the account, so
 * somebody who declines it can still sign in, manage their subscription and
 * cancel.
 */
export const REQUIRED_TO_PROCEED = ["terms", "privacy", "age_attestation"];

/** Required before the camera may be opened. */
export const REQUIRED_FOR_CAMERA = "camera";
