/**
 * OpenRouter 客户端 —— 用 DeepSeek / Gemini / Llama 等模型来打牌。
 *
 * OpenRouter 走的是 OpenAI 兼容协议,和 Anthropic 的报文格式不一样。
 * 这里把它包装成 LLMAgent 依赖的那个 `LLMClient` 接口,所以 **agent 本身一行都不用改** ——
 * 提示词分层、滚动战报、记牌器、代号化、兜底逻辑全部照旧,只是换了个后端。
 *
 * 报文映射:
 *   system 块数组      → messages[0] 的 system 消息(拼接;cache_control 丢掉,OpenRouter 自己管缓存)
 *   output_config.format → response_format: {type:'json_schema', json_schema:{strict:true, schema}}
 *   output_config.effort → reasoning: {effort}   (xhigh/max 收敛到 high,OpenRouter 只有三档)
 *   choices[0].message   → content:[{type:'text'}]
 *   usage.prompt_tokens  → input_tokens(缓存命中读 prompt_tokens_details.cached_tokens)
 */

import type { LLMClient } from './llmAgent.js';

export interface OpenRouterOptions {
  /** 默认读环境变量 OPENROUTER_API_KEY */
  apiKey?: string;
  baseUrl?: string;
  /** OpenRouter 用来做应用归因的可选头 */
  appUrl?: string;
  appTitle?: string;
  /** 单次请求上限(含读响应体)。默认 60s —— 一局要几十次调用,卡太久不如早点失败重试 */
  timeoutMs?: number;
  /** 请求超过 10s 后每 10s 回调一次,用来告诉用户"还在等" */
  onProgress?: (seconds: number) => void;
  /** 打印每次请求的耗时和用量 */
  onUsage?: (info: { ms: number; usage: Record<string, number>; model: string }) => void;
}

const EFFORT_MAP: Record<string, 'low' | 'medium' | 'high'> = {
  low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high',
};

export function createOpenRouterClient(opts: OpenRouterOptions = {}): LLMClient {
  const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('没有 OpenRouter 凭据。设置环境变量 OPENROUTER_API_KEY,或在构造时传 apiKey。');
  }
  const baseUrl = (opts.baseUrl ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '');
  const timeoutMs = opts.timeoutMs ?? 60_000;

  return {
    messages: {
      async create(params: any) {
        const body = toOpenAI(params);
        const ctl = new AbortController();
        // 超时必须一直罩到**读完响应体**为止。
        // 只罩 fetch() 是不够的 —— 它在收到响应头时就 resolve 了,
        // 服务端随后把 body 卡住的话,await res.text() 会永远等下去。
        const timer = setTimeout(() => ctl.abort(), timeoutMs);
        const t0 = Date.now();
        // 请求久了给个动静,免得看起来像死机
        const ticker = opts.onProgress
          ? setInterval(() => opts.onProgress!(Math.round((Date.now() - t0) / 1000)), 10_000)
          : null;

        let raw: string;
        let res: Response;
        try {
          res = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            signal: ctl.signal,
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${apiKey}`,
              ...(opts.appUrl ? { 'HTTP-Referer': opts.appUrl } : {}),
              ...(opts.appTitle ? { 'X-Title': opts.appTitle } : {}),
            },
            body: JSON.stringify(body),
          });
          raw = await res.text();
        } catch (e) {
          if (e instanceof Error && (e.name === 'AbortError' || ctl.signal.aborted)) {
            throw new Error(`请求超时(${Math.round(timeoutMs / 1000)}s 没读完响应)`);
          }
          throw e;
        } finally {
          clearTimeout(timer);
          if (ticker) clearInterval(ticker);
        }

        if (!res.ok) throw new Error(`OpenRouter ${res.status}:${trim(raw)}`);

        let json: any;
        try { json = JSON.parse(raw); } catch { throw new Error(`返回不是 JSON:${trim(raw)}`); }
        // OpenRouter 有时把错误塞在 200 里
        if (json.error) throw new Error(`OpenRouter 报错:${json.error.message ?? trim(raw)}`);

        const choice = json.choices?.[0];
        if (!choice) throw new Error(`返回里没有 choices:${trim(raw)}`);

        const u = json.usage ?? {};
        const reasoningTokens = u.completion_tokens_details?.reasoning_tokens ?? 0;
        const usage = {
          input_tokens: u.prompt_tokens ?? 0,
          output_tokens: u.completion_tokens ?? 0,
          cache_read_input_tokens: u.prompt_tokens_details?.cached_tokens ?? 0,
          reasoning_tokens: reasoningTokens,
        };

        const text = choice.message?.content;
        if (typeof text !== 'string' || !text.trim()) {
          // 最常见的一种失败:带 reasoning 的模型把 max_tokens 全花在思考上,
          // 正文一个字都没吐出来。说清楚是这种情况,调用方才知道该加预算而不是换模型。
          const ate = reasoningTokens > 0 || choice.message?.reasoning;
          throw new Error(
            `返回的正文为空(finish_reason=${choice.finish_reason}` +
            (ate ? `,推理占了 ${reasoningTokens || '?'} tokens —— max_tokens 不够` : '') + ')',
          );
        }
        opts.onUsage?.({ ms: Date.now() - t0, usage, model: json.model ?? body.model });

        return {
          content: [{ type: 'text', text }],
          usage,
          // OpenAI 系没有 refusal 这个 stop_reason,内容政策拒绝会以 finish_reason 体现
          stop_reason: choice.finish_reason === 'content_filter' ? 'refusal' : choice.finish_reason,
        };
      },
    },
  };
}

/** 把 Anthropic 形状的请求翻译成 OpenAI 形状 */
export function toOpenAI(params: any): Record<string, unknown> {
  const systemText = Array.isArray(params.system)
    ? params.system.map((b: any) => b.text).filter(Boolean).join('\n\n')
    : (params.system ?? '');

  const messages = [
    ...(systemText ? [{ role: 'system', content: systemText }] : []),
    ...(params.messages ?? []).map((m: any) => ({
      role: m.role,
      content: typeof m.content === 'string'
        ? m.content
        : (m.content ?? []).map((b: any) => b.text ?? '').join('\n'),
    })),
  ];

  const out: Record<string, unknown> = {
    model: params.model,
    messages,
    max_tokens: params.max_tokens,
  };

  const schema = params.output_config?.format?.schema;
  if (schema) {
    out.response_format = {
      type: 'json_schema',
      json_schema: { name: 'decision', strict: true, schema },
    };
  }
  const effort = params.output_config?.effort;
  if (effort && EFFORT_MAP[effort]) out.reasoning = { effort: EFFORT_MAP[effort] };

  return out;
}

const trim = (s: string) => (s.length > 300 ? s.slice(0, 300) + '…' : s);

/** 便捷构造:直接得到一个用 OpenRouter 驱动的 agent */
export async function createOpenRouterAgent(
  id: string,
  agentOpts: Omit<import('./llmAgent.js').LLMAgentOptions, 'client'> = {},
  clientOpts: OpenRouterOptions = {},
) {
  const { LLMAgent } = await import('./llmAgent.js');
  return new LLMAgent(id, { ...agentOpts, client: createOpenRouterClient(clientOpts) });
}
