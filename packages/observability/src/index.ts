import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

export type TelemetryAttributeValue = string | number | boolean;
export type TelemetryAttributes = Readonly<Record<string, TelemetryAttributeValue | undefined>>;

export interface TraceContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly traceFlags: number;
  readonly sampled: boolean;
  readonly traceState?: string;
}

export type SpanKind = "INTERNAL" | "SERVER" | "CLIENT" | "PRODUCER" | "CONSUMER";
export type SpanStatusCode = "UNSET" | "OK" | "ERROR";

export interface TelemetrySpanEvent {
  readonly name: string;
  readonly timestampUnixNano: string;
  readonly attributes: Readonly<Record<string, TelemetryAttributeValue>>;
}

export interface TelemetrySpanRecord {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind: SpanKind;
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano: string;
  readonly durationMs: number;
  readonly status: {
    readonly code: SpanStatusCode;
    readonly message?: string;
  };
  readonly attributes: Readonly<Record<string, TelemetryAttributeValue>>;
  readonly events: readonly TelemetrySpanEvent[];
}

export interface TelemetryMetricPoint {
  readonly kind: "COUNTER" | "HISTOGRAM";
  readonly name: string;
  readonly description?: string;
  readonly unit?: string;
  readonly value: number;
  readonly attributes: Readonly<Record<string, TelemetryAttributeValue>>;
  readonly timestampUnixNano: string;
}

export interface TelemetryExporter {
  exportSpans(spans: readonly TelemetrySpanRecord[]): Promise<void> | void;
  exportMetrics?(metrics: readonly TelemetryMetricPoint[]): Promise<void> | void;
  shutdown?(): Promise<void> | void;
}

const TRACEPARENT_REGEX = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const SENSITIVE_ATTR_KEY_REGEX =
  /api[-_]?key|secret|password|passwd|token|authorization|cookie|private[-_]?key|credential|bearer|session[-_]?id|auth[-_]?header/i;
const SENSITIVE_VALUE_PATTERNS: readonly RegExp[] = [
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/g,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+(?::[^\s/@]*)?@/gi,
  /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /\b(?:sk-[A-Za-z0-9_-]{12,}|AIza[0-9A-Za-z_-]{20,}|gh[pousr]_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[0-9A-Z]{16})\b/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,
];

function nowUnixNano(): bigint {
  return BigInt(Date.now()) * 1_000_000n;
}

export function generateTraceId(): string {
  return randomBytes(16).toString("hex");
}

export function generateSpanId(): string {
  return randomBytes(8).toString("hex");
}

export function parseTraceparent(
  headerValue: string | null | undefined,
  traceState?: string | null
): TraceContext | null {
  if (!headerValue) {
    return null;
  }
  const normalized = headerValue;
  const match = normalized.match(TRACEPARENT_REGEX);
  if (!match) {
    return null;
  }
  const version = match[1]!;
  const traceId = match[2]!;
  const spanId = match[3]!;
  const flagsHex = match[4]!;
  if (version === "ff" || /^0+$/.test(traceId) || /^0+$/.test(spanId)) {
    return null;
  }
  const traceFlags = Number.parseInt(flagsHex, 16);
  const cleanState = traceState && traceState.length <= 512 && !/[\r\n]/.test(traceState) ? traceState.trim() : undefined;
  return {
    traceId,
    spanId,
    traceFlags,
    sampled: (traceFlags & 0x01) === 0x01,
    ...(cleanState ? { traceState: cleanState } : {}),
  };
}

export function formatTraceparent(ctx: TraceContext): string {
  const flagsHex = (ctx.traceFlags & 0xff).toString(16).padStart(2, "0");
  return `00-${ctx.traceId}-${ctx.spanId}-${flagsHex}`;
}

