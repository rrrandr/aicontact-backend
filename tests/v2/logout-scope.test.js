import request from "supertest";
import { createApp } from "../../src/app";
import { User } from "../../src/models/user";
import { RefreshToken } from "../../src/models/refreshToken";

const PASSWORD = "a-sufficiently-long-password";

/**
 * How far a sign-out actually reaches.
 *
 * Worth pinning because it is easy to describe wrongly, and the client's own
 * documentation did describe it wrongly: logout revokes a token *family*, and
 * every login mints its own family, so it ends the session belonging to the
 * device that asked and nothing else. What ends every session is a password
 * reset or an account deletion, which revoke by account rather than by family.
 */
describe("what signing out reaches", () => {
  const app = createApp();

  const register = async (email) =>
    (await request(app).post("/api/v2/auth/register").send({ email, password: PASSWORD })).body;

  const login = async (email) =>
    (await request(app).post("/api/v2/auth/login").send({ email, password: PASSWORD })).body;

  const refresh = (token) =>
    request(app).post("/api/v2/auth/refresh").send({ refresh_token: token });

  const logout = (token) =>
    request(app).post("/api/v2/auth/logout").send({ refresh_token: token });

  it("gives each login its own token family", async () => {
    // The premise everything below rests on.
    const email = "families@example.com";
    const first = await register(email);
    const second = await login(email);

    const user = await User.findOne({ email_norm: email });
    const families = await RefreshToken.distinct("family_id", { user_id: user._id });

    expect(families).toHaveLength(2);
    expect(first.refresh_token).not.toBe(second.refresh_token);
  });

  it("signs out the device that asked, and only that one", async () => {
    const email = "two-devices@example.com";
    const laptop = await register(email);
    const desktop = await login(email);

    expect((await logout(laptop.refresh_token)).status).toBe(200);

    // The laptop is done.
    expect((await refresh(laptop.refresh_token)).status).toBe(401);

    // The desktop never noticed.
    const stillWorking = await refresh(desktop.refresh_token);
    expect(stillWorking.status).toBe(200);
    expect(stillWorking.body.refresh_token).toBeTruthy();
  });

  it("takes the whole lineage of that device, not just the token presented", async () => {
    // A device that has refreshed several times has a chain behind it. Logging
    // out has to kill the lineage, or the successor stays usable.
    const email = "lineage@example.com";
    const device = await register(email);

    const rotated = await refresh(device.refresh_token);
    expect(rotated.status).toBe(200);

    // Sign out presenting the ORIGINAL token, already consumed by the rotation.
    expect((await logout(device.refresh_token)).status).toBe(200);

    expect((await refresh(rotated.body.refresh_token)).status).toBe(401);
  });

  it("ends every session only when the account credential changes", async () => {
    // The contrast that makes the scope of logout clear.
    const email = "reset-all@example.com";
    const laptop = await register(email);
    const desktop = await login(email);

    const user = await User.findOne({ email_norm: email });
    const { revokeAllForUser } = require("../../src/v2/services/tokenService");
    await revokeAllForUser(user._id, "password-reset");

    expect((await refresh(laptop.refresh_token)).status).toBe(401);
    expect((await refresh(desktop.refresh_token)).status).toBe(401);
  });

  it("is content to be asked to sign out something that is already gone", async () => {
    const email = "twice@example.com";
    const device = await register(email);

    expect((await logout(device.refresh_token)).status).toBe(200);
    expect((await logout(device.refresh_token)).status).toBe(200);
    expect((await logout("not-a-real-token")).status).toBe(200);
  });
});
