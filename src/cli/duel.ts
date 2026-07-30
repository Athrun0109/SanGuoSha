/**
 * 1v1 单挑:主公 vs 反贼,其中一方(或双方)由大模型操盘。
 *
 * 后端二选一,靠模型名自动判断(OpenRouter 的 id 一律是「厂商/型号」),也可以 --provider 强制:
 *   npm run duel                                          Anthropic + claude-opus-5
 *   npm run duel -- --model=deepseek/deepseek-v4-flash     OpenRouter + DeepSeek
 *
 * 其它开关:
 *   --both                双方都由模型打
 *   --human               你上场对模型
 *   --effort=medium       思考深度(默认 low)
 *   --codec=anon          代号化,屏蔽模型对原版三国杀的先验
 *   --rounds=5            战报只回溯 5 轮
 *   --generals=关羽,吕布    手动点将(留空位表示随机,如 ",吕布")
 *   --handicap=0          关掉后手补牌
 *   --seed=42 --quiet     固定牌局 / 不打印模型的推理
 */

import { loadEnv } from './env.js';
loadEnv();

import '../content/cards.js';
import '../content/generals.js';
import { createGame, parseGeneralSpec, DUEL_HANDICAP } from '../core/setup.js';
import { BasicAI } from '../ai/basicAI.js';
import { LLMAgent, type DecisionInfo } from '../ai/llmAgent.js';
import { HumanAgent, closeCli } from './humanAgent.js';
import { ROLE_NAME } from '../core/types.js';
import type { Agent } from '../core/agent.js';

function flag(name: string): string | undefined {
  const hit = process.argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : '';
}

async function main() {
  const both = flag('both') !== undefined;
  const human = flag('human') !== undefined;
  const quiet = flag('quiet') !== undefined;
  const effort = (flag('effort') ?? 'low') as any;
  const codec = (flag('codec') ?? 'verbose') as 'verbose' | 'anon';
  const historyRounds = Number(flag('rounds') ?? 10);
  const seed = Number(flag('seed') ?? Math.floor(Math.random() * 1e9));

  const modelArg = flag('model');
  const provider = flag('provider')
    ?? (modelArg?.includes('/') ? 'openrouter'
      : process.env.OPENROUTER_API_KEY && !process.env.ANTHROPIC_API_KEY ? 'openrouter'
        : 'anthropic');
  const model = modelArg
    ?? (provider === 'openrouter' ? 'deepseek/deepseek-v4-flash' : 'claude-opus-5');

  const handicapArg = flag('handicap');
  const handicap = handicapArg === undefined ? DUEL_HANDICAP : Number(handicapArg);

  let fixedGenerals: Record<number, string> | undefined;
  try {
    fixedGenerals = parseGeneralSpec(flag('generals'), 2);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
    return;
  }

  const credHint = provider === 'openrouter'
    ? '  Windows:  set OPENROUTER_API_KEY=sk-or-...\n' +
      '  Bash:     export OPENROUTER_API_KEY=sk-or-...\n' +
      '  可用模型: npm run models deepseek'
    : '  set ANTHROPIC_API_KEY=sk-ant-...\n  或安装 ant CLI 后执行 ant auth login';

  let client: any;
  try {
    if (provider === 'openrouter') {
      const { createOpenRouterClient } = await import('../ai/openrouterClient.js');
      client = createOpenRouterClient({
        appTitle: 'sanguosha-engine',
        onProgress: (sec) => console.log(`  \x1b[90m⏳ 等待模型响应 ${sec}s…\x1b[0m`),
      });
    } else {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      client = new Anthropic();
    }
  } catch (e) {
    console.error(`无法初始化 ${provider} 客户端:`, e instanceof Error ? e.message : e);
    console.error('\n请先配置凭据:\n' + credHint);
    process.exitCode = 1;
    return;
  }

  // 先探一下路:凭据、网络、模型名有问题就立刻失败,而不是整局都在兜底
  try {
    await client.messages.create({
      model, max_tokens: 16,
      messages: [{ role: 'user', content: '回复 OK' }],
    });
  } catch (e) {
    console.error(`调用 ${provider}(${model})失败:`, e instanceof Error ? e.message : e);
    console.error('\n请检查凭据和模型名:\n' + credHint);
    process.exitCode = 1;
    return;
  }

  const show = (info: DecisionInfo) => {
    if (quiet) return;
    const tag = info.usedFallback
      ? `\x1b[31m兜底 ← ${info.error ?? '未知原因'}\x1b[0m`
      : `\x1b[36m${info.thinking}\x1b[0m`;
    console.log(`  [${info.agentId}] ${tag}`);
  };

  const llmAgents: LLMAgent[] = [];
  const makeLLM = (id: string) => {
    const a = new LLMAgent(id, { client, model, effort, codec, historyRounds, onDecision: show });
    llmAgents.push(a);
    return a;
  };

  const who = provider === 'openrouter' ? (model.split('/')[1] ?? model) : model;
  console.log(`\n三国杀 · 1v1 单挑  |  ${provider}:${model}  effort=${effort} codec=${codec} 回溯${historyRounds}轮  seed=${seed}`);
  console.log(both ? `${who} vs ${who}`
    : human ? `你(0号位) vs ${who}(1号位)`
      : `${who}(0号位) vs 规则AI(1号位)`);
  console.log('');

  const game = createGame({
    playerCount: 2,
    seed,
    fixedGenerals,
    startingHand: [4, 4 + handicap],
    log: (m) => console.log(m),
    makeAgent: (p, i): Agent => {
      if (both) return makeLLM(`llm-${i}`);
      if (human) return i === 0 ? new HumanAgent('you') : makeLLM('llm');
      return i === 0 ? makeLLM('llm') : new BasicAI('rule');
    },
  });

  for (const p of game.players) {
    console.log(`[${p.seat}] ${p.general.name} ${p.maxHp}血 起手${p.handCount}张 身份:${ROLE_NAME[p.role]}`);
  }
  if (handicap > 0) console.log(`(后手补牌 +${handicap},用于补偿先手优势)`);

  const t0 = Date.now();
  const res = await game.setupAndRun();

  console.log('\n最终局面:');
  console.log(game.board(true));
  console.log(`\n用时 ${((Date.now() - t0) / 1000).toFixed(1)}s,共 ${game.turnCount} 回合`);

  for (const a of llmAgents) {
    const s = a.stats;
    console.log(
      `  ${a.id}:${s.calls} 次调用,兜底 ${s.fallbacks} 次,` +
      `单次载荷均 ${s.calls ? Math.round(s.payloadChars / s.calls) : 0} 字符,` +
      `输入 ${s.inputTokens}(缓存命中 ${s.cacheReadTokens})/ 输出 ${s.outputTokens} tokens`,
    );
  }
  closeCli();
}

main().catch(e => { console.error(e); closeCli(); process.exit(1); });
