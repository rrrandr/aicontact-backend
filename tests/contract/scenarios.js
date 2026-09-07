/**
 * The v1 wire contract, expressed as an ordered request script.
 *
 * Bodies are shaped exactly as the released Unity client sends them: it
 * serializes its whole DTO, so fields it is not setting arrive as explicit
 * nulls rather than being absent (DatabaseManager.cs:135, UserData at :159).
 * That distinction is load-bearing - see userUpdate in the controller.
 */
const EMAIL = "Contract.User@Example.com";

module.exports = [
  {
    name: "register-new",
    method: "post",
    path: "/api/user/register",
    body: { email: EMAIL, password: "correct-horse-passphrase", subscription_date: null, terms_accepted: "false" },
  },
  {
    name: "register-duplicate",
    method: "post",
    path: "/api/user/register",
    body: { email: EMAIL, password: "correct-horse-passphrase", subscription_date: null, terms_accepted: "false" },
  },
  {
    name: "login-success",
    method: "post",
    path: "/api/user/login",
    body: { email: EMAIL, password: "correct-horse-passphrase" },
  },
  {
    name: "login-wrong-password",
    method: "post",
    path: "/api/user/login",
    body: { email: EMAIL, password: "not-the-password" },
  },
  {
    name: "login-unknown-email",
    method: "post",
    path: "/api/user/login",
    body: { email: "nobody@example.com", password: "correct-horse-passphrase" },
  },
  {
    name: "get-found",
    method: "get",
    path: `/api/user/${encodeURIComponent(EMAIL)}`,
  },
  {
    name: "get-not-found",
    method: "get",
    path: "/api/user/nobody%40example.com",
  },
  {
    name: "update-subscription",
    method: "patch",
    path: "/api/user/update",
    body: { email: EMAIL, password: null, subscription_date: "01/02/2026 10:30:00", terms_accepted: null },
  },
  {
    name: "update-terms",
    method: "patch",
    path: "/api/user/update",
    body: { email: EMAIL, password: null, subscription_date: null, terms_accepted: "true" },
  },
  {
    name: "update-not-found",
    method: "patch",
    path: "/api/user/update",
    body: { email: "nobody@example.com", password: null, subscription_date: null, terms_accepted: "true" },
  },
];

module.exports.EMAIL = EMAIL;
