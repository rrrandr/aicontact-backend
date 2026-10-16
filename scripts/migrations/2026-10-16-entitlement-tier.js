/**
 * Backfills entitlements.tier on rows written before tiers existed.
 *
 * WHAT QUALIFIES, and nothing else: a row with NO tier field at all whose
 * status is active or grace. Those are the rows the client already reads as
 * paid under the legacy rule - absent tier on an ACTIVE row means paid -
 * so writing "paid" into them records what is already true and changes no
 * access.
 *
 * Inactive rows are deliberately left alone. An expired row with no tier is a
 * subscription that ended, and stamping "paid" onto it would assert something
 * nobody established. It resolves to nothing either way, so there is no reason
 * to write.
 *
 * EXPLICIT VALUES ARE NEVER TOUCHED. The filter is `tier: { $exists: false }`,
 * so a row that already says "paid" or "free" is not a candidate and cannot be
 * overwritten by a re-run.
 *
 * REPEATABLE. Running it twice is a no-op, because the first run removes its
 * own candidates from the filter.
 *
 * ROLLBACK IS LIMITED TO WHAT THIS WROTE. Applying records the ids it changed
 * to a journal file; rollback unsets tier on exactly those ids and nothing
 * else. Without the journal it refuses to run rather than guessing, because
 * "unset every tier that says paid" would strip rows this never touched.
 *
 *   node scripts/migrations/2026-10-16-entitlement-tier.js
 *     → report only, writes nothing
 *   node scripts/migrations/2026-10-16-entitlement-tier.js --apply
 *     → writes, and records a journal beside this file
 *   node scripts/migrations/2026-10-16-entitlement-tier.js --rollback
 *     → unsets tier on exactly the ids in that journal
 *
 * Intended for a disposable database first. It is not run against anything
 * deployed from here.
 */
import fs from "fs";
import path from "path";
import { Entitlement, ACTIVE_STATUSES } from "../../src/models/entitlement";
import { connectDB, disconnectDB } from "../../src/util/db";

const apply = process.argv.includes("--apply");
const rollback = process.argv.includes("--rollback");

export const JOURNAL = path.join(
  process.env.ENTITLEMENT_TIER_JOURNAL_DIR || __dirname,
  "2026-10-16-entitlement-tier.journal.json"
);

/** Rows this migration may write to: no tier at all, and currently active. */
export const candidateFilter = () => ({
  tier: { $exists: false },
  status: { $in: ACTIVE_STATUSES },
});

export const findCandidates = async () =>
  Entitlement.find(candidateFilter()).select("_id status platform").lean();

export const applyBackfill = async ({ journalPath = JOURNAL } = {}) => {
  const candidates = await findCandidates();
  const ids = candidates.map((row) => String(row._id));

  if (ids.length === 0) return { written: 0, ids: [] };

  await Entitlement.updateMany(candidateFilter(), { $set: { tier: "paid" } });

  // Written AFTER the update so a journal never claims more than was done.
  // Appending to any existing journal keeps earlier runs recoverable too.
  const previous = readJournal(journalPath);
  writeJournal(journalPath, Array.from(new Set([...previous, ...ids])));

  return { written: ids.length, ids };
};

export const rollbackBackfill = async ({ journalPath = JOURNAL } = {}) => {
  const ids = readJournal(journalPath);

  if (ids.length === 0) {
    throw new Error(
      `No journal at ${journalPath}. Refusing to roll back: without it there is ` +
        "no record of which rows this migration wrote, and unsetting every tier " +
        "that reads \"paid\" would strip rows it never touched."
    );
  }

  const result = await Entitlement.updateMany(
    { _id: { $in: ids } },
    { $unset: { tier: 1 } }
  );

  return { reverted: result.modifiedCount ?? 0, ids };
};

const readJournal = (journalPath) => {
  try {
    const raw = fs.readFileSync(journalPath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.ids) ? parsed.ids : [];
  } catch {
    return [];
  }
};

const writeJournal = (journalPath, ids) => {
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  fs.writeFileSync(
    journalPath,
    JSON.stringify({ written_at: new Date().toISOString(), ids }, null, 2)
  );
};

const run = async () => {
  await connectDB();
  try {
    if (rollback) {
      const { reverted } = await rollbackBackfill();
      console.log(`rolled back ${reverted} row(s)`);
      return;
    }

    const candidates = await findCandidates();
    console.log(`${candidates.length} row(s) qualify: no tier field, status active or grace`);

    if (!apply) {
      console.log("report only - pass --apply to write");
      return;
    }

    const { written } = await applyBackfill();
    console.log(`wrote tier=paid to ${written} row(s); journal at ${JOURNAL}`);
  } finally {
    await disconnectDB();
  }
};

// Only when invoked directly, so the functions above can be imported by tests
// without the script connecting to anything.
if (process.argv[1] && process.argv[1].includes("2026-10-16-entitlement-tier")) {
  run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
