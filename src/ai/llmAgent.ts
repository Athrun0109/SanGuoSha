/**
 * 用 Claude 来打三国杀。
 *
 * 请求结构(每次决策一发,不累积对话):
 *
 *   system[0]  规则         永不变,命中缓存
 *   system[1]  本局身份      一局不变,缓存断点
 *   messages   [L2 局面 + L3 近期战报 + 你最近的判断 + L4 问题选项]   ← 唯一的一条 user 消息
 *
 * 为什么不用累积对话:
 *  - 每条 user 消息里都带了完整局面快照,保留旧消息等于让模型看一堆**过期的**局面,
 *    既费 token 又干扰判断。
 *  - 猜身份需要的是全局累计信息,而这个已经被压进 L2 的「交手记录」了(从第 1 回合起累计,
 *    只占一行),不需要为此保留几十轮原始战报。
 *  - 单条消息 → 每次调用成本恒定,不随对局变长而增长,也不怕 5 分钟缓存过期。
 *
 * 代价是丢掉模型自己的推理连续性,用「你最近的判断」(最近几次 thinking)补回来。
 * 所有决策统一成"从编号列表里挑 k 个",所以只有一个 schema、一条解析路径、一处兜底。
 */

import type { Agent } from '../core/agent.js';
import type { Game } from '../core/game.js';
import type { Player } from '../core/player.js';
import { BasicAI } from './basicAI.js';
import { ChoiceAgent, validateChoice } from './choiceAgent.js';
import type { CodecMode } from './codec.js';
import {
  buildRules, eventsBlock, filterLog, identityBlock, questionBlock, situationBlock,
} from './rulesPrompt.js';

/** 只依赖这一点点接口,方便测试时注入假客户端 */
export interface LLMClient {
  messages: {
    create(params: any): Promise<{
      content: Array<{ type: string; text?: string }>;
      usage?: Record<string, number>;
      stop_reason?: string;
    }>;
  };
}

export interface LLMAgentOptions {
  client: LLMClient;
  model?: string;
  /** 思考深度。决策频繁、要求响应快,默认 low */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxTokens?: number;
  /** verbose 保留武将/卡牌原名;anon 全部代号化(DIY 过技能后建议用 anon) */
  codec?: CodecMode;
  /** 战报回溯几轮 */
  historyRounds?: number;
  /** 战报最多几行(过滤掉噪声行之后再计数) */
  maxLogLines?: number;
  /** 回带几条自己最近的推理 */
  selfNotes?: number;
  fallback?: Agent;
  onDecision?: (info: DecisionInfo) => void;
}

export interface DecisionInfo {
  agentId: string;
  prompt: string;
  options: string[];
  thinking: string;
  choice: number[];
  usedFallback: boolean;
  /** 兜底时的失败原因 —— 界面上要显示出来,否则只看到一句"兜底"根本没法定位 */
  error?: string;
  /** 本次 user 消息的字符数,用于估算提示词体积 */
  payloadChars: number;
  usage?: Record<string, number>;
}

/** 重试也没用的错误:凭据、模型名、权限 */
const PERMANENT_ERROR = /40[134]|凭据|OPENROUTER_API_KEY|ANTHROPIC_API_KEY|not found|No auth|invalid.*key/i;
/** 正文被推理 token 吃光导致的截断 —— 加大预算重试通常就好了 */
const TRUNCATED_ERROR = /正文为空|没有文本内容|length/i;

const DECISION_SCHEMA = {
  type: 'object',
  properties: {
    thinking: { type: 'string', description: '简短中文推理' },
    choice: { type: 'array', items: { type: 'integer' }, description: '选中的选项编号' },
  },
  required: ['thinking', 'choice'],
  additionalProperties: false,
} as const;

export class LLMAgent extends ChoiceAgent {
  readonly id: string;

  private o: Required<Omit<LLMAgentOptions, 'client' | 'fallback' | 'onDecision'>>;
  private client: LLMClient;
  protected fallback: Agent;
  protected codecMode: CodecMode;
  private onDecision?: (info: DecisionInfo) => void;

  private system: any[] | null = null;
  private notes: string[] = [];
  private lastError = '';
  private errorRepeats = 0;

  stats = {
    calls: 0, fallbacks: 0, payloadChars: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
  };

  constructor(id: string, opts: LLMAgentOptions) {
    super();
    this.id = id;
    this.client = opts.client;
    this.fallback = opts.fallback ?? new BasicAI(`${id}-fallback`);
    this.onDecision = opts.onDecision;
    this.o = {
      model: opts.model ?? 'claude-opus-5',
      effort: opts.effort ?? 'low',
      maxTokens: opts.maxTokens ?? 8192,
      codec: opts.codec ?? 'verbose',
      historyRounds: opts.historyRounds ?? 10,
      maxLogLines: opts.maxLogLines ?? 30,
      selfNotes: opts.selfNotes ?? 4,
    };
    this.codecMode = this.o.codec;
  }

  // ————————————————— 提示词组装 —————————————————

  private ensureSystem(game: Game, self: Player) {
    if (this.system) return this.system;
    const c = this.c(game);
    this.system = [
      { type: 'text', text: buildRules(c) },
      { type: 'text', text: identityBlock(game, self, c), cache_control: { type: 'ephemeral' } },
    ];
    return this.system;
  }

