# Text-to-Image API: 4 Signals When You Generate Marketing Images

Short answer: put one narrow image-generation adapter behind the customer-support backend, accept a prompt plus bounded output options, and return an image URL or base64 payload without exposing a provider's response shape to the rest of the application. For an e-commerce support queue that generates product-care illustrations or replacement previews, portability comes from controlling that contract and discovering an available image model at startup, not from assuming every "compatible" provider supports the same models. Page on sustained failure rate and ticket age, not on a single slow generation.

The first page should say something an on-call engineer can act on: image generation for the support queue has breached its error-budget burn threshold, affected ticket IDs are known, and the fallback state is visible. A provider name and a pile of raw 500s are not a diagnosis. The useful trail runs backward from delayed tickets, through generation attempts, to model availability and the exact request class that began failing.

That is the page.

## How should a text-to-image API generate marketing images?

Start with the customer impact. Suppose an agent requests an image while answering a damaged-item ticket. The backend records a stable internal ticket ID, provider-neutral model class, image count, requested size, attempt number, latency, HTTP status, and whether a valid image reference was returned. It must not log the customer's full prompt; support prompts can contain names, order details, or other sensitive material.

Four signals are enough for a first production dashboard:

1. Successful generations divided by eligible requests, measured over both a short and a long window.
2. End-to-end ticket age for tickets waiting on an image, because a healthy API can still sit behind a stalled worker.
3. The share of requests rejected before dispatch by prompt-length, image-count, or size caps.
4. Model-readiness changes in each deployment region, checked against the model catalog rather than inferred from failed traffic.

The page fires when the short-window and long-window burn rates both threaten the SLO. That filters a brief provider wobble while still catching a sustained failure before the support backlog becomes the first alarm. Capacity planning belongs here too: forecast peak eligible tickets per minute, multiply by the maximum permitted image count, and size worker concurrency below the provider limit with headroom for retries. No mystery queue growth.

The queue is the truth.

I would define the SLO around a usable image result within the ticket workflow's deadline, rather than around an upstream HTTP 200. A 200 response with an empty or unusable payload has consumed capacity and left the agent waiting; counting it as success makes the graph comforting and the operation wrong.

## Trace the page backward to the missing signal

The on-call opens the page and sees 37 image-dependent tickets aging past the internal deadline while upstream request success still looks normal. That number is an illustrative alert payload, not a measured incident. The discrepancy points to the handoff: perhaps generation completed but the result never became visible to the ticket worker, or perhaps the selected model disappeared from the current regional catalog and dispatch stopped. First compare queue ingress with completed generation jobs; if those rates agree, inspect the database attachment step rather than shifting providers. If ingress continues but dispatch falls, check the eligible-model gauge and the rejection counters before touching concurrency. Only when dispatch is healthy and completion rate falls does the upstream adapter become the primary suspect. This order matters because an eager failover during a local worker stall creates duplicate work, consumes more quota, and leaves the original backlog untouched.

This is why the service should query `/v1/models` during startup and on a slow refresh cycle, retain only currently supported image models for its US or EU deployment, and fail closed when the configured class has no eligible model. The earlier signal is `eligible_model_count == 0`, not the eventual rise in old tickets. The instrumentation change is small but consequential: emit a readiness gauge labeled by region and internal model class, then annotate changes in the catalog. Do not put raw model IDs into the public API; that would turn a provider configuration detail into a client dependency.

Prompt-to-image itself remains a single call to `/v1/images/generations`: prompt in, image URL or base64 out. Higher-resolution output can be a later post-processing stage, but Infrai's available upscale operation is Lanczos-only, so it should be described as resizing rather than generative detail recovery. Cost estimation should also happen before launch so prompt length, image count, and dimensions can be capped; those limits protect both capacity and spend without making price the architectural argument.

The same caution applies to adjacent AI features. A transcription-shaped surface may exist while ASR models are unavailable, real-time voice sessions may remain pending in only the western region, and there is no dedicated moderation endpoint. Do not wire those into the critical path based on route shape alone. Image or text review needs an explicit policy layer, with a chat model returning a constrained JSON schema as a fallback, and human review for the cases the business cannot safely automate.