export function extractHttpTraceContext(
  headers: Readonly<Record<string, string | string[] | undefined>> | undefined
): TraceContext | null {
  if (!headers) {
    return null;
  }
  let traceparentVal: string | undefined;
  let tracestateVal: string | undefined;
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    const first = Array.isArray(v) ? v[0] : v;
    if (lower === "traceparent" && typeof first === "string") {
      traceparentVal = first;
    } else if (lower === "tracestate" && typeof first === "string") {
      tracestateVal = first;
    }
  }
  return parseTraceparent(traceparentVal, tracestateVal);
}

export function redactTelemetryValue(value: TelemetryAttributeValue): TelemetryAttributeValue {
  if (typeof value !== "string") {
    return value;
  }
  let out = value;
  for (const pat of SENSITIVE_VALUE_PATTERNS) {
    out = out.replace(pat, "[REDACTED]");
  }
  out = out.replace(/(\b(?:set[-_]?cookie|cookie)\s*[=:]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]+)/gi, "$1[REDACTED]");
  return out.replace(/((?:[\w-]*(?:api[_-]?key|password|passwd|secret|authorization|credential|token|cookie|private[_-]?key|session[_-]?id))\s*[=:]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, "$1[REDACTED]");
}

export function redactTelemetryAttributes(
  attrs: TelemetryAttributes | undefined
): Record<string, TelemetryAttributeValue> {
  const cleaned: Record<string, TelemetryAttributeValue> = {};
  if (!attrs) {
    return cleaned;
  }
  for (const [key, rawVal] of Object.entries(attrs)) {
    if (rawVal === undefined) {
      continue;
    }
    if (SENSITIVE_ATTR_KEY_REGEX.test(key)) {
      cleaned[key] = "[REDACTED]";
    } else {
      cleaned[key] = redactTelemetryValue(rawVal);
    }
  }
  return cleaned;
}

export function redactTelemetryMessage(msg: string): string {
  return String(redactTelemetryValue(msg));
}

export class InMemoryTelemetryExporter implements TelemetryExporter {
  public readonly spans: TelemetrySpanRecord[] = [];
  public readonly metrics: TelemetryMetricPoint[] = [];

  public exportSpans(spans: readonly TelemetrySpanRecord[]): void {
    this.spans.push(...spans);
  }

  public exportMetrics(metrics: readonly TelemetryMetricPoint[]): void {
    this.metrics.push(...metrics);
  }

  public clear(): void {
    this.spans.length = 0;
    this.metrics.length = 0;
  }

  public getSpansByName(name: string): TelemetrySpanRecord[] {
    return this.spans.filter((s) => s.name === name);
  }

  public getCounterTotal(
    name: string,
    attrFilter?: Readonly<Record<string, TelemetryAttributeValue>>
  ): number {
    let total = 0;
    for (const point of this.metrics) {
      if (point.kind !== "COUNTER" || point.name !== name) {
        continue;
      }
      if (attrFilter) {
        let matched = true;
        for (const [k, v] of Object.entries(attrFilter)) {
          if (point.attributes[k] !== v) {
            matched = false;
            break;
          }
        }
        if (!matched) {
          continue;
        }
      }
      total += point.value;
    }
    return total;
  }
}

export interface OtlpHttpJsonExporterOptions {
  readonly baseUrl?: string;
  readonly tracesEndpoint?: string;
  readonly metricsEndpoint?: string;
  readonly serviceName?: string;
  readonly serviceVersion?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

function toOtlpAnyValue(val: TelemetryAttributeValue): Record<string, unknown> {
  if (typeof val === "string") {
    return { stringValue: val };
  }
  if (typeof val === "boolean") {
    return { boolValue: val };
  }
  if (Number.isInteger(val)) {
    return { intValue: String(val) };
  }
  return { doubleValue: val };
}

function toOtlpAttributes(
  attrs: Readonly<Record<string, TelemetryAttributeValue>>
): Array<{ key: string; value: Record<string, unknown> }> {
  return Object.entries(attrs).map(([key, val]) => ({
    key,
    value: toOtlpAnyValue(val),
  }));
}

function spanKindToOtlpInt(kind: SpanKind): number {
  switch (kind) {
    case "INTERNAL":
      return 1;
    case "SERVER":
      return 2;
    case "CLIENT":
      return 3;
    case "PRODUCER":
      return 4;
    case "CONSUMER":
      return 5;
  }
}

function spanStatusToOtlpCode(code: SpanStatusCode): number {
  switch (code) {
    case "UNSET":
      return 0;
    case "OK":
      return 1;
    case "ERROR":
      return 2;
  }
}

export class OtlpHttpJsonExporter implements TelemetryExporter {
  private readonly tracesEndpoint: string;
  private readonly metricsEndpoint: string;
  private readonly serviceName: string;
  private readonly serviceVersion: string;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly timeoutMs: number;
  public exportFailures = 0;

