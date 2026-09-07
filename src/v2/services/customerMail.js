import { CustomerMessage, MessageKind } from "../../models/customerMessage";
import { sendMail } from "./mailService";
import { getPlan, planOfferTerms } from "./paypalService";
import { User } from "../../models/user";
import { PaypalSubscription } from "../../models/paypalSubscription";
import { config } from "../../config/env";
import { logger } from "../../util/logger";

/**
 * Transactional mail to customers.
 *
 * Every message here exists because something requires it: a retainable record
 * of what was agreed, a periodic reminder that a subscription is still
 * running, advance notice before a price or a contract term changes. There is
 * no announcement path and no marketing path, and there is deliberately no way
 * to send arbitrary text to a list from here.
 *
 * Separate from the owner's weekly tally, which goes to an SNS topic and must
 * never carry customer mail. Nothing in this file can reach that topic.
 */

const PAYPAL_AUTOPAY_URL = "https://www.paypal.com/myaccount/autopay/";
const MAX_ATTEMPTS = 8;

const SIGN_OFF = `
You are receiving this because you have an AICONTACT subscription. We only
send messages we are required to send or that you asked for; there is no
marketing list to unsubscribe from.

FaceStream Corporation, 1544 Ocean Parkway, 3D, Brooklyn, NY 11230, USA
contact@aicontact.ai`;

const dateLine = (value) =>
  value
    ? new Date(value).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: "UTC",
      })
    : null;

const money = (terms) => `${terms.currency} ${terms.amount}`;

const every = (unit, count) => (count === 1 ? unit : `${count} ${unit}s`);

/**
 * Sends one message, once.
 *
 * The ledger row is claimed before the send, so two processes racing on the
 * same message resolve at the unique index rather than in the customer's
 * inbox. A send that throws leaves the row `pending` with the error recorded,
 * which is what the retry job looks for - a failed required notice is a
 * compliance gap, not something to swallow.
 */
export const deliver = async ({ user, kind, key, subject, text }) => {
  let ledger;

  try {
    ledger = await CustomerMessage.create({
      user_id: user._id,
      subject_id: user.subject_id,
      kind,
      key,
    });
  } catch (error) {
    // Already claimed by an earlier attempt or another process. Not an error:
    // it is the mechanism working.
    if (error?.code === 11000) return { sent: false, duplicate: true };
    throw error;
  }

  return attempt(ledger, user.email, subject, text);
};

const attempt = async (ledger, to, subject, text) => {
  try {
    await sendMail({ to, subject, text: `${text}\n${SIGN_OFF}\n` });

    ledger.status = "sent";
    ledger.sent_at = new Date();
    ledger.attempts += 1;
    ledger.last_error = undefined;
    await ledger.save();

    logger.info("customer message sent", { kind: ledger.kind });
    return { sent: true };
  } catch (error) {
    ledger.attempts += 1;
    ledger.last_error = String(error.message).slice(0, 500);
    ledger.status = ledger.attempts >= MAX_ATTEMPTS ? "failed" : "pending";
    await ledger.save();

    logger.error("customer message not delivered", {
      kind: ledger.kind,
      attempts: ledger.attempts,
      error: ledger.last_error,
    });
    return { sent: false, error: ledger.last_error };
  }
};

/**
 * The retainable confirmation, sent once per subscription when it goes live.
 *
 * Quotes the plan as PayPal holds it. If the plan cannot be read the message
 * is not sent at all and no ledger row is claimed, so the next attempt will
 * send it properly rather than this one sending a confirmation with the price
 * missing.
 */
const enrollmentText = async ({ planId, record }) => {
  const plan = planId ? await getPlan(planId) : null;
  const terms = planOfferTerms(plan);

  if (!terms) {
    logger.warn("enrollment confirmation deferred - plan terms unavailable", { planId });
    return null;
  }

  const renews = dateLine(record?.next_billing_time);
  const trial =
    terms.trialCount > 0
      ? `Your free trial: ${every(terms.trialUnit, terms.trialCount)} at no charge.\n`
      : "";

  const text = `Your AICONTACT subscription is active. Please keep this message: it is the
record of what you agreed to.

${trial}What you pay:   ${money(terms)} every ${every(terms.intervalUnit, terms.intervalCount)}.
Renews:         automatically, until you cancel.${
    renews ? `\nNext charge:    ${renews}.` : ""
  }
Paid through:   PayPal. We never see your card or bank details.

How to cancel. Open AICONTACT, go to Manage Subscription and press Cancel
Subscription. It takes effect immediately and you keep access until the end of
the period you have already paid for. You can also cancel the automatic payment
directly in PayPal at ${PAYPAL_AUTOPAY_URL}

If we ever change the price, we will email you at least 30 days beforehand and
the new price will only apply to renewals after that date.`;

  return { subject: "Your AICONTACT subscription - please keep this", body: text };
};

export const sendEnrollmentConfirmation = async ({ user, subscriptionId, planId, record }) => {
  const message = await enrollmentText({ planId, record });
  if (!message) return { sent: false, deferred: true };

  return deliver({
    user,
    kind: MessageKind.enrollment,
    key: subscriptionId,
    subject: message.subject,
    text: message.body,
  });
};

/**
 * The periodic reminder that a subscription is still running.
 *
 * Keyed by the anniversary year so it can be sent at most once per year no
 * matter how often the job runs.
 */
