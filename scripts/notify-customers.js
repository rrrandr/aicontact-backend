/* eslint-disable no-console */
import mongoose from "mongoose";
import readline from "readline";

import { User } from "../src/models/user";
import { PaypalSubscription } from "../src/models/paypalSubscription";
import { sendPriceChangeNotice, sendTermsChangeNotice } from "../src/v2/services/customerMail";
import { config } from "../src/config/env";

/**
 * Sends a price-change or terms-change notice to current subscribers.
 *
 * Deliberately a script a person runs, not a job. Both of these follow a
 * decision somebody made, and both carry wording somebody has to write; there
 * is no event to hang them on and nothing to be gained from a scheduler that
 * could fire one by accident.
 *
 * Safe by default:
 *   - prints who would receive it and stops, unless --send is passed;
 *   - refuses to send with less than 30 days' notice, because the Terms
 *     promise 30 and the check belongs somewhere it cannot be skipped;
 *   - asks for typed confirmation before sending;
 *   - is idempotent per recipient, so re-running after a crash finishes the
 *     job instead of mailing everyone twice.
 *
 * Examples:
 *   npx babel-node scripts/notify-customers.js price \
 *     --current "USD 6.00/month" --new "USD 7.00/month" \
 *     --effective 2026-11-01 --key 2026-11-increase
 *
 *   npx babel-node scripts/notify-customers.js terms \
 *     --version 2026-11-01.1 --effective 2026-12-05 \
 *     --summary "The arbitration section now allows claims under $500 in small claims court."
 */

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const flag = (name) => process.argv.includes(`--${name}`);

const confirm = (question) =>
  new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });

const recipients = async () => {
  const records = await PaypalSubscription.find({
    user_id: { $exists: true },
    cancelled_at: { $exists: false },
  });

  const out = [];
  for (const record of records) {
    const user = await User.findById(record.user_id);
    if (!user || user.status === "deleted") continue;
    out.push({ user, record });
  }
  return out;
};

const main = async () => {
  const kind = process.argv[2];

  if (kind !== "price" && kind !== "terms") {
    console.error("Usage: notify-customers.js <price|terms> [options]  (see the header)");
    process.exit(2);
  }

  const effective = arg("effective");
  if (!effective) {
    console.error("--effective YYYY-MM-DD is required.");
    process.exit(2);
  }

  await mongoose.connect(config.mongoUri);

  const targets = await recipients();

  console.log(`Provider:   ${config.mail.provider}`);
  console.log(`Kind:       ${kind}`);
  console.log(`Effective:  ${effective}`);
  console.log(`Recipients: ${targets.length} current subscriber(s)`);

  if (!flag("send")) {
    console.log("\nDry run. Nothing was sent. Add --send to send for real.");
    await mongoose.disconnect();
    return;
  }

  const answer = await confirm(
    `\nType the number of recipients (${targets.length}) to send for real: `
  );
  if (answer !== String(targets.length)) {
    console.log("Not confirmed. Nothing sent.");
    await mongoose.disconnect();
    return;
  }

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const { user, record } of targets) {
    try {
      const result =
        kind === "price"
          ? await sendPriceChangeNotice({
              user,
              subscriptionId: record.subscription_id,
              currentPrice: arg("current"),
              newPrice: arg("new"),
              effectiveAt: effective,
              key: arg("key", effective),
            })
          : await sendTermsChangeNotice({
              user,
              version: arg("version"),
              effectiveAt: effective,
              summary: arg("summary", ""),
            });

      if (result.sent) sent += 1;
      else if (result.duplicate) skipped += 1;
      else failed += 1;
    } catch (error) {
      // A notice-period violation throws on the first recipient and stops the
      // run, which is the point: it is a mistake in the command, not in one
      // person's record.
      console.error(`\n${error.message}`);
      process.exitCode = 1;
      break;
    }
  }

  console.log(`\nsent ${sent}, already sent ${skipped}, failed ${failed}`);
  await mongoose.disconnect();
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