  public constructor(options: OtlpHttpJsonExporterOptions) {
    const cleanBase = options.baseUrl?.replace(/\/+$/, "") ?? "";
    this.tracesEndpoint =
      options.tracesEndpoint ?? (cleanBase ? `${cleanBase}/v1/traces` : "");
    this.metricsEndpoint =
      options.metricsEndpoint ?? (cleanBase ? `${cleanBase}/v1/metrics` : "");
    this.serviceName = options.serviceName ?? "software-factory";
    this.serviceVersion = options.serviceVersion ?? "1.5.0";
    this.headers = options.headers ?? {};
    this.timeoutMs = options.timeoutMs ?? 3000;
  }

  public async exportSpans(spans: readonly TelemetrySpanRecord[]): Promise<void> {
    if (spans.length === 0 || !this.tracesEndpoint) {
      return;
    }
    const payload = {
      resourceSpans: [
        {
          resource: {
            attributes: toOtlpAttributes({
              "service.name": this.serviceName,
              "service.version": this.serviceVersion,
            }),
          },
          scopeSpans: [
            {
              scope: {
                name: "@software-factory/observability",
                version: "1.5.0",
              },
              spans: spans.map((s) => ({
                traceId: s.traceId,
                spanId: s.spanId,
                ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
                name: s.name,
                kind: spanKindToOtlpInt(s.kind),
                startTimeUnixNano: s.startTimeUnixNano,
                endTimeUnixNano: s.endTimeUnixNano,
                attributes: toOtlpAttributes(s.attributes),
                events: s.events.map((e) => ({
                  timeUnixNano: e.timestampUnixNano,
                  name: e.name,
                  attributes: toOtlpAttributes(e.attributes),
                })),
                status: {
                  code: spanStatusToOtlpCode(s.status.code),
                  ...(s.status.message ? { message: s.status.message } : {}),
                },
              })),
            },
          ],
        },
      ],
    };
    await this.postOtlpJson(this.tracesEndpoint, payload);
  }

  public async exportMetrics(metrics: readonly TelemetryMetricPoint[]): Promise<void> {
    if (metrics.length === 0 || !this.metricsEndpoint) {
      return;
    }
    const payload = {
      resourceMetrics: [
        {
          resource: {
            attributes: toOtlpAttributes({
              "service.name": this.serviceName,
              "service.version": this.serviceVersion,
            }),
          },
          scopeMetrics: [
            {
              scope: {
                name: "@software-factory/observability",
                version: "1.5.0",
              },
              metrics: metrics.map((m) =>
                m.kind === "COUNTER"
                  ? {
                      name: m.name,
                      ...(m.description ? { description: m.description } : {}),
                      ...(m.unit ? { unit: m.unit } : {}),
                      sum: {
                        aggregationTemporality: 1,
                        isMonotonic: true,
                        dataPoints: [
                          {
                            attributes: toOtlpAttributes(m.attributes),
                            timeUnixNano: m.timestampUnixNano,
                            asDouble: m.value,
                          },
                        ],
                      },
                    }
                  : {
                      name: m.name,
                      ...(m.description ? { description: m.description } : {}),
                      ...(m.unit ? { unit: m.unit } : {}),
                      histogram: {
                        aggregationTemporality: 1,
                        dataPoints: [
                          {
                            attributes: toOtlpAttributes(m.attributes),
                            timeUnixNano: m.timestampUnixNano,
                            startTimeUnixNano: m.timestampUnixNano,
                            count: "1",
                            sum: m.value,
                            min: m.value,
                            max: m.value,
                            explicitBounds: [],
                            bucketCounts: ["1"],
                          },
                        ],
                      },
                    }
              ),
            },
          ],
        },
      ],
    };
    await this.postOtlpJson(this.metricsEndpoint, payload);
  }

