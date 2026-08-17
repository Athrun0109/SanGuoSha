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
  /** 单次请求上限(含读响应体)。默认见 DEFAULT_TIMEOUT_MS —— 它和 maxTokens 必须一起调 */
  timeoutMs?: number;
  /**
   * 供应商偏好。默认 `{ sort: 'throughput' }` —— 见 DEFAULT_PROVIDER。
   * 传 null 可以完全关掉,交回 OpenRouter 自己的默认路由。
   */
  provider?: Record<string, unknown> | null;
  /** 思考深度 → 推理 token 预算。默认见 REASONING_BUDGET;传 null 改回按 effort 走 */
  reasoningBudget?: Record<string, number> | null;
  /** 请求超过 10s 后每 10s 回调一次,用来告诉用户"还在等" */
  onProgress?: (seconds: number) => void;
  /** 打印每次请求的耗时和用量 */
  onUsage?: (info: { ms: number; usage: Record<string, number>; model: string; provider?: string }) => void;
}

const EFFORT_MAP: Record<string, 'low' | 'medium' | 'high'> = {
  low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high',
};

/**
 * 思考深度 → **推理 token 预算**。这是延迟的硬上限。
 *
 * 注意 API 收的是 token 数,不是秒数;而且 OpenRouter 明确规定
 * `reasoning.effort` 和 `reasoning.max_tokens` **只能二选一**。所以这里换算了一道:
 * 按实测吞吐 ~120 tok/s 折算,
 *
 *   low 2400 ≈ 20s | medium 6000 ≈ 50s | high 12000 ≈ 100s
 *
 * 秒数只是估的 —— 不同供应商吞吐差一倍(实测 84~180 tok/s),token 数才是硬的。
 *
 * 为什么需要它:实测有一次决策烧了 11,215 个推理 token、等了 109 秒。根因是选项
 * 里混进了 15 个丈八蛇矛的两两组合(那个已经单独修了),但这类爆炸随时可能从别处
 * 冒出来,所以留一道闸门。传 null 可以关掉,退回按 effort 走。
 */
export const REASONING_BUDGET: Record<string, number> = {
  low: 2400, medium: 6000, high: 12000, xhigh: 12000, max: 12000,
};

/** 见下面 timeoutMs 那段注释:它和 maxTokens 是必须一起动的一对 */
export const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * 供应商路由:**按吞吐排序,优先连得快的节点**。
 *
 * 同一个模型 OpenRouter 会分发给多家供应商,速度差别很大。实测同一局里
 * 单次调用在 20~100 秒之间跳,还出现过等 100 秒返回空正文(finish_reason=null)
 * 的情况 —— 那不是预算问题,是分到了卡住的节点。
 *
 * 这个项目一局要几十次调用,延迟直接决定能不能用;而 DeepSeek flash 本来就便宜,
 * 为速度多付一点完全划算。所以默认按 throughput 排,不按价格。
 */
export const DEFAULT_PROVIDER: Record<string, unknown> = { sort: 'throughput' };

export function createOpenRouterClient(opts: OpenRouterOptions = {}): LLMClient {
  const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('没有 OpenRouter 凭据。设置环境变量 OPENROUTER_API_KEY,或在构造时传 apiKey。');
  }
  const baseUrl = (opts.baseUrl ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '');
  /**
   * 这是**非流式**请求 —— 模型没生成完,一个字节都不会到达(`await res.text()`)。
   * 所以生成耗时全额计入这个超时。
   *
   * 它和 `LLMAgentOptions.maxTokens` 是必须一起动的一对旋钮:预算给到 32768,
   * 模型真吐满就是好几分钟,60 秒必然撞墙 —— 而且撞的正是"模型这次话特别多"
   * 那种情况,也就是最该等一等的情况。以前预算 8192 时它会被截断、失败得很快,
   * 提高预算之后失败姿势从"截断"变成了"超时",是同一件事。
   *
   * 3 分钟看着很长,但对面是重试(共 3 次)和**兜底给规则 AI** —— 兜底损害的是
   * 打法质量,那个损失不出现在账单上,所以宁可等。
   *
   * 真正的解法是流式:那样就能改成"多久没吐出新 token 才算断",
   * 把"模型在认真想"和"连接已经死了"区分开。现在这条路只能二选一。
   */
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const provider = opts.provider === null ? null : (opts.provider ?? DEFAULT_PROVIDER);
  const budgets = opts.reasoningBudget === null ? null : (opts.reasoningBudget ?? REASONING_BUDGET);

  return {
    messages: {
      async create(params: any) {
        const body = toOpenAI({ ...params, provider, reasoningBudget: budgets });
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

        let text = choice.message?.content;
        if (typeof text !== 'string' || !text.trim()) {
          /*
           * 正文为空有**两种完全不同的原因**,别混为一谈:
           *
           *  a) finish_reason === 'length' —— 真的截断了,推理把预算吃光,加预算重试有用。
           *  b) 其它(尤其 null)—— 上游供应商挂了/返回了残缺响应。这跟预算无关,
           *     加预算不但没用,还会让下一次更慢。
           *
           * 这两个曾经共用一句"max_tokens 不够",结果是:一次供应商卡死被报成预算不足,
           * 重试逻辑还老老实实把预算翻倍。诊断错了,补救也会跟着错。
           */
          const salvage = typeof choice.message?.reasoning === 'string'
            ? choice.message.reasoning.trim() : '';
          // 有些供应商会把整个回答塞进 reasoning 而 content 留空。
          // 里面要是有 JSON,上层的 extractJson 能捞出来 —— 白捡一次成功,不试白不试。
          if (salvage.includes('{') && salvage.includes('}')) {
            text = salvage;
          } else if (choice.finish_reason === 'length') {
            throw new Error(
              `返回的正文为空(finish_reason=length,推理占了 ${reasoningTokens || '?'} tokens` +
              ` —— max_tokens(${body.max_tokens})不够,加大预算重试)`);
          } else {
            throw new Error(
              `上游返回了空正文(finish_reason=${choice.finish_reason}` +
              `,推理 ${reasoningTokens} tokens,耗时 ${Math.round((Date.now() - t0) / 1000)}s)` +
              ` —— 这不是预算问题,多半是供应商卡住或掉线`);
          }
        }
        // OpenRouter 会告诉你这次实际是谁服务的。要对比路由改动有没有效,就看这个字段
        const served = typeof json.provider === 'string' ? json.provider : undefined;
        opts.onUsage?.({ ms: Date.now() - t0, usage, model: json.model ?? body.model, provider: served });

        return {
          content: [{ type: 'text', text }],
          usage,
          provider: served,
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

  // 供应商偏好。OpenRouter 专有字段,别的后端看不懂,所以只在这一层加
  if (params.provider) out.provider = params.provider;

  const schema = params.output_config?.format?.schema;
  if (schema) {
    out.response_format = {
      type: 'json_schema',
      json_schema: { name: 'decision', strict: true, schema },
    };
  }
  const effort = params.output_config?.effort;
  if (effort) {
    // 二选一:有 token 预算就用它(硬上限),否则退回 effort 三档
    const budget = params.reasoningBudget?.[effort];
    if (budget) {
      out.reasoning = { max_tokens: budget };
      // 文档要求:整体 max_tokens 必须严格大于推理预算,否则正文没地方写
      if (typeof out.max_tokens === 'number' && out.max_tokens <= budget) {
        out.max_tokens = budget * 2;
      }
    } else if (EFFORT_MAP[effort]) {
      out.reasoning = { effort: EFFORT_MAP[effort] };
    }
  }

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
