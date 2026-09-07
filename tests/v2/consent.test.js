import request from "supertest";
import mongoose from "mongoose";
import { createApp } from "../../src/app";
import { User } from "../../src/models/user";
import { ConsentRecord } from "../../src/models/consentRecord";
import { CURRENT_DOCUMENT_VERSIONS } from "../../src/v2/legalDocuments";

const PASSWORD = "a-sufficiently-long-password";
const V = CURRENT_DOCUMENT_VERSIONS;

const AGE_STATEMENT = "I confirm that I am at least 18 years old";

describe("recording what a person actually agreed to", () => {
  const app = createApp();

  const register = async (email) =>
    (await request(app).post("/api/v2/auth/register").send({ email, password: PASSWORD })).body;

  const post = (tokens, body) =>
    request(app)
      .post("/api/v2/me/consent")
      .set("Authorization", `Bearer ${tokens.access_token}`)
      .send(body);

  const acceptEverything = (tokens) =>
    post(tokens, {
      documents: [
        { document: "terms", version: V.terms },
        { document: "privacy", version: V.privacy },
        { document: "age_attestation", version: V.age_attestation, statement: AGE_STATEMENT },
        { document: "camera", version: V.camera },
      ],
      client_version: "1.0.1",
    });

  describe("a new account owes every document", () => {
    it("says so on /me before anything is accepted", async () => {
      const tokens = await register("consent-new@example.com");

      const me = await request(app)
        .get("/api/v2/me")
        .set("Authorization", `Bearer ${tokens.access_token}`);

      const owed = me.body.required_consents.map((c) => c.document).sort();
      expect(owed).toEqual(["age_attestation", "camera", "privacy", "terms"]);
    });

    it("marks which ones block use and which one blocks only the camera", async () => {
      const tokens = await register("consent-gates@example.com");
      const me = await request(app)
        .get("/api/v2/me")
        .set("Authorization", `Bearer ${tokens.access_token}`);

      const byName = Object.fromEntries(
        me.body.required_consents.map((c) => [c.document, c])
      );

      // Declining the camera notice must not lock someone out of their own
      // account, their subscription or their ability to cancel.
      expect(byName.terms.blocks_use).toBe(true);
      expect(byName.privacy.blocks_use).toBe(true);
      expect(byName.age_attestation.blocks_use).toBe(true);
      expect(byName.camera.blocks_use).toBe(false);
      expect(byName.camera.blocks_camera).toBe(true);
    });
  });

  describe("accepting", () => {
    it("records the document, the version and the time", async () => {
      const tokens = await register("consent-record@example.com");
      const before = Date.now();

      const res = await acceptEverything(tokens);
      expect(res.status).toBe(200);
      expect(res.body.required_consents).toEqual([]);

      const user = await User.findOne({ email_norm: "consent-record@example.com" });
      const rows = await ConsentRecord.find({ user_id: user._id });

      expect(rows).toHaveLength(4);
      for (const row of rows) {
        expect(row.version).toBe(V[row.document]);
        expect(row.accepted_at.getTime()).toBeGreaterThanOrEqual(before - 1000);
        expect(row.subject_id).toBe(user.subject_id);
      }
    });

    it("keeps the exact wording of the age attestation", async () => {
      // A record that someone ticked a box is worth little without the box.
      const tokens = await register("consent-wording@example.com");
      await acceptEverything(tokens);

      const user = await User.findOne({ email_norm: "consent-wording@example.com" });
      const age = await ConsentRecord.findOne({
        user_id: user._id,
        document: "age_attestation",
      });

      expect(age.statement).toBe(AGE_STATEMENT);
    });

    it("records the client version and platform when the app sends them", async () => {
      const tokens = await register("consent-client@example.com");
      await post(tokens, {
        documents: [{ document: "terms", version: V.terms, platform: "macOS", client_version: "1.0.1" }],
      });

      const user = await User.findOne({ email_norm: "consent-client@example.com" });
      const row = await ConsentRecord.findOne({ user_id: user._id, document: "terms" });
      expect(row.platform).toBe("macOS");
      expect(row.client_version).toBe("1.0.1");
    });

    it("keeps the legacy terms_accepted field in step for released v1 clients", async () => {
      const tokens = await register("consent-legacy@example.com");
      await acceptEverything(tokens);

      const user = await User.findOne({ email_norm: "consent-legacy@example.com" });
      expect(user.terms_accepted).toBe("true");
      expect(user.terms_accepted_at).toBeTruthy();
    });
  });

  describe("submitting the same acceptance twice", () => {
    it("succeeds both times and records it once", async () => {
      const tokens = await register("consent-twice@example.com");

      const first = await acceptEverything(tokens);
      const second = await acceptEverything(tokens);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);

      const user = await User.findOne({ email_norm: "consent-twice@example.com" });
      expect(await ConsentRecord.countDocuments({ user_id: user._id })).toBe(4);
    });

    it("does not move the original timestamp", async () => {
      // A retry after a dropped reply is the same fact, not a later one.
      const tokens = await register("consent-timestamp@example.com");
      await acceptEverything(tokens);

      const user = await User.findOne({ email_norm: "consent-timestamp@example.com" });
      const original = (await ConsentRecord.findOne({ user_id: user._id, document: "terms" }))
        .accepted_at.getTime();

      await new Promise((resolve) => setTimeout(resolve, 20));
      await acceptEverything(tokens);

      const after = (await ConsentRecord.findOne({ user_id: user._id, document: "terms" }))
        .accepted_at.getTime();
      expect(after).toBe(original);
    });

    it("survives several submissions racing each other", async () => {
      const tokens = await register("consent-race@example.com");
      await Promise.all([acceptEverything(tokens), acceptEverything(tokens), acceptEverything(tokens)]);

      const user = await User.findOne({ email_norm: "consent-race@example.com" });
      expect(await ConsentRecord.countDocuments({ user_id: user._id })).toBe(4);
    });
  });

  describe("versions", () => {
    it("refuses an acceptance of a version we no longer publish", async () => {
      // Accepting old text is not accepting what is on screen now.
      const tokens = await register("consent-stale@example.com");

      const res = await post(tokens, {
        documents: [{ document: "terms", version: "2024-02-18" }],
      });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("stale_document_version");
      expect(res.body.current_version).toBe(V.terms);
    });

    it("asks again when the accepted version is not the current one", async () => {
      // What a version bump looks like from the account's side: a record
      // exists, but for text we no longer publish, so the document is owed.
      const tokens = await register("consent-bump@example.com");
      await acceptEverything(tokens);

      const user = await User.findOne({ email_norm: "consent-bump@example.com" });
      await ConsentRecord.updateOne(
        { user_id: user._id, document: "terms" },
        { $set: { version: "2024-02-18" } }
      );

      const me = await request(app)
        .get("/api/v2/me")
        .set("Authorization", `Bearer ${tokens.access_token}`);

      const owed = me.body.required_consents.map((c) => c.document);
      expect(owed).toEqual(["terms"]);
      expect(me.body.required_consents[0].version).toBe(V.terms);
    });

    it("rejects a document it does not publish at all", async () => {
      const tokens = await register("consent-unknown@example.com");
      const res = await post(tokens, {
        documents: [{ document: "cookie_policy", version: V.terms }],
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("unknown_document");
    });

    it("rejects an empty submission rather than reporting success", async () => {
      const tokens = await register("consent-empty@example.com");
      expect((await post(tokens, { documents: [] })).status).toBe(400);
      expect((await post(tokens, {})).status).toBe(400);
    });
  });

  describe("withdrawing the camera acknowledgement", () => {
    const withdraw = (tokens, document) =>
      request(app)
        .post("/api/v2/me/consent/withdraw")
        .set("Authorization", `Bearer ${tokens.access_token}`)
        .send({ document });

    it("puts the camera back on the required list", async () => {
      const tokens = await register("consent-withdraw@example.com");
      await acceptEverything(tokens);

      const res = await withdraw(tokens, "camera");

      expect(res.status).toBe(200);
      const owed = res.body.required_consents.map((c) => c.document);
      expect(owed).toEqual(["camera"]);
    });

    it("keeps the record rather than deleting it", async () => {
      // That someone consented and then stopped is itself the record.
      const tokens = await register("consent-withdraw-keep@example.com");
      await acceptEverything(tokens);
      await withdraw(tokens, "camera");

      const user = await User.findOne({ email_norm: "consent-withdraw-keep@example.com" });
      const row = await ConsentRecord.findOne({ user_id: user._id, document: "camera" });
      expect(row).toBeTruthy();
      expect(row.withdrawn_at).toBeTruthy();
    });

    it("leaves the account usable", async () => {
      const tokens = await register("consent-withdraw-account@example.com");
      await acceptEverything(tokens);
      await withdraw(tokens, "camera");

      const me = await request(app)
        .get("/api/v2/me")
        .set("Authorization", `Bearer ${tokens.access_token}`);

      expect(me.status).toBe(200);
      expect(me.body.required_consents.every((c) => c.blocks_use === false)).toBe(true);
    });

    it("can be given again after being withdrawn", async () => {
      const tokens = await register("consent-regrant@example.com");
      await acceptEverything(tokens);
      await withdraw(tokens, "camera");

      const again = await post(tokens, {
        documents: [{ document: "camera", version: V.camera }],
      });

      expect(again.status).toBe(200);
      expect(again.body.required_consents).toEqual([]);
    });

    it("refuses to withdraw the terms, which is what deletion is for", async () => {
      const tokens = await register("consent-withdraw-terms@example.com");
      await acceptEverything(tokens);

      const res = await withdraw(tokens, "terms");
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("not_withdrawable");
    });
  });

  describe("scope", () => {
    it("requires a session", async () => {
      const res = await request(app).post("/api/v2/me/consent").send({
        documents: [{ document: "terms", version: V.terms }],
      });
      expect(res.status).toBe(401);
    });

    it("records against the caller and nobody else", async () => {
      const mine = await register("consent-mine@example.com");
      await register("consent-theirs@example.com");

      await acceptEverything(mine);

      const other = await User.findOne({ email_norm: "consent-theirs@example.com" });
      expect(await ConsentRecord.countDocuments({ user_id: other._id })).toBe(0);
    });
  });

  describe("what a consent record does not contain", () => {
    it("holds no network origin of any kind", async () => {
      const tokens = await register("consent-noip@example.com");
      await acceptEverything(tokens);

      const user = await User.findOne({ email_norm: "consent-noip@example.com" });
      const raw = await mongoose.connection
        .collection("consent_records")
        .findOne({ user_id: user._id });

      for (const field of ["ip", "ip_hash", "user_agent", "userAgent", "remote_addr"]) {
        expect(raw[field]).toBeUndefined();
      }
    });
  });
});
