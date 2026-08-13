import { z } from "zod";

export const orderEventSchema = z.object({
  orderId: z.string().min(1),
  customerName: z.string().min(1),
  event: z.discriminatedUnion("type", [
    z.object({ type: z.literal("checkout_confirmed"), total: z.number().nonnegative(), currency: z.string().length(3) }),
    z.object({ type: z.literal("fulfillment_started"), carrier: z.string().min(1) }),
    z.object({ type: z.literal("receipt_ready"), receiptNumber: z.string().min(1) })
  ])
});

export type OrderEvent = z.infer<typeof orderEventSchema>;

export type UpdatePlan = {
  subject: string;
  fact: string;
  nextStep: string;
};

export function planCustomerUpdate(input: OrderEvent): UpdatePlan {
  switch (input.event.type) {
    case "checkout_confirmed":
      return {
        subject: `Order ${input.orderId} is confirmed`,
        fact: `Payment was accepted for ${input.event.total.toFixed(2)} ${input.event.currency.toUpperCase()}.`,
        nextStep: "We will send another update when fulfillment starts."
      };
    case "fulfillment_started":
      return {
        subject: `Order ${input.orderId} is being fulfilled`,
        fact: `${input.event.carrier} is handling the shipment.`,
        nextStep: "Tracking details will follow when the parcel is scanned."
      };
    case "receipt_ready":
      return {
        subject: `Receipt ${input.event.receiptNumber} is ready`,
        fact: `The receipt for order ${input.orderId} has been issued.`,
        nextStep: "Keep this message with your order records."
      };
  }
}
