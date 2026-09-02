/**
 * Populates users.email_norm for rows created before it existed.
 *
 * Additive and idempotent: the stored `email` is never modified, so this can
 * be re-run safely and rolling the code back needs no data restore.
 *
 * It reports collisions rather than merging them. Two accounts differing only
 * in case are a product decision, not something a migration should silently
 * resolve.
 *
 *   npm run backfill:email-norm            # report only
 *   npm run backfill:email-norm -- --apply # write
 */
import mongoose from "mongoose";
import { User } from "../src/models/user";
import { connectDB, disconnectDB } from "../src/util/db";
import { normalizeEmail } from "../src/util/email";

const apply = process.argv.includes("--apply");

const run = async () => {
  await connectDB();

  const cursor = User.find({ email_norm: { $in: [null, ""] } })
    .select("_id email email_norm")
    .cursor();

  const seen = new Map();
  const collisions = [];
  let scanned = 0;
  let updated = 0;

  for await (const doc of cursor) {
    scanned += 1;
    const norm = normalizeEmail(doc.email);
    if (!norm) continue;

    if (seen.has(norm)) {
      collisions.push({ norm, ids: [seen.get(norm), String(doc._id)] });
      continue;
    }
    seen.set(norm, String(doc._id));

    if (apply) {
      await User.updateOne({ _id: doc._id }, { $set: { email_norm: norm } });
      updated += 1;
    }
  }

  const existing = await User.countDocuments({
    email_norm: { $nin: [null, ""] },
  });

  console.log(
    JSON.stringify(
      {
        mode: apply ? "apply" : "report",
        scanned,
        updated,
        already_normalized: existing,
        collisions: collisions.length,
        collision_detail: collisions.slice(0, 50),
      },
      null,
      2
    )
  );

  if (collisions.length) {
    console.error(
      `\n${collisions.length} case-collision(s) left untouched. Resolve these before relying on normalized lookup.`
    );
  }

  await disconnectDB();
  await mongoose.disconnect();
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
