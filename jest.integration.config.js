/**
 * Sandbox integration only. `npm test` uses jest.config.js, whose testMatch
 * covers tests/ alone, so nothing here is ever picked up by an ordinary run.
 */
module.exports = {
  testEnvironment: "node",
  testMatch: ["**/integration/**/*.test.js"],
  // Real network calls plus a browser step in between.
  testTimeout: 120000,
  setupFilesAfterEnv: ["<rootDir>/integration/setup.js"],
  maxWorkers: 1,
};