const reminderText = ({ record }) => {
  const renews = dateLine(record?.next_billing_time);

  const text = `This is your annual reminder that your AICONTACT subscription is still
running and still renewing automatically.${renews ? `\n\nNext charge: ${renews}.` : ""}

You do not need to do anything to continue. To stop it, open AICONTACT, go to
Manage Subscription and press Cancel Subscription; you keep access until the
end of the period you have already paid for. You can also cancel the automatic
payment directly in PayPal at ${PAYPAL_AUTOPAY_URL}

The current price and renewal date are shown on the Manage Subscription screen
at any time.`;

  return { subject: "Your AICONTACT subscription - annual reminder", body: text };
};

export const sendAnnualRenewalReminder = async ({ user, subscriptionId, year, record }) => {
  const message = reminderText({ record });

  return deliver({
    user,
    kind: MessageKind.annualReminder,
    key: `${subscriptionId}:${year}`,
    subject: message.subject,
    text: message.body,
  });
};

/**
 * Advance notice that the price is changing.
 *
 * Operator-triggered: there is no automatic path, because a price change is a
 * decision rather than an event. `effectiveAt` must be at least 30 days out -
 * the Terms promise that, so the caller is held to it here rather than trusted.
 */
export const NOTICE_DAYS = 30;

export const sendPriceChangeNotice = async ({
  user,
  subscriptionId,
  currentPrice,
  newPrice,
  effectiveAt,
  key,
}) => {
  const effective = new Date(effectiveAt);
  const daysAway = (effective.getTime() - Date.now()) / (24 * 60 * 60 * 1000);

  if (!Number.isFinite(daysAway) || daysAway < NOTICE_DAYS) {
    throw new Error(
      `A price change needs at least ${NOTICE_DAYS} days' notice; this one is ${Math.floor(daysAway)}.`
    );
  }

  const text = `We are changing the price of AICONTACT.

Now:            ${currentPrice}
From ${dateLine(effective)}: ${newPrice}

The new price applies only to renewals on or after that date. Everything you
have already paid for is unaffected.

If you do not want the new price, cancel before then and you will not be
charged it. Open AICONTACT, go to Manage Subscription and press Cancel
Subscription, or cancel the automatic payment in PayPal at
${PAYPAL_AUTOPAY_URL}

If you do nothing, your subscription continues at the new price.`;

  return deliver({
    user,
    kind: MessageKind.priceChange,
    key: `${subscriptionId}:${key}`,
    subject: "AICONTACT price change - 30 days' notice",
    text,
  });
};

/**
 * Advance notice of a material change to the Terms.
 *
 * The application will also show the new version and ask for acceptance; this
 * exists because the Terms promise email notice as well, and a promise in a
 * contract is not satisfied by an in-app prompt.
 */
export const sendTermsChangeNotice = async ({ user, version, effectiveAt, summary }) => {
  const effective = new Date(effectiveAt);
  const daysAway = (effective.getTime() - Date.now()) / (24 * 60 * 60 * 1000);

  if (!Number.isFinite(daysAway) || daysAway < NOTICE_DAYS) {
    throw new Error(
      `A terms change needs at least ${NOTICE_DAYS} days' notice; this one is ${Math.floor(daysAway)}.`
    );
  }

  const text = `We are changing the AICONTACT Terms of Service.

Version ${version} takes effect on ${dateLine(effective)}.

What is changing:
${summary}

AICONTACT will show you the new version and ask you to accept it. If you do not
want the new terms, you can cancel at any time from Manage Subscription and
keep access until the end of the period you have already paid for.

The full text is at ${config.legal.publicUrl}`;

  return deliver({
    user,
    kind: MessageKind.termsChange,
    key: version,
    subject: `AICONTACT Terms of Service changing on ${dateLine(effective)}`,
    text,
  });
};

/**
 * Retries messages that were claimed but never delivered.
 *
 * No message body is stored, so a retry regenerates the text from the row's
 * key. That only works for the kinds whose content is derivable from live
 * data - an enrollment confirmation and an annual reminder both are. A price
 * or terms change carries figures and wording that came from a person, so a
 * failed one is surfaced for a person to re-issue rather than guessed at here.
 */
export const REGENERABLE = new Set([MessageKind.enrollment, MessageKind.annualReminder]);

export const retryPendingMessages = async (limit = 25) => {
  const pending = await CustomerMessage.find({ status: "pending" })
    .sort({ created_at: 1 })
    .limit(limit);

  let sent = 0;
  let stillPending = 0;
  const needsAPerson = [];

  for (const row of pending) {
    if (!REGENERABLE.has(row.kind)) {
      needsAPerson.push({ kind: row.kind, key: row.key });
      continue;
    }

    const subscriptionId = row.key.split(":")[0];

    const [user, record] = await Promise.all([
      User.findById(row.user_id),
      PaypalSubscription.findOne({ subscription_id: subscriptionId }),
    ]);

    // The account is gone, or the subscription is. Nobody is owed this any
    // more, and it must not sit pending forever.
    if (!user || user.status === "deleted" || !record) {
      row.status = "failed";
      row.last_error = "no recipient";
      await row.save();
      continue;
    }

    const text =
      row.kind === MessageKind.enrollment
        ? await enrollmentText({ planId: record.plan_id, record })
        : reminderText({ record });

    if (!text) {
      stillPending += 1;
      continue;
    }

    const result = await attempt(row, user.email, text.subject, text.body);
    if (result.sent) sent += 1;
    else stillPending += 1;
  }

  if (needsAPerson.length > 0) {
    logger.warn("customer messages need re-issuing by hand", { messages: needsAPerson });
  }

  return { examined: pending.length, sent, pending: stillPending, needsAPerson };
};
