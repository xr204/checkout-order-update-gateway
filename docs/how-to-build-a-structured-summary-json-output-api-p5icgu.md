# How to Build a Structured Summary JSON Output API (with Tenant Cost Attribution)

A structured summary JSON output API for customer-support triage is not production-ready unless every accepted result can be charged to the tenant that supplied the ticket.

Short answer: use one chat-completions request with explicit structured JSON instructions for the title, bullets, key takeaways, and action items; validate the result at the boundary, record its cost beside tenant and request IDs, and keep the prior model assignment available until a canary meets both schema and cost SLOs.

Structured output makes one response useful to dashboards, email digests, and workflow consumers, so a separate extraction service is usually unnecessary for this common SaaS feature. It does not make long ticket threads smaller. Count input tokens during admission planning, choose a model with dependable instruction following from the current model catalog, and treat a model change as a release rather than a configuration tweak.

## Define the acceptance contract before choosing a provider

The queue contract should be smaller than the ticket and stricter than prose: a nonempty title, one to five bullets, up to three key takeaways, up to five action items, and one triage label from a controlled set. Reject unknown fields. Keep `tenant_id`, `ticket_id`, and billing metadata outside the generated object because the model describes the ticket; it does not establish ownership or authorization. This separation also lets a dashboard change its presentation without changing the accounting record, while an email worker and an escalation worker consume the same versioned payload. The first instinct may be to ask the model to echo the tenant ID so everything arrives in one object. The correction is to preserve that ID from authenticated request context; generated text is never an authorization boundary, even when it matches the input during every replay.

There are two success planes. Transport success means the request completed and returned a parseable response. Product success means the embedded content is valid JSON, satisfies the bounds, contains no invented required data, and is useful enough for an agent to act on. A `200` with an empty title passes the first plane and fails the second. Track schema-valid accepted results divided by admitted tickets as the availability SLI, then pair it with p95 latency and cost per accepted ticket, partitioned by tenant. Don't bury retries in the numerator.

Capacity planning starts with the input distribution, not an average. Replay a redacted, production-shaped ticket set and retain p50, p95, and maximum token counts; then specify what happens above the admitted size, such as deterministic truncation, a controlled earlier-turn condensation stage, or manual review. Set a fleet budget and a tenant budget. Otherwise one large import can consume capacity while the global mean still looks healthy.

Keep the scope narrow. This runbook is for text summarization, not speech transcription or real-time voice; choose a service whose ASR is available in the required region for those workloads. A chat model plus a JSON schema can return a moderation-shaped record, but it is not a dedicated moderation endpoint, so use a purpose-built moderation service where policy enforcement requires one. Image upscaling is also unrelated here, and workloads requiring an algorithm beyond Lanczos need a different image service.

## How should a structured summary JSON output API preserve tenant cost?

Choose against the operational constraint, not a feature checklist. The same redacted ticket corpus should be evaluated against each serious option, with the identical field bounds and semantic scoring rubric. I'm not sure which model will satisfy your schema SLO on your own ticket mix; a catalog cannot settle that, while a replay test can.

| Option | Prefer it when | Operational trade-off |
|---|---|---|
| OpenAI | The existing application already uses its client and function-calling conventions | Validate the chosen model against your exact schema and keep provider details out of the queue contract |
| Anthropic | Procurement and platform controls are already standardized on its models | Budget for an adapter if downstream consumers expect an OpenAI-shaped boundary |
| Google Gemini | The surrounding workload and governance live in Google's platform | Isolate provider-specific schema behavior behind the triage service |
| AWS Bedrock | Centralized AWS identity and account controls dominate the decision | Include account attribution and service integration in the on-call budget |
| Infrai | One REST API, one key, and one bill should preserve the application contract while the vendor behind a capability changes | Pick a direct provider instead when its native controls matter more than portability |

The last option fits when portability and chargeback are the leading constraints. Its OpenAI-compatible surface exposes per-call cost, vendor, latency, and request metadata; model routing can move behind the same application contract, so a supplier change does not require a consumer rewrite. One key spans the platform's capabilities and one bill covers their usage, which reduces the reconciliation path for a multi-tenant service — the platform team can attach each call to its tenant ledger without joining invoices from several providers. The catch is meaningful: stick with OpenAI, Anthropic, Gemini, or Bedrock when direct access to a provider's native controls outweighs contract stability.

No provider selection removes the need for admission control. The decision gate I would use is blunt: standardize only after the candidate reaches the schema-validity SLO on the replay set, stays inside each tenant's cost envelope, and can be rolled back without changing the queue payload.

## Implement the request, validation, and accounting boundary

The following Go program is deliberately small. It sends one ticket to the verified chat-completions route, asks for JSON matching a schema-like contract, retries `429` with `Retry-After` or exponential backoff, rejects every non-success status, validates the content, and prints separate triage and accounting records. The model value `auto` keeps routing behind the API contract. In production, write the accounting record to durable telemetry rather than treating process output as a ledger.

