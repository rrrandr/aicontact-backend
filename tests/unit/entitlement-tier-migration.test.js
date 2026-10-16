/**
 * The tier backfill: what it may write, what it must not touch, and how far a
 * rollback reaches.
 *
 * Runs entirely against the in-memory database the suite already provides, so
 * nothing deployed is involved.
 */
import fs from "fs";
import os from "os";
import path from "path";
import mongoose from "mongoose";
import { Entitlement } from "../../src/models/entitlement";
import {
  applyBackfill,
  findCandidates,
  rollbackBackfill,
} from "../../scripts/migrations/2026-10-16-entitlement-tier";

let journalDir;
let journalPath;

const makeRow = async ({ status = "active", tier } = {}) => {
  const row = await Entitlement.create({
    user_id: new mongoose.Types.ObjectId(),
    subject_id: String(new mongoose.Types.ObjectId()),
    platform: "paypal",
    status,
    expires_at: new Date(Date.now() + 86400000),
    ...(tier ? { tier } : {}),
  });

  // The legacy shape has no tier field at all. The schema default would
  // otherwise write one, which is the state this migration exists to fix.
  if (!tier) {
    await Entitlement.collection.updateOne({ _id: row._id }, { $unset: { tier: 1 } });
  }

  return row;
};

const tierOf = async (id) => {
  const [row] = await Entitlement.collection.find({ _id: id }).toArray();
  return Object.prototype.hasOwnProperty.call(row, "tier") ? row.tier : undefined;
};

beforeEach(async () => {
  await Entitlement.deleteMany({});
  journalDir = fs.mkdtempSync(path.join(os.tmpdir(), "tier-journal-"));
  journalPath = path.join(journalDir, "journal.json");
});

afterEach(() => {
  fs.rmSync(journalDir, { recursive: true, force: true });
});

it("backfills only active rows that have no tier at all", async () => {
  const legacyActive = await makeRow({ status: "active" });
  const legacyExpired = await makeRow({ status: "expired" });

  const candidates = await findCandidates();
  expect(candidates.map((c) => String(c._id))).toEqual([String(legacyActive._id)]);

  await applyBackfill({ journalPath });

  expect(await tierOf(legacyActive._id)).toBe("paid");

  // An expired row with no tier is a subscription that ended. Stamping "paid"
  // onto it would assert something nobody established.
  expect(await tierOf(legacyExpired._id)).toBeUndefined();
});

it("never overwrites a tier that is already set", async () => {
  const explicitFree = await makeRow({ status: "active", tier: "free" });
  const explicitPaid = await makeRow({ status: "active", tier: "paid" });

  await applyBackfill({ journalPath });

  expect(await tierOf(explicitFree._id)).toBe("free");
  expect(await tierOf(explicitPaid._id)).toBe("paid");
});

it("is repeatable: a second run writes nothing", async () => {
  await makeRow({ status: "active" });

  const first = await applyBackfill({ journalPath });
  const second = await applyBackfill({ journalPath });

  expect(first.written).toBe(1);
  expect(second.written).toBe(0);
});

it("rolls back exactly the rows it wrote, and nothing else", async () => {
  const legacy = await makeRow({ status: "active" });
  const untouched = await makeRow({ status: "active", tier: "paid" });

  await applyBackfill({ journalPath });
  const { reverted } = await rollbackBackfill({ journalPath });

  expect(reverted).toBe(1);
  expect(await tierOf(legacy._id)).toBeUndefined();

  // Written by somebody else and never in the journal, so still there.
  expect(await tierOf(untouched._id)).toBe("paid");
});

it("refuses to roll back without a journal rather than guessing", async () => {
  await makeRow({ status: "active", tier: "paid" });

  await expect(
    rollbackBackfill({ journalPath: path.join(journalDir, "absent.json") })
  ).rejects.toThrow(/Refusing to roll back/);
});
