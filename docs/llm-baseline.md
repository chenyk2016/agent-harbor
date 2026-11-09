# LiteLLM operator baseline

Enable `AH_LLM_POLICY_FILE=infra/llm-policy.json` after initializing the control database through the [installation workflow](quickstart.md) and verifying the gateway configuration in an isolated instance. The values below describe the bundled policy; administrator-managed cost and timeout rows may override the per-model values.

Supplier USD rates and request timeouts can now be maintained in the admin console as versioned cost rows keyed by provider and upstream model. The operator policy file remains a fallback and still supplies the global user RPM; its `models` map may be empty once rates are managed in the database. It does not change the RMB selling prices saved by the wallet administrator. The bundled DeepSeek rates use the documented standard/peak price; automatic off-peak and Chinese public-holiday pricing are not enabled. Review rates before enabling another provider or model with the same upstream name.

## User and key policy

- Each Harbor owner maps to one `harbor:<ownerId>` internal gateway user.
- The bundled policy sets user RPM to 60; `userRpmLimit` is configurable. TPM and request concurrency limits are not set. Budget duration is null: cumulative budgets do not reset automatically.
- Environment keys remain `llm_api`, with one allowed deployment and a stable logical alias. They belong to the gateway user and do not receive a separate full user allowance.
- Harbor still owns session writer locks, task/environment resource limits and confirmed container cleanup. Unset gateway concurrency limits do not remove those execution boundaries.
- Startup and authorization preparation read back applied identity, rates and limits. A missing model policy or unconfirmed update blocks execution rather than silently falling back.

## Two currencies

Harbor remains the authority for RMB balances, grants, Plus and consumption. LiteLLM records supplier USD observations. They are not added together.

The gateway user's additional USD risk allowance is derived from currently unreserved RMB balance using the largest configured RMB/USD unit-price ratio across enabled models. This is a conservative risk allowance, not an exchange rate or an extra gift. It is added to the user's observed cumulative gateway spend; spend is never reset. The RMB wallet remains the final enforcement layer because gateway observations can lag and use a different pricing policy.

In this mode wallet reservations use a conservative request estimate (UTF-8 request bytes plus overhead, requested maximum output, saved RMB prices), rather than locking the user's entire balance. This estimate is not a tokenizer guarantee. Final reported usage settles the request. If actual cost exceeds the estimate, settlement may use unreserved balance but protects every other request's hold. Any excess beyond available funds is absorbed by the platform. Requests remain subject to available money even when concurrency is unrestricted.

## Timeouts and retries

Flash request timeout and streaming timeout are 180 seconds; Pro uses 600 seconds. The wallet forwarder's outer deadline is 630 seconds when the baseline is enabled. Global gateway timeout is 600 seconds, router and deployment retries are zero. Native SDK retries are a separate layer. Platform task duration, turn and SDK estimated-cost settings are not changed by this policy.

## Request observations

The forwarder stores the gateway call ID on wallet requests and passes that ID back to the SDK. A 5-second metadata-only importer reads paginated spend logs with a 10-minute overlap. A checkpoint advances only after a complete scan. Replayed rows update the same observation; they never create another wallet debit.

Ownership comes from the stored hash of a Harbor-issued key, including revoked historical keys. Prompt/response bodies are not stored by this importer. Old zero or partial-price rows remain uncertain; adding prices today does not retroactively turn them into valid billable usage. Persisted observations remain available after the gateway key is deleted.

Keep spend logs until import and backup recovery are proven. Do not enable automatic retention cleanup merely because a retention duration has been proposed. The importer and metrics are operational observations, not a reconciliation against the supplier's final invoice.

## Operations and validation

The gateway configuration retains PostgreSQL and one worker, enables the original reservation mechanism, selects fail-closed budget/rate-limit policies, and exposes authenticated Prometheus metrics. Without Redis, rate limiting remains per-instance; the fail-closed rate-limit flag cannot provide distributed protection. Add shared Redis and verify failures before introducing more workers or replicas.

Use `/health/liveness` and `/health/readiness` for routine process checks. Avoid frequent paid model health probes. Preserve the existing master key, salt and database during restart. Back up both databases and the Harbor secret directory before migration; a readable dump is not a completed restore drill.

Validate user/key readback, prices actually billed, shared-user budgets, cancellation followed by another request, protected parallel RMB reservations, import idempotency and persistence, metrics authentication and unchanged historical balances. A local deterministic provider proves integration behavior, not real-provider price accuracy or production isolation.

Sources: [LiteLLM budgets](https://docs.litellm.ai/docs/proxy/users), [custom pricing](https://docs.litellm.ai/docs/proxy/custom_pricing), [timeouts](https://docs.litellm.ai/docs/proxy/timeout), [DeepSeek USD prices](https://api-docs.deepseek.com/quick_start/pricing/).