  /** 滚动战报:最近 N 轮,再按行数封顶 */
  private recentLog(game: Game): string[] {
    const firstRound = Math.max(1, game.round - this.o.historyRounds + 1);
    const from = game.roundStartLine[firstRound] ?? 0;
    return filterLog(game.logLines.slice(from)).slice(-this.o.maxLogLines);
  }

  /** 返回 null 表示这次没成功,交给兜底 AI */
  protected async decide(
    game: Game, self: Player, question: string, options: string[], min: number, max: number,
  ): Promise<number[] | null> {
    const system = this.ensureSystem(game, self);
    const c = this.c(game);

    const parts = [situationBlock(game, self, c)];
    const ev = eventsBlock(this.recentLog(game), c);
    if (ev) parts.push(ev);
    if (this.notes.length) parts.push(`你最近的判断\n${this.notes.map(n => '- ' + n).join('\n')}`);
    parts.push(questionBlock(question, options, min, max, c));
    const payload = parts.join('\n\n');

    const messages: any[] = [{ role: 'user', content: payload }];
    let choice: number[] | null = null;
    let thinking = '';
    let usage: Record<string, number> | undefined;

    let budget = this.o.maxTokens;
    let lastErr = '';

    for (let attempt = 0; attempt < 3 && choice === null; attempt++) {
      try {
        const res = await this.client.messages.create({
          model: this.o.model,
          max_tokens: budget,
          system,
          messages,
          output_config: {
            effort: this.o.effort,
            format: { type: 'json_schema', schema: DECISION_SCHEMA },
          },
          cache_control: { type: 'ephemeral' },
        });
        this.stats.calls++;
        usage = res.usage;
        if (usage) {
          this.stats.inputTokens += usage.input_tokens ?? 0;
          this.stats.outputTokens += usage.output_tokens ?? 0;
          this.stats.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
        }
        if (res.stop_reason === 'refusal') throw new Error('模型拒绝了该请求');

        const text = res.content.find(b => b.type === 'text')?.text;
        if (!text) throw new Error('响应中没有文本内容');
        const parsed = extractJson(text);
        thinking = String(parsed.thinking ?? '');
        const raw = Array.isArray(parsed.choice) ? parsed.choice : [];
        const err = validateChoice(raw, options.length, min, max);
        if (err) {
          messages.push({ role: 'assistant', content: text });
          messages.push({ role: 'user', content: `选择不合法:${err}。重新只回一个 JSON。` });
          continue;
        }
        choice = raw.map(Number);
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
        // 凭据/模型名这类错误重试多少次都一样,直接放弃
        if (PERMANENT_ERROR.test(lastErr)) break;
        // 正文被推理 token 挤空了 —— 加大预算再来一次,这是最常见的一种失败
        if (TRUNCATED_ERROR.test(lastErr)) budget = Math.min(budget * 2, 32000);
        if (attempt < 2) {
          // 重试必须让人看见。静默重试 + 长超时 = 看起来像死机。
          game.log(`  ※ ${this.id} 第 ${attempt + 1} 次调用失败(${lastErr}),重试中…`);
          await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
        }
      }
    }

    if (choice === null && lastErr) {
      // 同一条错误只详细报一次,但原因会一直跟着每次兜底(见 DecisionInfo.error)
      if (lastErr !== this.lastError) {
        this.lastError = lastErr;
        this.errorRepeats = 0;
        game.log(`  ※ ${this.id} 调用模型失败(${lastErr}),本次改用规则 AI`);
      } else if (++this.errorRepeats % 10 === 0) {
        game.log(`  ※ ${this.id} 同一错误已连续 ${this.errorRepeats} 次:${lastErr}`);
      }
    }

    this.stats.payloadChars += payload.length;
    if (choice === null) this.stats.fallbacks++;
    else if (thinking) {
      this.notes.push(thinking);
      if (this.notes.length > this.o.selfNotes) this.notes.shift();
    }

    this.onDecision?.({
      agentId: this.id, prompt: question, options, thinking,
      choice: choice ?? [], usedFallback: choice === null,
      error: choice === null ? (lastErr || '模型连续给出不合法的选择') : undefined,
      payloadChars: payload.length, usage,
    });
    return choice;
  }

}

/**
 * 宽松地把模型输出解析成决策对象。
 *
 * 走 Anthropic structured outputs 时返回的一定是纯 JSON,直接 parse 就行;
 * 但换到别的后端(OpenRouter 上的各种模型)未必那么规矩 —— 可能裹 ```json 围栏、
 * 可能前面带一句废话。这里做最小限度的容错,免得为了一个围栏就退到兜底 AI。
 */
export function extractJson(text: string): { thinking?: string; choice?: unknown } {
  const tryParse = (s: string) => {
    try { return JSON.parse(s); } catch { return null; }
  };
  const direct = tryParse(text.trim());
  if (direct) return direct;

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const v = tryParse(fenced[1].trim());
    if (v) return v;
  }
  // 退而求其次:抓第一个到最后一个花括号之间的内容
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a >= 0 && b > a) {
    const v = tryParse(text.slice(a, b + 1));
    if (v) return v;
  }
  throw new Error(`无法从响应里解析出 JSON:${text.slice(0, 120)}`);
}

/** 用官方 SDK 建一个 agent;没有凭据时抛错,由调用方决定怎么办 */
export async function createClaudeAgent(id: string, opts: Omit<LLMAgentOptions, 'client'> = {}) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic() as unknown as LLMClient;
  return new LLMAgent(id, { ...opts, client });
}
