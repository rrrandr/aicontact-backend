import request from "supertest";
import { createApp } from "../../src/app";
import { resetThrottle } from "../../src/middlewears/throttle";

const scenarios = require("./scenarios.js");
const golden = require("../golden/v1-responses.json");

/**
 * Proves the hardening commit is non-breaking.
 *
 * The golden file was recorded by running the ORIGINAL implementation
 * (commit 0798a00) against the same request script - see the generator
 * referenced in README. Every response must match it, except for the
 * deviations enumerated below, each of which is justified and verified
 * harmless against the released client's actual read paths.
 */

// Only these differences are permitted. Anything else fails.
const DEVIATIONS = {
  // The password hash was returned by register, get and update. No client code
  // path reads UserData.password from a response; it is only ever written
  // outbound (DatabaseManager.cs:70, 135).
  passwordRemoved: ["register-new", "get-found", "update-subscription", "update-terms"],

  // Registration now whitelists its input, so subscription_date takes the
  // schema default "" instead of storing the explicit null the client sends.
  // That stored value then surfaces on every read until a real subscription
  // date is written, hence three scenarios rather than one. The client tests
  // this field with string.IsNullOrEmpty (InAppPurchaseScreenHandler.cs:133,
  // 272 and OnRestoreButtonClick), which treats null and "" identically.
  subscriptionDateNullToEmpty: ["register-new", "login-success", "get-found"],
};

const normalize = (value) => {
  const clone = JSON.parse(JSON.stringify(value));
  if (clone && clone.body && clone.body.user && clone.body.user._id) {
    clone.body.user._id = "<id>";
  }
  return clone;
};

describe("v1 wire contract", () => {
  let app;

  beforeAll(() => {
    resetThrottle();
    app = createApp();
  });

  it("covers every recorded scenario", () => {
    expect(scenarios.map((s) => s.name).sort()).toEqual(
      Object.keys(golden).sort()
    );
  });

  // Ordered: later scenarios depend on state created by earlier ones.
  it("reproduces the original responses", async () => {
    for (const scenario of scenarios) {
      const expected = normalize(golden[scenario.name]);

      let req = request(app)[scenario.method](scenario.path);
      if (scenario.body) req = req.send(scenario.body);
      const res = await req;

      const actual = normalize({ status: res.status, body: res.body });

      expect({ [scenario.name]: actual.status }).toEqual({
        [scenario.name]: expected.status,
      });

      if (DEVIATIONS.passwordRemoved.includes(scenario.name)) {
        expect(expected.body.user).toHaveProperty("password");
        expect(actual.body.user).not.toHaveProperty("password");
        delete expected.body.user.password;
      }

      if (DEVIATIONS.subscriptionDateNullToEmpty.includes(scenario.name)) {
        expect(expected.body.user.subscription_date).toBeNull();
        expect(actual.body.user.subscription_date).toBe("");
        expected.body.user.subscription_date = "";
      }

      expect({ [scenario.name]: actual.body }).toEqual({
        [scenario.name]: expected.body,
      });
    }
  });

  it("never returns a password hash on any endpoint", async () => {
    const responses = [];
    for (const scenario of scenarios) {
      let req = request(app)[scenario.method](scenario.path);
      if (scenario.body) req = req.send(scenario.body);
      responses.push(await req);
    }
    for (const res of responses) {
      expect(JSON.stringify(res.body)).not.toMatch(/\$2[aby]\$/);
      if (res.body && res.body.user) {
        expect(res.body.user).not.toHaveProperty("password");
      }
    }
  });
});