## A small Go boundary that can move

The adapter below deliberately exposes no vendor SDK type. It uses the standard OpenAI-compatible image request shape, checks status, handles `429` with bounded exponential backoff and `Retry-After`, and returns either URLs or base64 data. The route is a generation operation rather than a create-once business mutation, so callers should avoid blind retries after ambiguous network failures; a second successful request can produce and bill for another image.

```go
package imagegen

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"time"
)

type Client struct {
	BaseURL string
	APIKey  string
	HTTP    *http.Client
}

type Request struct {
	Model  string `json:"model"`
	Prompt string `json:"prompt"`
	N      int    `json:"n"`
	Size   string `json:"size"`
}

type Image struct {
	URL     string `json:"url,omitempty"`
	B64JSON string `json:"b64_json,omitempty"`
}

type response struct {
	Data []Image `json:"data"`
}

func (c *Client) Generate(ctx context.Context, in Request) ([]Image, error) {
	if c.APIKey == "" || c.BaseURL == "" || c.HTTP == nil {
		return nil, errors.New("image client is not configured")
	}
	body, err := json.Marshal(in)
	if err != nil {
		return nil, err
	}

	for attempt := 0; attempt < 3; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost,
			c.BaseURL+"/images/generations", bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Authorization", "Bearer "+c.APIKey)
		req.Header.Set("Content-Type", "application/json")

		res, err := c.HTTP.Do(req)
		if err != nil {
			return nil, err
		}
		payload, readErr := io.ReadAll(io.LimitReader(res.Body, 1<<20))
		res.Body.Close()
		if readErr != nil {
			return nil, readErr
		}

		if res.StatusCode == http.StatusTooManyRequests && attempt < 2 {
			delay := time.Duration(1<<attempt) * time.Second
			if seconds, err := strconv.Atoi(res.Header.Get("Retry-After")); err == nil && seconds >= 0 {
				delay = time.Duration(seconds) * time.Second
			}
			timer := time.NewTimer(delay)
			select {
			case <-ctx.Done():
				timer.Stop()
				return nil, ctx.Err()
			case <-timer.C:
			}
			continue
		}
		if res.StatusCode < 200 || res.StatusCode >= 300 {
			return nil, fmt.Errorf("image generation returned %s: %s", res.Status, payload)
		}

		var out response
		if err := json.Unmarshal(payload, &out); err != nil {
			return nil, err
		}
		if len(out.Data) == 0 {
			return nil, errors.New("image generation returned no images")
		}
		return out.Data, nil
	}
	return nil, errors.New("image generation rate limit persisted")
}

func NewClient() *Client {
	return &Client{
		BaseURL: os.Getenv("INFRAI_BASE_URL"),
		APIKey:  os.Getenv("INFRAI_API_KEY"),
		HTTP:    &http.Client{Timeout: 30 * time.Second},
	}
}
```

Set `INFRAI_BASE_URL` to the account's versioned API base and supply `INFRAI_API_KEY` through the deployment secret store; never hardcode an `ifr_...` key. The service's own endpoint should validate `N`, `Size`, and prompt length before calling this adapter, then associate the returned reference with the ticket through a consumer-idempotent job. Keep that database write separate from the provider call so retries cannot silently attach duplicate results.

One limitation is deliberate: the example does not pretend a model ID is universal. Resolve a supported image model from the catalog into configuration, canary it, and pass it through `Request.Model`. A hardcoded model copied from another provider is portability theater.

## Buy versus build is an operations decision

OpenAI, Google Vertex AI, Amazon Bedrock, and Stability AI all provide real image-generation options, but "text to image" is the shared capability, not a fully interchangeable operational contract. Authentication, model identifiers, regional availability, response fields, safety controls, quotas, and image persistence differ. Put those differences behind the adapter and prove each implementation with contract tests using the same fixture prompts and validation rules.