  private async postOtlpJson(url: string, body: unknown): Promise<void> {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...this.headers,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) {
        this.exportFailures += 1;
      }
    } catch {
      this.exportFailures += 1;
    }
  }
}

export interface ActiveSpanHandle {
  readonly context: TraceContext;
  setAttribute(key: string, value: TelemetryAttributeValue | undefined): void;
  addEvent(name: string, attributes?: TelemetryAttributes): void;
  setStatus(code: SpanStatusCode, message?: string): void;
  recordException(err: unknown): void;
  end(): TelemetrySpanRecord;
}

export interface FactoryTelemetryOptions {
  readonly serviceName?: string;
  readonly exporters?: readonly TelemetryExporter[];
  readonly maxRetainedSpans?: number;
}

export interface HistogramSummary {
  readonly count: number;
  readonly sum: number;
  readonly min: number;
  readonly max: number;
  readonly last: number;
}

export interface TelemetrySnapshot {
  readonly serviceName: string;
  readonly totalSpansRecorded: number;
  readonly counters: Readonly<Record<string, number>>;
  readonly histograms: Readonly<Record<string, HistogramSummary>>;
  readonly recentSpans: readonly TelemetrySpanRecord[];
}

export class FactoryTelemetry {
  private readonly serviceName: string;
  private readonly exporters: TelemetryExporter[];
  private readonly als = new AsyncLocalStorage<TraceContext>();
  private readonly recentSpans: TelemetrySpanRecord[] = [];
  private readonly maxRetainedSpans: number;
  private readonly counters = new Map<string, number>();
  private readonly histograms = new Map<string, HistogramSummary>();
  private readonly pendingExports = new Set<Promise<void>>();
  private totalSpansRecorded = 0;

  public constructor(options: FactoryTelemetryOptions = {}) {
    this.serviceName = options.serviceName ?? "software-factory";
    this.exporters = [...(options.exporters ?? [])];
    this.maxRetainedSpans = options.maxRetainedSpans ?? 250;
  }

  public addExporter(exporter: TelemetryExporter): void {
    this.exporters.push(exporter);
  }

  public getActiveTraceContext(): TraceContext | null {
    return this.als.getStore() ?? null;
  }

  public injectHttpTraceHeaders(
    targetHeaders: Record<string, string> = {},
    contextOverride?: TraceContext | null
  ): Record<string, string> {
    const ctx = contextOverride ?? this.getActiveTraceContext();
    if (!ctx) {
      return targetHeaders;
    }
    targetHeaders.traceparent = formatTraceparent(ctx);
    if (ctx.traceState) {
      targetHeaders.tracestate = ctx.traceState;
    }
    return targetHeaders;
  }

  public runWithTraceContext<T>(ctx: TraceContext | null, fn: () => T): T {
    if (!ctx) {
      return fn();
    }
    return this.als.run(ctx, fn);
  }

