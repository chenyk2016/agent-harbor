"""Fixed-image OTLP serialization boundary for metadata and optional redacted content.

LiteLLM's no-content setting does not redact exception events/status descriptions.
Install a narrow exporter subclass before LiteLLM imports it. This bridge is tested
against the pinned image; incompatible SDK changes must fail visibly at startup.
"""
import os

mode = os.environ.get("HARBOR_LANGFUSE_EXPORT_MODE")
if mode in ("metadata", "redacted") or os.environ.get("HARBOR_LANGFUSE_METADATA_ONLY") == "1":
    try:
        import re
        from urllib.parse import urlsplit
        from content import redact_content
        from opentelemetry.exporter.otlp.proto.http import trace_exporter
        from opentelemetry.sdk.trace import ReadableSpan
        from opentelemetry.sdk.trace import export as span_export
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.util.instrumentation import InstrumentationScope
        from opentelemetry.trace import Status, StatusCode

        allowed = {
            "gen_ai.operation.name", "gen_ai.provider.name", "gen_ai.system",
            "gen_ai.request.model", "gen_ai.response.model",
            "gen_ai.request.max_tokens", "gen_ai.request.temperature", "gen_ai.request.top_p",
            "gen_ai.usage.input_tokens", "gen_ai.usage.output_tokens",
            "gen_ai.usage.cache_read.input_tokens", "gen_ai.usage.cache_creation.input_tokens",
            "langfuse.observation.type", "langfuse.observation.id",
            "langfuse.observation.model.name", "langfuse.observation.model.parameters",
            "langfuse.observation.usage_details", "langfuse.observation.cost_details",
            "langfuse.trace.name", "session.id", "user.id", "http.response.status_code",
        }

        class HarborExporter(trace_exporter.OTLPSpanExporter):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                proxy = os.environ.get("HARBOR_LANGFUSE_EXPORT_PROXY")
                target = urlsplit(os.environ.get("LANGFUSE_OTEL_HOST", ""))
                endpoint = urlsplit(self._endpoint)
                if proxy and (endpoint.scheme, endpoint.netloc) == (target.scheme, target.netloc):
                    # A transport proxy for Langfuse must not route provider calls.
                    self._session.proxies.update({"http": proxy, "https": proxy})

            def export(self, spans):
                cleaned = []
                for span in spans:
                    attrs = {key: value for key, value in (span.attributes or {}).items() if key in allowed}
                    if (
                        mode == "redacted"
                        and attrs.get("langfuse.observation.type") == "generation"
                        and span.status.status_code is not StatusCode.ERROR
                        and "error.type" not in (span.attributes or {})
                    ):
                        for field, limit in (("input", 128 * 1024), ("output", 64 * 1024)):
                            key = "langfuse.observation." + field
                            raw = (span.attributes or {}).get(key)
                            if raw is not None:
                                attrs[key] = redact_content(raw, limit)
                    if "error.type" in (span.attributes or {}):
                        value = str(span.attributes["error.type"])
                        attrs["error.type"] = value if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.]{0,100}", value) else "upstream_error"
                    name = span.name if re.fullmatch(r"[A-Za-z0-9_ .:/-]{1,150}", span.name) else "llm.call"
                    cleaned.append(ReadableSpan(
                        name=name, context=span.context, parent=span.parent,
                        resource=Resource({"service.name": "litellm"}), attributes=attrs,
                        events=(), links=(), kind=span.kind,
                        status=Status(span.status.status_code), start_time=span.start_time,
                        end_time=span.end_time,
                        instrumentation_scope=InstrumentationScope("harbor.litellm." + (mode or "metadata")),
                    ))
                return super().export(cleaned)

        class SilentConsoleExporter(span_export.SpanExporter):
            """The preset's default console exporter would bypass the OTLP filter."""

            def __init__(self, *args, **kwargs):
                pass

            def export(self, spans):
                return span_export.SpanExportResult.SUCCESS

        span_export.ConsoleSpanExporter = SilentConsoleExporter
        trace_exporter.OTLPSpanExporter = HarborExporter
    except Exception:
        # Do not run with an unexpectedly unredacted exporter after a dependency upgrade.
        os.write(2, b"Harbor Langfuse exporter incompatible with this image\n")
        os._exit(78)
