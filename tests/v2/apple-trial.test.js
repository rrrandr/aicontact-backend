import { subscriptionPhase } from "../../src/v2/services/appleService";
import {
  buildSubscriptionView,
  APPLE_MANAGE_URL,
  PAYPAL_AUTOPAY_URL,
} from "../../src/v2/controllers/subscriptionController";

const DAY = 24 * 60 * 60 * 1000;
const future = () => new Date(Date.now() + 10 * DAY);

/**
 * The App Store edition sells a two-week free trial, which is a different offer
 * from the direct build's thirteen days. What matters here is not the length -
 * Apple owns that - but that we can tell a trial from a paid period, because a
 * trial mistaken for a paid period gets its access preserved on cancellation
 * and hands somebody time they never paid for.
 */
describe("Apple trial phase", () => {
  it("reads a free trial from Apple's offer fields, not from dates", () => {
    expect(subscriptionPhase({ offerType: 1, offerDiscountType: "FREE_TRIAL" })).toBe("trial");
  });

  it("treats a discounted introductory offer as paid, because money changed hands", () => {
    expect(subscriptionPhase({ offerType: 1, offerDiscountType: "PAY_AS_YOU_GO" })).toBe("paid");
    expect(subscriptionPhase({ offerType: 1, offerDiscountType: "PAY_UP_FRONT" })).toBe("paid");
  });

  it("treats an older introductory transaction as a trial", () => {
    // offerDiscountType postdates offerType. On this product the only
    // introductory offer that has ever existed is the free trial, so the
    // absence of the newer field is not a reason to call it unknown.
    expect(subscriptionPhase({ offerType: 1 })).toBe("trial");
  });

  it("is paid once the introductory offer is over", () => {
    expect(subscriptionPhase({ offerType: 0 })).toBe("paid");
  });

  it("says unknown rather than guessing when Apple tells us nothing", () => {
    expect(subscriptionPhase({})).toBe("unknown");
    expect(subscriptionPhase(null)).toBe("unknown");
  });
});

describe("what the Manage Subscription screen shows an App Store subscriber", () => {
  const appleEntitlement = (over = {}) => ({
    platform: "apple",
    // Required: isActive re-checks the environment on every read, so an
    // entitlement with none is treated as not granting access.
    environment: "Production",
    status: "active",
    auto_renew: true,
    expires_at: future(),
    ...over,
  });

  it("shows the trial as a trial", () => {
    const view = buildSubscriptionView(appleEntitlement(), { phase: "trial" });

    expect(view.state).toBe("trialing");
    expect(view.phase).toBe("trial");
    expect(view.platform).toBe("apple");
  });

  it("never offers to cancel, because Apple does not permit it", () => {
    // The failure this forbids: a Cancel button that cannot cancel. Apple only
    // lets the subscriber do it, from their own settings.
    const view = buildSubscriptionView(appleEntitlement(), { phase: "paid" });

    expect(view.can_cancel).toBe(false);
    expect(view.manage_url).toBe(APPLE_MANAGE_URL);
  });

  it("still refuses to offer cancellation once the trial has converted", () => {
    const view = buildSubscriptionView(appleEntitlement({ auto_renew: true }), {
      phase: "paid",
    });

    expect(view.can_cancel).toBe(false);
  });

  it("leaves the PayPal screen exactly as it was", () => {
    const view = buildSubscriptionView(
      { platform: "paypal", status: "active", auto_renew: true, expires_at: future() },
      { phase: "trial" }
    );

    expect(view.state).toBe("trialing");
    expect(view.can_cancel).toBe(true);
    expect(view.manage_url).toBe(PAYPAL_AUTOPAY_URL);
  });
});