  public startSpan(options: {
    readonly name: string;
    readonly kind?: SpanKind;
    readonly parentContext?: TraceContext | null;
    readonly attributes?: TelemetryAttributes;
  }): ActiveSpanHandle {
    const parent =
      options.parentContext !== undefined ? options.parentContext : this.getActiveTraceContext();
    const traceId = parent?.traceId ?? generateTraceId();
    const spanId = generateSpanId();
    const context: TraceContext = {
      traceId,
      spanId,
      traceFlags: parent?.traceFlags ?? 1,
      sampled: parent ? parent.sampled : true,
      ...(parent?.traceState ? { traceState: parent.traceState } : {}),
    };

    const startNs = nowUnixNano();
    const startPerfMs = performance.now();
    const attributes: Record<string, TelemetryAttributeValue> = redactTelemetryAttributes({
      "service.name": this.serviceName,
      ...options.attributes,
    });
    const events: TelemetrySpanEvent[] = [];
    let statusCode: SpanStatusCode = "UNSET";
    let statusMessage: string | undefined;
    let ended = false;
    let finalizedRecord: TelemetrySpanRecord | null = null;

    const recordSpan = (rec: TelemetrySpanRecord) => {
      this.totalSpansRecorded += 1;
      this.recentSpans.push(rec);
      while (this.recentSpans.length > this.maxRetainedSpans) {
        this.recentSpans.shift();
      }
      for (const exporter of this.exporters) {
        this.trackExport(() => exporter.exportSpans([rec]));
      }
    };

    const handle: ActiveSpanHandle = {
      context,
      setAttribute: (key, value) => {
        if (ended || value === undefined) return;
        const clean = redactTelemetryAttributes({ [key]: value });
        Object.assign(attributes, clean);
      },
      addEvent: (name, evAttrs) => {
        if (ended) return;
        events.push({
          name,
          timestampUnixNano: nowUnixNano().toString(),
          attributes: redactTelemetryAttributes(evAttrs),
        });
      },
      setStatus: (code, message) => {
        if (ended) return;
        statusCode = code;
        if (message !== undefined) {
          statusMessage = redactTelemetryMessage(message);
        }
      },
      recordException: (err) => {
        if (ended) return;
        const message = err instanceof Error ? err.message : String(err);
        const name = err instanceof Error ? err.name : "Error";
        statusCode = "ERROR";
        statusMessage = redactTelemetryMessage(message);
        events.push({
          name: "exception",
          timestampUnixNano: nowUnixNano().toString(),
          attributes: redactTelemetryAttributes({
            "exception.type": name,
            "exception.message": message,
          }),
        });
      },
      end: () => {
        if (finalizedRecord) {
          return finalizedRecord;
        }
        ended = true;
        const endNs = nowUnixNano();
        const durationMs = Math.max(0, Number((performance.now() - startPerfMs).toFixed(3)));
        finalizedRecord = {
          traceId,
          spanId,
          ...(parent?.spanId ? { parentSpanId: parent.spanId } : {}),
          name: options.name,
          kind: options.kind ?? "INTERNAL",
          startTimeUnixNano: startNs.toString(),
          endTimeUnixNano: endNs.toString(),
          durationMs,
          status: {
            code: statusCode === "UNSET" ? "OK" : statusCode,
            ...(statusMessage ? { message: statusMessage } : {}),
          },
          attributes: { ...attributes },
          events: [...events],
        };
        recordSpan(finalizedRecord);
        return finalizedRecord;
      },
    };

    return handle;
  }

  public async withSpan<T>(
    name: string,
    optionsOrFn:
      | {
          readonly kind?: SpanKind;
          readonly parentContext?: TraceContext | null;
          readonly attributes?: TelemetryAttributes;
        }
      | ((span: ActiveSpanHandle) => Promise<T> | T),
    maybeFn?: (span: ActiveSpanHandle) => Promise<T> | T
  ): Promise<T> {
    const options = typeof optionsOrFn === "function" ? {} : optionsOrFn;
    const fn = typeof optionsOrFn === "function" ? optionsOrFn : maybeFn!;
    const span = this.startSpan({
      name,
      kind: options.kind,
      parentContext: options.parentContext,
      attributes: options.attributes,
    });
    return this.als.run(span.context, async () => {
      try {
        const result = await fn(span);
        span.setStatus("OK");
        return result;
      } catch (err: unknown) {
        span.recordException(err);
        throw err;
      } finally {
        span.end();
      }
    });
  }

