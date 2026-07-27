// packages/kernel/src/workflow-runtime/structured-generation.ts
import { timestamp } from '../tracing.js';
import type { CapabilityTraceSink } from '../tracing.js';
import { parseValidatedJson } from './json-output.js';
import type { JsonValidator } from './json-output.js';
import type { ModelMessage, ModelProvider, ModelResponse } from '../model-gateway/types.js';

export type StructuredGenerationAttempt = { attempt: number; rawText?: string; error?: string };

export type StructuredGenerationResult<T> =
  | { ok: true; value: T; rawText: string; attempts: StructuredGenerationAttempt[] }
  | { ok: false; error: string; attempts: StructuredGenerationAttempt[] };

export type GenerateStructuredOptions<T> = {
  capabilityId: string;
  model: ModelProvider;
  validate: JsonValidator<T>;
  system?: string;
  messages?: ModelMessage[];
  userPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  maxAttempts?: number;
  trace?: CapabilityTraceSink;
  signal?: AbortSignal;
};

const STRICT_SUFFIX = '\n\nReturn ONLY valid JSON - no prose, no markdown fences.';

export async function generateStructured<T>(
  options: GenerateStructuredOptions<T>,
): Promise<StructuredGenerationResult<T>> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 2);
  const baseMessages = normalizeMessages(options);
  const attempts: StructuredGenerationAttempt[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    options.signal?.throwIfAborted();
    const messages = attempt === 1 ? baseMessages : appendStrictSuffix(baseMessages);
    let response: ModelResponse;
    try {
      response = await options.model.complete({
        system: options.system,
        messages,
        maxTokens: options.maxTokens,
        temperature: options.temperature,
        signal: options.signal,
      });
    } catch (error) {
      if (isAbortError(error) || options.signal?.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      attempts.push({ attempt, error: message });
      return { ok: false, error: message, attempts };
    }

    if (response.usage) {
      options.trace?.emit({
        type: 'model_usage', capabilityId: options.capabilityId,
        provider: options.model.id, model: response.model ?? options.model.defaultModel ?? 'unknown',
        inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens,
        estimated: response.usage.estimated, timestamp: timestamp(),
      });
    }

    const rawText = response.content
      .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text).join('');
    const parsed = parseValidatedJson(rawText, options.validate);
    if (parsed.ok) {
      attempts.push({ attempt, rawText });
      return { ok: true, value: parsed.value, rawText, attempts };
    }
    attempts.push({ attempt, rawText, error: parsed.error });
    if (attempt < maxAttempts) {
      options.trace?.emit({ type: 'warning', capabilityId: options.capabilityId, message: `structured generation validation failed attempt ${attempt}: ${parsed.error}`, timestamp: timestamp() });
    }
  }

  const error = attempts[attempts.length - 1]?.error ?? 'structured generation failed';
  options.trace?.emit({ type: 'error', capabilityId: options.capabilityId, message: error, timestamp: timestamp() });
  return { ok: false, error, attempts };
}

function normalizeMessages<T>(options: GenerateStructuredOptions<T>): ModelMessage[] {
  if (options.messages?.length) return [...options.messages];
  if (options.userPrompt !== undefined) return [{ role: 'user', content: options.userPrompt }];
  throw new Error('generateStructured requires messages or userPrompt');
}

function appendStrictSuffix(messages: ModelMessage[]): ModelMessage[] {
  const next = [...messages];
  for (let i = next.length - 1; i >= 0; i -= 1) {
    const msg = next[i]!;
    if (msg.role === 'user' && typeof msg.content === 'string') {
      next[i] = { ...msg, content: `${msg.content}${STRICT_SUFFIX}` };
      return next;
    }
  }
  next.push({ role: 'user', content: STRICT_SUFFIX.trim() });
  return next;
}

function isAbortError(error: unknown): boolean {
  return (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError');
}
