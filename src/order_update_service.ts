import express from "express";
import { ZodError } from "zod";
import { writeCustomerUpdate } from "./customer_update_writer.js";
import { orderEventSchema, planCustomerUpdate } from "./order_event.js";

export const service = express();
service.use(express.json());

service.post("/orders/update", async (request, response) => {
  try {
    const orderEvent = orderEventSchema.parse(request.body);
    const plan = planCustomerUpdate(orderEvent);
    const message = await writeCustomerUpdate(orderEvent, plan);
    response.status(200).json({ orderId: orderEvent.orderId, state: orderEvent.event.type, subject: plan.subject, message });
  } catch (error) {
    if (error instanceof ZodError) {
      response.status(400).json({ error: "Invalid order event", details: error.flatten() });
      return;
    }
    const detail = error instanceof Error ? error.message : "Unable to create customer update";
    response.status(502).json({ error: detail });
  }
});

if (process.env.NODE_ENV !== "test") {
  const port = Number(process.env.PORT ?? 3000);
  service.listen(port, () => console.log(`Order update service listening on http://localhost:${port}`));
}
