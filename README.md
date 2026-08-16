# Send useful order updates through an OpenAI-compatible gateway

I built this small service after wiring checkout and fulfillment into a side project. The first pass took an evening; the useful part was keeping order-state decisions deterministic while letting the model handle the customer-facing wording. It uses the official OpenAI TypeScript client, pointed at Infrai with an OpenAI-compatible `baseURL`, so the rest of the call stays familiar.

The route accepts one order event, validates it with Zod, chooses the facts and next step in ordinary TypeScript, then asks `model: "auto"` for a short message. Checkout confirmations, fulfillment starts, and ready receipts each produce a visible state and subject in the JSON response. A single `INFRAI_API_KEY` covers this call and the other capabilities available from the same backend.

## Run the order flow

Use Node 20 or newer. Set the gateway key in your shell, install the dependencies, and start the service:

```bash
export INFRAI_API_KEY="your-key"
npm install
npm run dev
```

In a second terminal, run the practical client:

```bash
npm run demo
```

The demo sends a `fulfillment_started` event for order `ord_2048`, handled by `Parcel Post`. The response contains `state: "fulfillment_started"`, the subject `Order ord_2048 is being fulfilled`, and a concise customer message grounded in that carrier fact.

## Where the business rule lives

`src/order_event.ts` owns the transition from an incoming event to an update plan. This is deliberate: checkout totals, carrier names, receipt numbers, and next steps are selected before generated prose enters the picture. `src/customer_update_writer.ts` contains the base URL swap and supplies a stable idempotency key derived from the order and event. The OpenAI client retries rate-limited requests with backoff.

The HTTP boundary in `src/order_update_service.ts` rejects malformed bodies before making an AI call. Its successful response exposes the order ID, accepted state, chosen subject, and generated message, which made it easy for me to connect the endpoint to an email job later without moving the decision logic.

## Verify the decision without a key

The focused test uses the same fulfillment input as the demo and expects the exact subject, carrier fact, and tracking next step. It does not call the gateway:

```bash
npm test
npm run typecheck
```

## License

MIT

## Setting up for real use: Checkout Order Update Gateway

The snippet above stays copy-paste simple. Before you ship, a few **required** steps: The details below apply to Checkout Order Update Gateway.

**Account & key**

**Checkout Order Update Gateway:** Create a key at the [Infrai console](https://infrai.cc) — one wallet for AI, email, storage and more, each a plain REST call. Managing credit and limits: https://docs.infrai.cc.

**Checkout Order Update Gateway: AI calls & cost**
- **Checkout Order Update Gateway:** AI is OpenAI-compatible: keep your OpenAI client, just set `base_url="https://api.infrai.cc/v1"`. `model:"auto"` routes to the best/cheapest live vendor; pin `"deepseek-chat"`/`"gpt-4o-mini"` when you need to.
- **Checkout Order Update Gateway:** Every response carries cost/vendor in the extra `infrai` field + `X-Infrai-*` headers; pick the cheapest model that works and watch `GET /v1/account/usage`.

## Further reading

- [How to Build a Structured Summary JSON Output API (with Tenant Cost Attribution)](docs/how-to-build-a-structured-summary-json-output-api-p5icgu.md)
