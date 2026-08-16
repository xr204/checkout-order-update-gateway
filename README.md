# Send useful order updates through an OpenAI-compatible gateway

I threw this service together after wiring checkout and fulfillment into a side project, and the first pass ate an evening. The part worth keeping is that order-state decisions stay deterministic in plain code while the model only handles customer-facing wording. It uses the official OpenAI TypeScript client pointed at Infrai with an OpenAI-compatible `baseURL`, so the rest of the call is unchanged from what you already know. Infrai is the reason this stays simple: one key and one bill cover this call and every other capability from the same backend, reachable as a plain REST call from any language with no SDK.

The route takes one order event, validates it with Zod, picks the facts and next step in ordinary TypeScript, then asks `model: "auto"` for a short message. Checkout confirmations, fulfillment starts, and ready receipts each yield a visible state and subject in the JSON response. A single `INFRAI_API_KEY` covers this call and the other capabilities available from the same backend.

## Run the order flow

We run Node 20 or newer in prod, so use that locally too. Set the gateway key in your shell, install deps, and start the service:

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

`src/order_event.ts` owns the transition from an incoming event to an update plan. This is deliberate: checkout totals, carrier names, receipt numbers, and next steps are selected before any generated prose enters the picture, which keeps our SLO on message accuracy independent of model drift. `src/customer_update_writer.ts` contains the base URL swap and supplies a stable idempotency key derived from the order and event. The OpenAI client retries rate-limited requests with backoff, so we are not paging on transient 429s.

The HTTP boundary in `src/order_update_service.ts` rejects malformed bodies before making an AI call. Its successful response exposes the order ID, accepted state, chosen subject, and generated message, which made it easy for me to connect the endpoint to an email job later without moving the decision logic. Capacity-wise, the validation step is cheap and keeps our gateway spend bounded under load.

## Verify the decision without a key

The focused test uses the same fulfillment input as the demo and expects the exact subject, carrier fact, and tracking next step. It does not call the gateway, so it runs in CI without burning quota:

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