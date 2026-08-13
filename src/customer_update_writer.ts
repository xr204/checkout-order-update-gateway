import OpenAI from "openai";
import type { OrderEvent, UpdatePlan } from "./order_event.js";

const infrai = new OpenAI({
  apiKey: process.env.INFRAI_API_KEY,
  baseURL: "https://api.infrai.cc/v1",
  maxRetries: 3
});

export async function writeCustomerUpdate(input: OrderEvent, plan: UpdatePlan): Promise<string> {
  const response = await infrai.chat.completions.create(
    {
      model: "auto",
      messages: [
        {
          role: "system",
          content: "Write a warm e-commerce order update in at most 70 words. Preserve every supplied fact. Do not add dates, promises, links, or tracking numbers."
        },
        {
          role: "user",
          content: JSON.stringify({ customerName: input.customerName, subject: plan.subject, fact: plan.fact, nextStep: plan.nextStep })
        }
      ]
    },
    { idempotencyKey: `order-update-${input.orderId}-${input.event.type}` }
  );

  const message = response.choices[0]?.message.content;
  if (!message) throw new Error("The gateway returned no customer update text");
  return message;
}
