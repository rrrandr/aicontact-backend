module.exports = {
  testEnvironment: "node",
  testMatch: ["**/tests/**/*.test.js"],
  testTimeout: 60000,
  setupFilesAfterEnv: ["<rootDir>/tests/setup.js"],
};
