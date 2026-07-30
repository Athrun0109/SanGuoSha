/**
 * 三国杀 MCP server —— 让 Claude Code 直接下场打牌。
 *
 * 三个工具就够了:
 *   new_game   开局,返回规则 + 你的身份 + 第一个待决策
 *   decide     提交编号,引擎跑到下一个属于你的决策点,返回新的题面
 *   look       重新看一眼当前局面(不消耗决策)
 *
 * 所有决策都是同一种题型:从编号列表里挑 k 个。引擎已过滤掉非法动作,
 * 所以选项里出现的都能选,不需要判断"能不能",只需要判断"该不该"。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { GameSession } from './session.js';

import { generalDetail, generalTable } from '../cli/generals.js';

const INSTRUCTIONS = `这是一个三国杀(标准版)对战服务器,你作为其中一名角色下场打牌。

流程:
1. new_game 开一局 —— 返回完整规则、你的身份和武将技能、以及第一个待你决策的问题。
   想指定武将先用 list_generals 看清单,再把名字传给 new_game 的 generals 参数。
2. 每个问题都给一份编号选项,用 decide 提交,例如 {"choice":[0]}。可以放弃时提交 {"choice":[]}。
3. decide 返回后,对手的整个回合已经在后台跑完了,你拿到的是下一个跟你有关的决策点。
4. 一直循环到返回"游戏结束"。

和真人同桌打(new_game 传了 humanSeat)时:
- 对方在另一个终端出牌,速度由他决定。返回里出现"对手正在行动中"是正常的,用 look 再看一次即可,不要重复 decide。
- 你的手牌、你打算怎么走,都不要在回复里写出来 —— 对方看得到你这边的输出。只说公开发生了什么。

要点:
- 引擎已经过滤掉所有非法动作,选项里出现的都合法。只需要判断该不该,不用判断能不能。
- 每次返回都带完整局面快照和记牌器,不需要靠记忆。
- 编号只在当次有效,下一题会重新编号。`;

let session: GameSession | null = null;

const server = new McpServer(
  { name: 'sanguosha', version: '0.1.0' },
  { instructions: INSTRUCTIONS },
);

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

server.registerTool('new_game', {
  title: '开一局三国杀',
  description: '开始新对局。返回规则、你的身份武将、当前局面和第一个待决策问题。会覆盖正在进行的对局。',
  inputSchema: {
    players: z.number().int().min(2).max(8).optional()
      .describe('总人数 2~8,默认 2(1v1 单挑)'),
    seat: z.number().int().min(0).max(7).optional()
      .describe('你坐第几号位,默认 0。0 号位固定是主公'),
    seed: z.number().int().optional().describe('随机种子,同一种子牌局完全一致,便于复盘'),
    codec: z.enum(['verbose', 'anon']).optional()
      .describe('verbose 用武将/卡牌原名;anon 全部代号化,用于排除你对原版规则的先验'),
    generals: z.array(z.string()).optional()
      .describe('手动点将,按座位指定,如 ["关羽","吕布"];留空串表示该位随机。先用 list_generals 看有哪些'),
    handicap: z.number().int().min(0).max(6).optional()
      .describe('后手补牌:0 号位以外每人额外起始手牌数。1v1 默认 +1,用来补偿先手优势'),
    humanSeat: z.number().int().min(0).max(7).optional()
      .describe('真人玩家坐哪个座位。设了之后那个座位不再是电脑,而是等真人在另一个终端 npm run join 接入。不设则其余座位全是规则 AI'),
  },
}, async (args) => {
  try {
    session = new GameSession({
      players: args.players,
      seat: args.seat,
      seed: args.seed,
      codec: args.codec,
      generals: args.generals,
      handicap: args.handicap,
    });
  } catch (e) {
    return text(e instanceof Error ? e.message : String(e));
  }
  await session.settle();
  return text(
    `开局 seed=${session.seed}\n\n` +
    session.render({ withRules: true, withIdentity: true }),
  );
});

server.registerTool('decide', {
  title: '提交决策',
  description: '提交本次选择的编号数组。引擎会一直跑到下一个属于你的决策点(对手回合在此期间跑完),返回新的局面和问题。',
  inputSchema: {
    choice: z.array(z.number().int())
      .describe('选中的选项编号。单选给一个如 [2];放弃给空数组 [];排序类问题按顺序给,如 [2,0]'),
  },
}, async (args) => {
  if (!session) return text('还没有对局,先用 new_game 开一局。');
  if (session.over) return text(session.finalReport());

  const err = session.submit(args.choice);
  if (err) {
    const q = session.question();
    return text(`选择不合法:${err}\n\n${q ?? ''}`);
  }
  await session.settle();
  return text(session.render());
});

server.registerTool('list_generals', {
  title: '查看可选武将',
  description: '列出全部武将及其技能,用于手动点将。给 name 参数则返回该武将的技能详情。',
  inputSchema: {
    name: z.string().optional().describe('武将名,给了就只返回这一个的详情'),
  },
}, async (args) => text(args.name ? generalDetail(args.name) : generalTable()));

server.registerTool('look', {
  title: '查看当前局面',
  description: '重新查看当前局面、记牌器、近期战报和待决策问题。不会改变任何状态。',
  inputSchema: {
    rules: z.boolean().optional().describe('是否连规则一起返回,默认否'),
    identity: z.boolean().optional().describe('是否连你的身份技能一起返回,默认否'),
  },
}, async (args) => {
  if (!session) return text('还没有对局,先用 new_game 开一局。');
  return text(session.render({ withRules: args.rules, withIdentity: args.identity }));
});

const transport = new StdioServerTransport();
await server.connect(transport);
