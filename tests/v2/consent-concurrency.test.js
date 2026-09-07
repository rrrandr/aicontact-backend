import request from "supertest";
import { createApp } from "../../src/app";
import { User } from "../../src/models/user";
import { ConsentRecord } from "../../src/models/consentRecord";
import { CURRENT_DOCUMENT_VERSIONS } from "../../src/v2/legalDocuments";

const PASSWORD = "a-sufficiently-long-password";
const V = CURRENT_DOCUMENT_VERSIONS;

/**
 * Concurrent acceptance of the same document.
 *
 * A client that retries, or a person clicking twice, can put several identical
 * submissions in flight at once. They all land on the same unique
 * (user, document, version) key, and an upsert race there can raise a
 * duplicate-key error - which would surface as a 500 on a request that
 * actually succeeded.
 *
 * Written while hunting an intermittent suite failure. It did not reproduce
 * the failure, but the hazard is real on storage engines that surface the
 * race, so the handler now treats a duplicate as the success it is.
 */
describe("concurrent consent writes", () => {
  const app = createApp();

  it("never answers a duplicate submission with a server error", async () => {
    const codes = [];

    for (let round = 0; round < 25; round++) {
      const email = `race-${round}@example.com`;
      const tokens = (
        await request(app).post("/api/v2/auth/register").send({ email, password: PASSWORD })
      ).body;

      const submit = () =>
        request(app)
          .post("/api/v2/me/consent")
          .set("Authorization", `Bearer ${tokens.access_token}`)
          .send({ documents: [{ document: "terms", version: V.terms }] });

      const results = await Promise.all([submit(), submit(), submit(), submit(), submit()]);
      for (const r of results) codes.push(r.status);

      const user = await User.findOne({ email_norm: email });
      expect(await ConsentRecord.countDocuments({ user_id: user._id, document: "terms" })).toBe(1);
    }

    const bad = codes.filter((c) => c !== 200);
    expect({ nonOk: bad.length, sample: bad.slice(0, 5) }).toEqual({ nonOk: 0, sample: [] });
  });
});