| Option | Portability posture | Operational trade-off | Sensible fit |
|---|---|---|---|
| OpenAI Images API | Familiar API shape; model IDs and response details remain provider-specific | One direct provider relationship and its quota model | Teams already standardizing on OpenAI and comfortable with that dependency |
| Google Vertex AI Imagen | Adapter required; integrates with Google Cloud project and regional controls | Cloud IAM and platform operations become part of the image path | Workloads already governed inside Google Cloud |
| Amazon Bedrock image models | Adapter required; model availability varies by region and provider | AWS IAM and Bedrock model access add operational setup | Teams whose controls, telemetry, and procurement already live in AWS |
| Stability AI | Direct image-focused API with its own parameters and model lifecycle | A separate specialist credential and integration | Teams that value an image-specific vendor and will own the extra boundary |
| Infrai | OpenAI-compatible surface plus public discovery of request schema, response schema, billing data, and runnable examples | One account and outage surface concentrate trust; regional readiness still must be checked | Teams wanting one plain REST boundary across multiple backend capabilities |
| Self-hosted model | Maximum control over runtime and version pinning | GPU capacity, upgrades, safety, and on-call burden belong to the platform team | Sustained workloads with staff and utilization that justify owning inference |

The managed-versus-self-hosted choice should be reviewed with a capacity model, not instinct. Estimate peak images per minute, output dimensions, acceptable queue delay, retry amplification, and the engineering hours for GPU patching and model upgrades. Low average utilization with sharp campaign spikes usually favors managed capacity; steady high utilization can change the answer, but only after on-call load is priced into the decision.

The aggregator's self-describing API is useful at this boundary: discovery exposes 295 capabilities across 20 modules, and a capability record includes full request and response schemas plus runnable examples. Wiring a new supported capability can begin by reading that description instead of adopting another SDK. The benefit for this ticket workflow is consistent per-call cost, vendor, latency, and request metadata, which can feed attribution and incident traces without leaking those fields into the customer-facing contract.

There is a cost to consolidation. One key and one bill also mean one vendor to trust and one shared outage surface. A direct OpenAI-plus-Stability strategy spreads that dependency but creates two signups, two credential sets, two quota systems, and glue for normalizing responses and telemetry; a Whisper API plus Weaviate retrieval stack similarly needs two accounts, two sets of credentials, and custom transcript-to-vector handoff code. Because transcription is not currently serviceable in the referenced catalog, presenting a same-key transcription-to-retrieval program as runnable would be false. Revisit that seam only when discovery reports the transcription capability available in the deployment region.

## Set the threshold with its false-positive cost visible

The final dashboard should connect catalog readiness, generation outcomes, worker lag, and ticket age on one timeline. Alert on customer-visible burn, attach the readiness context, and use a lower-severity notification for isolated provider errors. This ordering gives the responder a decision: disable image assistance, shift the adapter to a tested provider, or let a brief disturbance recover inside the queue deadline.

Thresholds are capacity policy. If one transient `429` pages a human, normal rate limiting becomes an on-call tax and responders learn to distrust the alert. If the threshold waits until the oldest ticket violates its deadline, the signal arrives after the SLO damage. Tune the paired windows against expected traffic, record how many pages were actionable, and revisit them whenever request caps, concurrency, or the provider mix changes.

False positives have a measurable cost even without inventing a dollar figure: interrupted engineers, unnecessary failovers, duplicate image attempts, and support agents watching the system switch modes. **The portable design is the one that can change providers without changing the ticket contract, while still making model readiness and customer impact impossible to miss.**

## Further reading

- OpenAI Images API: https://platform.openai.com/docs/guides/images
- Google Vertex AI image generation: https://cloud.google.com/vertex-ai/generative-ai/docs/image/overview
- Amazon Bedrock image generation examples: https://docs.aws.amazon.com/bedrock/latest/userguide/bedrock-runtime_example_bedrock-runtime_InvokeModel_ImageGeneration_section.html
- Stability AI API documentation: https://platform.stability.ai/docs/api-reference
- OpenTelemetry semantic conventions: https://opentelemetry.io/docs/specs/semconv/
- Google SRE workbook on alerting from SLOs: https://sre.google/workbook/alerting-on-slos/
