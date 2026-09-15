import { CloudflareProvider } from '../../server/src/providers/cloudflare.js';
import type { CompletionOptions } from '../../server/src/providers/base.js';
import type { ChatMessage, ChatCompletionResponse, ChatCompletionChunk } from '@freellmapi/shared/types.js';
import { extendedBodyParams, resolveMaxTokens } from '../../server/src/lib/sampling-params.js';
import { contentToString } from '../../server/src/lib/content.js';
import { extractThinkFromMessage } from '../../server/src/lib/think-tags.js';

export const NATIVE_AI_KEY = 'native:workers-ai';
export interface AiBinding {
  run(model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>): Promise<any>;
}

export class NativeCloudflareProvider extends CloudflareProvider {
  constructor(private ai: AiBinding) { super(); }
  override async validateKey(key: string, context?: any) {
    // Binding health means the binding is installed, not that inference quota
    // is available. Inference errors still flow through upstream cooldown logic.
    return key === NATIVE_AI_KEY ? true : super.validateKey(key, context);
  }
  private inputs(messages: ChatMessage[], options?: CompletionOptions) {
    return {
      messages: messages.map(m => ({ ...m, content: contentToString(m.content) })),
      max_tokens: resolveMaxTokens('cloudflare', options?.max_tokens),
      temperature: options?.temperature, top_p: options?.top_p, stop: options?.stop,
      tools: options?.tools, tool_choice: options?.tool_choice,
      parallel_tool_calls: options?.parallel_tool_calls,
      ...extendedBodyParams('cloudflare', options),
    };
  }
  private async run(model: string, inputs: Record<string, unknown>, options?: CompletionOptions) {
    options?.signal?.throwIfAborted();
    const timeout = this.timeoutFor(model, options?.timeoutMs);
    const deadline = new AbortController();
    const timer = timeout > 0 ? setTimeout(() => deadline.abort(new DOMException('Workers AI timed out', 'TimeoutError')), timeout) : undefined;
    const signal = options?.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
    try {
      return await this.ai.run(model, inputs, { signal });
    } catch (error: any) {
      // Preserve the status when provided by the binding; never turn every
      // failure into an authentication error (which would disable the key).
      if (error && !error.status && error.httpStatus) error.status = error.httpStatus;
      throw error;
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }
  override async chatCompletion(key: string, messages: ChatMessage[], model: string, options?: CompletionOptions, context?: any): Promise<ChatCompletionResponse> {
    if (key !== NATIVE_AI_KEY) return super.chatCompletion(key, messages, model, options, context);
    const data = await this.run(model, { ...this.inputs(messages, options), stream: false }, options);
    if (!data || (typeof data.response !== 'string' && !Array.isArray(data.choices) && !Array.isArray(data.tool_calls))) throw new Error('Invalid Workers AI completion');
    const result: ChatCompletionResponse = data.choices ? data : {
      id: `chatcmpl-${crypto.randomUUID()}`, object: 'chat.completion',
      created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, message: { role: 'assistant', content: data.response ?? '', ...(data.tool_calls ? { tool_calls: normalizeToolCalls(data.tool_calls) } : {}) }, finish_reason: data.tool_calls?.length ? 'tool_calls' : 'stop' }],
      ...(data.usage ? { usage: data.usage } : {}),
    };
    for (const choice of result.choices) extractThinkFromMessage(choice.message);
    result._routed_via = { platform: 'cloudflare', model };
    return result;
  }
  override async *streamChatCompletion(key: string, messages: ChatMessage[], model: string, options?: CompletionOptions, context?: any): AsyncGenerator<ChatCompletionChunk> {
    if (key !== NATIVE_AI_KEY) { yield* super.streamChatCompletion(key, messages, model, options, context); return; }
    const stream = await this.run(model, { ...this.inputs(messages, options), stream: true }, options);
    if (!(stream instanceof ReadableStream)) throw new Error('Workers AI did not return a stream');
    // Older Workers AI models emit {response}; newer models emit OpenAI chunks.
    // Convert frames, then reuse upstream SSE parsing, stalls and think tags.
    yield* this.readSseStream(new Response(normalizeAiStream(stream, model)), { firstByteTimeoutMs: this.timeoutFor(model, options?.timeoutMs) });
  }
}

export function normalizeAiStream(stream: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const id = `chatcmpl-${crypto.randomUUID()}`;
  let pending = '';
  let legacy = false;
  let legacyTools = false;
  let finished = false;
  const chunk = (delta: any, finish: string | null = null, usage?: any) => ({
    id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}),
  });
  const emit = (line: string, controller: TransformStreamDefaultController<Uint8Array>) => {
    if (!line.startsWith('data:')) return;
    const raw = line.slice(5).trim();
    if (!raw) return;
    if (raw === '[DONE]') {
      if (legacy && !finished) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk({}, legacyTools ? 'tool_calls' : 'stop'))}\n\n`));
      finished = true;
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      return;
    }
    const data = JSON.parse(raw);
    if (data.error) throw new Error('Workers AI stream error');
    const mapped = data.choices ? data : chunk({ content: data.response ?? '', ...(data.tool_calls ? { tool_calls: normalizeToolCalls(data.tool_calls) } : {}) }, null, data.usage);
    legacy ||= !data.choices;
    legacyTools ||= !data.choices && Boolean(data.tool_calls?.length);
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(mapped)}\n\n`));
  };
  return stream.pipeThrough(new TransformStream({
    transform(bytes, controller) {
      pending += decoder.decode(bytes, { stream: true });
      let index: number;
      while ((index = pending.indexOf('\n')) >= 0) {
        emit(pending.slice(0, index).replace(/\r$/, ''), controller);
        pending = pending.slice(index + 1);
      }
    },
    flush(controller) {
      pending += decoder.decode();
      if (pending.trim()) emit(pending.trim(), controller);
      if (legacy && !finished) {
        throw new Error('Workers AI stream ended before completion');
      }
    },
  }));
}

function normalizeToolCalls(calls: any[]) {
  return calls.map((call, index) => call.function ? call : ({
    id: call.id ?? `call_${crypto.randomUUID()}`, index, type: 'function' as const,
    function: { name: call.name, arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}) },
  }));
}
