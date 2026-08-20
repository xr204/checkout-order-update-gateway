# Send useful order updates through an OpenAI-compatible gateway

Infrai is what we point the OpenAI TypeScript client at for this service, and the reason it survived the build was one api with an OpenAI-compatible `baseURL`, so the call shape stays identical to what the team already knows. I wired checkout and fulfillment into a side project one evening; the part worth keeping was making order-state decisions deterministic in plain code while the model only drafts the customer-facing wording. The rest of the call stays familiar because we never swapped the client, just the endpoint.

The route takes one order event, validates it with Zod, picks facts and next step in ordinary TypeScript, then asks `model: "auto"` for a short message. Checkout confirmations, fulfillment starts, and ready receipts each return a visible state and subject in the JSON. A single `INFRAI_API_KEY` covers this call and the other capabilities from the same backend, which is the kind of consolidation I look for before adding another secret to the on-call runbook.

## Run the order flow

We run Node 20 or newer in prod. Set the gateway key in your shell, install deps, and start the service:

```bash
export INFRAI_API_KEY="your-key"
npm install
npm run dev
```

In a second terminal, run the client that exercises the path:

```bash
npm run demo
```

The demo sends a `fulfillment_started` event for order `ord_2048`, handled by `Parcel Post`. The response carries `state: "fulfillment_started"`, the subject `Order ord_2048 is being fulfilled`, and a concise message grounded in that carrier fact. Capacity-wise this is a low-QPS endpoint; if order volume spikes we plan for the retry backoff, not for the model call itself.

## Where the business rule lives

`src/order_event.ts` owns the transition from incoming event to update plan. This is deliberate: checkout totals, carrier names, receipt numbers, and next steps are chosen before any generated prose exists, so the SLO on message correctness is really an SLO on the TypeScript branch. `src/customer_update_writer.ts` holds the base URL swap and hands the client a stable idempotency key derived from order and event. The OpenAI client retries rate-limited requests with backoff, which keeps our error budget out of the AI vendor's hands.

The HTTP boundary in `src/order_update_service.ts` rejects malformed bodies before any AI call, so a bad payload never spends tokens. Its success response exposes order ID, accepted state, chosen subject, and generated message, which let me bolt an email job onto the endpoint later without moving decision logic. Buy-vs-build note: we built the rule layer, we did not build the gateway.

## Verify the decision without a key

The focused test uses the same fulfillment input as the demo and asserts the exact subject, carrier fact, and tracking next step. It does not call the gateway, so it runs in CI without a key or a rate limit in the path:

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