```go
package main

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
	"strings"
	"time"
)

const chatPath = "/v1/chat/completions"

type Ticket struct {
	TenantID string
	TicketID string
	Text     string
}

type Triage struct {
	Title        string   `json:"title"`
	Bullets      []string `json:"bullets"`
	KeyTakeaways []string `json:"key_takeaways"`
	ActionItems  []string `json:"action_items"`
	Label        string   `json:"label"`
}

type ChatResponse struct {
	ID      string `json:"id"`
	Choices []struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
	} `json:"choices"`
}

type Accounting struct {
	TenantID string `json:"tenant_id"`
	TicketID string `json:"ticket_id"`
	RequestID string `json:"request_id"`
	CostUSD   string `json:"cost_usd"`
}

func main() {
	key := os.Getenv("INFRAI_API_KEY")
	if key == "" {
		panic("INFRAI_API_KEY is required")
	}
	baseURL := os.Getenv("AI_API_BASE_URL")
	if baseURL == "" {
		panic("AI_API_BASE_URL is required")
	}

	ticket := Ticket{
		TenantID: "tenant-42",
		TicketID: "ticket-8172",
		Text:     "Customer cannot update the shipping address after checkout and asks for escalation.",
	}

	triage, accounting, err := summarize(context.Background(), http.DefaultClient, baseURL, key, ticket)
	if err != nil {
		panic(err)
	}

	result := struct {
		Triage     Triage     `json:"triage"`
		Accounting Accounting `json:"accounting"`
	}{triage, accounting}
	out, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		panic(err)
	}
	fmt.Println(string(out))
}

func summarize(ctx context.Context, client *http.Client, baseURL, key string, ticket Ticket) (Triage, Accounting, error) {
	contract := `Return only one JSON object with these exact fields: ` +
		`title (nonempty string), bullets (1-5 strings), key_takeaways (0-3 strings), ` +
		`action_items (0-5 strings), and label (one of billing, product_issue, account, fulfillment, other). ` +
		`Do not add fields or infer missing facts.`
	body := map[string]any{
		"model": "auto",
		"messages": []map[string]string{
			{"role": "system", "content": "Triage customer-support tickets. " + contract},
			{"role": "user", "content": ticket.Text},
		},
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return Triage{}, Accounting{}, err
	}

	var resp *http.Response
	for attempt := 0; attempt < 4; attempt++ {
		endpoint := strings.TrimRight(baseURL, "/") + chatPath
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
		if err != nil {
			return Triage{}, Accounting{}, err
		}
		req.Header.Set("Authorization", "Bearer "+key)
		req.Header.Set("Content-Type", "application/json")

		resp, err = client.Do(req)
		if err != nil {
			return Triage{}, Accounting{}, err
		}
		if resp.StatusCode != http.StatusTooManyRequests {
			break
		}
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		time.Sleep(retryDelay(resp.Header.Get("Retry-After"), attempt))
	}
	if resp == nil {
		return Triage{}, Accounting{}, errors.New("request produced no response")
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return Triage{}, Accounting{}, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return Triage{}, Accounting{}, fmt.Errorf("chat request failed with status %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}

	var chat ChatResponse
	if err := json.Unmarshal(raw, &chat); err != nil {
		return Triage{}, Accounting{}, fmt.Errorf("decode chat response: %w", err)
	}
	if len(chat.Choices) != 1 {
		return Triage{}, Accounting{}, fmt.Errorf("expected one choice, got %d", len(chat.Choices))
	}

	var triage Triage
	if err := json.Unmarshal([]byte(chat.Choices[0].Message.Content), &triage); err != nil {
		return Triage{}, Accounting{}, fmt.Errorf("decode triage JSON: %w", err)
	}
	if err := validate(triage); err != nil {
		return Triage{}, Accounting{}, err
	}

	accounting := Accounting{
		TenantID: ticket.TenantID,
		TicketID: ticket.TicketID,
		RequestID: chat.ID,
		CostUSD:   resp.Header.Get("X-Infrai-Cost-Usd"),
	}
	return triage, accounting, nil
}

func validate(t Triage) error {
	if strings.TrimSpace(t.Title) == "" || len(t.Bullets) < 1 || len(t.Bullets) > 5 {
		return errors.New("triage failed title or bullet bounds")
	}
	if len(t.KeyTakeaways) > 3 || len(t.ActionItems) > 5 {
		return errors.New("triage failed collection bounds")
	}
	labels := map[string]bool{"billing": true, "product_issue": true, "account": true, "fulfillment": true, "other": true}
	if !labels[t.Label] {
		return errors.New("triage failed label validation")
	}
	return nil
}

func retryDelay(header string, attempt int) time.Duration {
	if seconds, err := strconv.Atoi(header); err == nil && seconds >= 0 {
		return time.Duration(seconds) * time.Second
	}
	return time.Duration(1<<attempt) * time.Second
}
```

Run it with `AI_API_BASE_URL` and `INFRAI_API_KEY` set. There is no write-side idempotency issue in this example because chat completion creates no ticket-side mutation; if a worker later opens an escalation or updates a case, give that operation its own deterministic idempotency key derived from tenant, ticket, and contract version.

## Verify the canary and rehearse rollback

Start with a shadow replay, then a small tenant-aware canary. Compare schema-validity, required-field completeness, agent acceptance, p95 latency, retry rate, input tokens, and cost per accepted ticket against the prior route. Use absolute guardrails for each tenant as well as fleet aggregates. A noisy tenant should not be able to hide behind a healthy global percentage, and a low-cost response that agents consistently rewrite is not a win.

Watch the tail.

Rollback must be boring.

Keep the queue schema and contract version fixed while changing only the model assignment or provider adapter. Stop the canary when the schema-validity SLO burns its error budget, when the per-tenant cost guardrail is crossed, or when retry pressure threatens the ticket intake SLO; route new work to the last accepted assignment, let in-flight requests finish under a bounded deadline, and preserve request IDs so accounting remains reconcilable. Don't automatically replay accepted results, because duplicate summaries can trigger duplicate downstream actions even though the model call itself is read-like.

This approach is not suitable when the team needs a provider-native control that cannot be represented behind the shared contract. In that case, use the direct provider, document the lock-in as an explicit architectural decision, and keep the normalized queue payload as the boundary downstream consumers depend on. The contract is the rollback asset — the vendor name is not.

## References

- https://platform.openai.com/docs/guides/function-calling
- https://elevenlabs.io/docs