  public recordCounter(
    name: string,
    delta = 1,
    attributes?: TelemetryAttributes,
    options?: { readonly description?: string; readonly unit?: string }
  ): void {
    if (!Number.isFinite(delta) || delta < 0) {
      return;
    }
    const cleanAttrs = redactTelemetryAttributes(attributes);
    this.counters.set(name, (this.counters.get(name) ?? 0) + delta);
    const point: TelemetryMetricPoint = {
      kind: "COUNTER",
      name,
      ...(options?.description ? { description: options.description } : {}),
      ...(options?.unit ? { unit: options.unit } : {}),
      value: delta,
      attributes: cleanAttrs,
      timestampUnixNano: nowUnixNano().toString(),
    };
    for (const exporter of this.exporters) {
      if (exporter.exportMetrics) {
        this.trackExport(() => exporter.exportMetrics!([point]));
      }
    }
  }

  public recordHistogram(
    name: string,
    value: number,
    attributes?: TelemetryAttributes,
    options?: { readonly description?: string; readonly unit?: string }
  ): void {
    if (!Number.isFinite(value)) {
      return;
    }
    const cleanAttrs = redactTelemetryAttributes(attributes);
    const prev = this.histograms.get(name);
    if (!prev) {
      this.histograms.set(name, {
        count: 1,
        sum: value,
        min: value,
        max: value,
        last: value,
      });
    } else {
      this.histograms.set(name, {
        count: prev.count + 1,
        sum: prev.sum + value,
        min: Math.min(prev.min, value),
        max: Math.max(prev.max, value),
        last: value,
      });
    }
    const point: TelemetryMetricPoint = {
      kind: "HISTOGRAM",
      name,
      ...(options?.description ? { description: options.description } : {}),
      ...(options?.unit ? { unit: options.unit } : {}),
      value,
      attributes: cleanAttrs,
      timestampUnixNano: nowUnixNano().toString(),
    };
    for (const exporter of this.exporters) {
      if (exporter.exportMetrics) {
        this.trackExport(() => exporter.exportMetrics!([point]));
      }
    }
  }

  public getSnapshot(): TelemetrySnapshot {
    const countersObj: Record<string, number> = {};
    for (const [k, v] of this.counters.entries()) {
      countersObj[k] = v;
    }
    const histogramsObj: Record<string, HistogramSummary> = {};
    for (const [k, v] of this.histograms.entries()) {
      histogramsObj[k] = v;
    }
    return {
      serviceName: this.serviceName,
      totalSpansRecorded: this.totalSpansRecorded,
      counters: countersObj,
      histograms: histogramsObj,
      recentSpans: [...this.recentSpans],
    };
  }

  public async flush(): Promise<void> {
    if (this.pendingExports.size === 0) {
      return;
    }
    await Promise.allSettled([...this.pendingExports]);
  }

  public async shutdown(): Promise<void> {
    await this.flush();
    await Promise.allSettled(
      this.exporters.map((exp) => Promise.resolve(exp.shutdown?.()))
    );
  }

  private trackExport(fn: () => Promise<void> | void): void {
    try {
      const res = fn();
      if (res && typeof (res as Promise<void>).then === "function") {
        const p = (res as Promise<void>)
          .catch(() => {
            // exporter transport failures are isolated from request paths
          })
          .finally(() => {
            this.pendingExports.delete(p);
          });
        this.pendingExports.add(p);
      }
    } catch {
      // ignore synchronous exporter failure
    }
  }
}

/** Runtime wiring: exporter transport failures never affect control-plane operations. */
export function createFactoryTelemetryFromEnv(env: NodeJS.ProcessEnv = process.env): FactoryTelemetry {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  return new FactoryTelemetry({
    serviceName: env.OTEL_SERVICE_NAME ?? "core-api",
    exporters: endpoint ? [new OtlpHttpJsonExporter({ baseUrl: endpoint,
      serviceName: env.OTEL_SERVICE_NAME ?? "core-api" })] : [],
  });
}
