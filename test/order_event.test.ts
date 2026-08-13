import { describe, expect, it } from "vitest";
import { orderEventSchema, planCustomerUpdate } from "../src/order_event.js";

describe("customer order update decision", () => {
  it("turns a fulfillment event into a shipping-specific next step", () => {
    const event = orderEventSchema.parse({
      orderId: "ord_2048",
      customerName: "Mina",
      event: { type: "fulfillment_started", carrier: "Parcel Post" }
    });

    expect(planCustomerUpdate(event)).toEqual({
      subject: "Order ord_2048 is being fulfilled",
      fact: "Parcel Post is handling the shipment.",
      nextStep: "Tracking details will follow when the parcel is scanned."
    });
  });
});
