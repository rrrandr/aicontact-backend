import mongoose from "mongoose";

/**
 * One row per message we owe a customer, and the record that it was sent.
 *
 * The row is written before the send is attempted, and the unique index is the
 * thing that makes delivery once-only: a retry, a second process, a redelivered
 * webhook and a restart all compute the same key and collide on the same row
 * rather than sending a second copy. Nobody should receive two confirmations
 * because PayPal repeated an event.
 *
 * A message that could not be sent is kept as `pending`, not discarded. These
 * are not marketing: an enrollment confirmation that silently failed is a
 * compliance gap, so the failure has to stay visible and be retried.
 *
 * Holds no message body. The text is regenerated from live data at send time,
 * so this table is a delivery ledger and not a second copy of the customer's
 * personal data.
 */
const customerMessageSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: "user", index: true },
  // Kept so the ledger survives account deletion the way the financial records
  // do: proof that a required notice was sent must outlive the account it was
  // sent about.
  subject_id: { type: String, index: true },

  kind: { type: String, required: true },

  // What makes this message unique within its kind - a subscription id for an
  // enrollment confirmation, an anniversary year for a renewal reminder, a
  // document version for a terms change.
  key: { type: String, required: true },

  status: {
    type: String,
    enum: ["pending", "sent", "failed"],
    default: "pending",
    index: true,
  },
  attempts: { type: Number, default: 0 },
  last_error: String,
  created_at: { type: Date, default: Date.now },
  sent_at: Date,
});

customerMessageSchema.index({ kind: 1, key: 1 }, { unique: true });

export const CustomerMessage = mongoose.model("customer_message", customerMessageSchema);

/**
 * The messages we send. Each one exists because something requires it, and the
 * comment says what - a list of message types with no stated reason is how a
 * transactional sender turns into a marketing list.
 */
export const MessageKind = {
  // A retainable record of what was agreed, sent once the subscription goes
  // live. New York's automatic-renewal law requires the subscriber to be given
  // the offer terms in a form they can keep.
  enrollment: "enrollment_confirmation",

  // California requires a periodic reminder for a continuing subscription.
  // Sent to every subscriber rather than only to those the statute reaches:
  // deciding who is Californian would mean collecting location data we do not
  // collect, and the reminder is not unwelcome to anyone.
  annualReminder: "annual_renewal_reminder",

  // Advance notice of a price change, which the Terms promise and which New
  // York regulates.
  priceChange: "price_change_notice",

  // Advance notice of a material change to the Terms, which the Terms promise.
  termsChange: "terms_change_notice",
};

export const MESSAGE_KINDS = Object.values(MessageKind);
