# 三国杀 · 标准版规则引擎

纯文本、零运行时依赖的三国杀标准版复刻。重点在**引擎和技能系统**——没有美术资源,命令行就能打完整的一局身份局。

```bash
npm install
npm start                 # 启动向导:选模式、填 API key、选模型、点将,一路问下来
```

或者直接用命令:

```bash
npm run play              # 5 人局,你坐 0 号位,其余 AI
npm run play 8 3          # 8 人局,你坐 3 号位
npm run play -- --pick    # 开局前交互式点将
npm run play -- --generals=关羽,,吕布   # 直接指定(留空位表示随机)
npm run play -- 5 -1      # 观战模式:全 AI 自动打一局

npm run sim 300 8         # 跑 300 局 8 人局,输出身份/武将胜率
npm run generals          # 列出全部武将;加武将名看技能详情
npm test                  # 规则单元测试
```

想让大模型下场打,最简单的是 `npm start` 走向导。手动的话三条路任选:

```bash
# A. OpenRouter(便宜,一局约 $0.016)
set OPENROUTER_API_KEY=sk-or-...
npm run duel -- --model=deepseek/deepseek-v4-flash

# B. Anthropic API
set ANTHROPIC_API_KEY=sk-ant-...
npm run duel

# C. 不用 API key,让 Claude Code 通过 MCP 直接下场(见 MCP 一节)
```

## 启动向导

```bash
npm start
```

一路问下来就能开局:

1. **玩什么** —— 我 vs 规则AI / 我 vs 大模型 / 大模型 vs 规则AI(观战) / 大模型互搏(观战) / 全 AI 观战
2. **大模型设置**(只在需要时问)—— **默认走 OpenRouter**。已有 `OPENROUTER_API_KEY` 就直接用(显示成 `sk-or-…abcd`),没有就现场输入 —— **输入时不回显**,可以选择存进 `.env` 下次免输。
   然后从**实时拉取的模型列表**里选,只列支持 `structured_outputs` 的(本项目靠它保证返回合法 JSON),按价格排序、DeepSeek 优先;也可以手输任意模型 id。选完立刻发一个探路请求验证 key 和模型对不对。
3. **人数 / 座位 / 手动点将 / 随机种子 / 模型思考深度**

涉及大模型的模式一律按 1v1 开局,省钱也好观察。拉不到模型列表(比如断网)会退回一份内置清单,不至于卡住。

`.env` 已加进 `.gitignore`。`npm run play`、`npm run duel`、`npm run join` 也都会读它,所以几种启动方式行为一致。

## 对局中随时查看局势

**任何一次选择,0 号永远是「查看局势」**,真正的选项从 1 开始编号:

```
※ 出牌阶段,选一个动作
   0. 查看局势
   1. 无中生有[♥7]
   2. 青龙偃月刀[♠5]
   3. 麒麟弓[♥5]
   ...
   6. 结束出牌阶段
   (需选 1 个)
```

输 0 会打印全场信息然后**重新问一遍**,不消耗行动、不推进牌局,想看几次看几次:

```
──────────────────────────────────────────────────────────────────
 座位  武将    势力 身份  体力        手牌  装备 / 判定区
→[0]  曹操　　魏   主公　　♥♥♥♥♥       6    -
 [1]  郭嘉　　魏   ??　　♥♥♥         4    -   距你1
 [2]  张辽　　魏   ??　　♥♥♥♥        4    -   距你1
你的攻击范围 1   手牌上限 5   牌堆剩余 92
```

后面还跟着你的手牌全文、技能说明和记牌器。所有需要你做选择的地方都有这个 0 号(要不要出闪、弃哪几张牌、观星怎么排……),`npm run join`(和 Claude Code 同桌时)也一样。

## 已实现的内容

| | 内容 |
|---|---|
| 牌堆 | 106 张,基本牌 53 / 锦囊 35 / 装备 18 |
| 基本牌 | 杀、闪、桃 |
| 锦囊 | 过河拆桥、顺手牵羊、决斗、无中生有、南蛮入侵、万箭齐发、桃园结义、五谷丰登、借刀杀人、无懈可击、乐不思蜀、闪电 |
| 装备 | 诸葛连弩、雌雄双股剑、青釭剑、青龙偃月刀、丈八蛇矛、贯石斧、方天画戟、麒麟弓、八卦阵、仁王盾、±1 马各三匹 |
| 武将 | 标准包 25 将全员(魏7 蜀7 吴8 群3),含主公技护驾/激将/救援 |
| 模式 | 2~8 人身份局,含主公 +1 体力、击杀反贼摸三张、主公误杀忠臣弃牌 |
| 规则 | 完整的时机/响应链:无懈可击可无限连环、濒死按座次依次求桃、判定可被鬼才替换、目标可被流离转移 |

## 架构

```
src/
  core/
    types.ts      花色、实体牌、虚拟牌(转化技的产物)
    events.ts     ★ 所有时机(Timing)与事件对象的定义
    skill.ts      ★ 技能的四种形态 + 查询表(状态技能改的那些规则杠杆)
    game.ts       引擎主体:回合流程、用牌结算、伤害、判定、濒死
    agent.ts      决策接口(人和 AI 共用同一套)
    registry.ts   卡牌/武将注册表
    setup.ts      开局:身份分配、发牌
  content/
    cards.ts      ★ 每张牌的行为 + 牌堆配比 DECK_TABLE
    generals.ts   ★ 25 名武将的技能定义
  ai/
    basicAI.ts          规则型 AI
    choiceAgent.ts      ★ 把 8 个决策方法统一成"从编号里挑 k 个"
    llmAgent.ts         调 API 让模型打牌(后端无关)
    openrouterClient.ts OpenRouter 适配层(OpenAI 兼容协议)
    rulesPrompt.ts      四层提示词(规则/身份/局面/问题)
    codec.ts            verbose ↔ anon 转译层
    cardCounter.ts      记牌器
  mcp/
    session.ts     把引擎的 await 翻转成可拉取的决策
    server.ts      MCP server,给 Claude Code 用
    humanSeat.ts   本地 socket,让真人和 Claude 同桌
  cli/             人机对战、批量模拟、1v1 单挑、武将清单/点将
  test/            规则 + LLM 链路 + MCP 端到端,全部离线可跑
```

引擎的骨架是一个**带优先级的事件总线**。一次【杀】的完整流程:

```
CardUsing → CardUsed → TargetConfirming(流离改目标) → TargetConfirmed(铁骑/雌雄)
  → 无懈可击响应链 → invalidToTarget 查询(仁王盾) → CardEffecting
  → 求【闪】(AskingForCard → 八卦阵/护驾可代答) → SlashMissed(青龙刀/贯石斧)
  → DamageInflicting(裸衣加伤) → DamageDone(奸雄/反馈/刚烈/遗计) → DamageDealt(麒麟弓)
  → 濒死 Dying(急救) → 依次求【桃】→ Died(奖惩)
```

技能不碰引擎,只往时机上挂回调。所以加一个新武将 = 往 `generals.ts` 里加一个对象,不需要改任何其它文件。

## DIY 改技能

四种技能形态,`src/core/skill.ts` 里有完整注释:

- **triggered** 触发技 —— 在某个时机发动(奸雄、遗计、连营)
- **active** 主动技 —— 出牌阶段主动点(制衡、苦肉、离间)
- **viewAs** 转化技 —— 把牌当另一张牌用(武圣、龙胆、倾国)
- **static** 状态技 —— 通过查询表改规则(马术、咆哮、空城、无双)

### 例:削弱郭嘉的遗计(改成每回合限一次)

```ts
triggered({
  name: '遗计',
  limit: 'once-per-turn',        // ← 就加这一行
  timing: 'DamageDone',
  ...
})
```

### 例:加强黄月英的集智(锦囊摸两张)

```ts
async effect({ game, self }) { await game.drawCards(self, 2, '集智'); },
//                                                     ↑ 1 改成 2
```

### 例:重做张辽的突袭(改成拿两张但要弃一张)

`effect` 是普通的 async 函数,能用 `game` 上的全部原子操作:
`drawCards / discardCards / gainCards / damage / recover / loseHp / judge / useCard /
askForCard / askForUse / askForDiscard / moveCards`,以及 `agentOf(p).chooseXxx()` 系列询问。

### 例:给状态技加一个新的规则杠杆

`static` 技能通过命名查询影响规则,现有的杠杆(`attackRange` / `distanceDelta` /
`maxHand` / `slashLimit` / `extraDodge` / `extraSlash` / `prohibitTarget` /
`ignoreDistance` / `ignoreArmor` / `invalidToTarget` / `skipDiscard` / `noSlashLimit`
/ `peachRecover` / `slashExtraTargets`)都在 `skill.ts` 顶部列着。想加新的,
在那里加个名字,然后在 `game.ts` 对应位置调一次 `sumQuery` / `anyQuery` 即可。

### 改完怎么验证

```bash
npm test                  # 先确认没改坏规则
npm run sim 500 8         # 再看胜率变化
```

`npm run sim` 会输出每名武将的登场胜率。改一个技能前后各跑 500 局对比,比拍脑袋准得多。
注意样本噪声:8 人局单个武将 500 局大约只有 100 场登场,±5% 属于正常波动。

## 接入 LLM(1v1 单挑)

`LLMAgent` 和 `BasicAI`、`HumanAgent` 实现同一个 `Agent` 接口,引擎不知道对面是模型还是规则 AI。

### 用 OpenRouter + DeepSeek V4 Flash

最省钱的一条路。先拿到 OpenRouter 的 key,然后:

```bash
# Windows(cmd)
set OPENROUTER_API_KEY=sk-or-...
# PowerShell
$env:OPENROUTER_API_KEY="sk-or-..."
# Git Bash / Linux / macOS
export OPENROUTER_API_KEY=sk-or-...

npm run duel -- --model=deepseek/deepseek-v4-flash
```

**模型名带 `/` 会被自动识别成 OpenRouter**,不用额外指定后端。如果你只设了 `OPENROUTER_API_KEY` 没设 `ANTHROPIC_API_KEY`,直接 `npm run duel` 也会默认走 OpenRouter + DeepSeek V4 Flash。

开局前会先发一个探路请求 —— 凭据、网络、模型名有问题会**立刻退出并打印具体错误**,不会整局都在静默兜底。

先看看有哪些模型能用:

```bash
npm run models deepseek     # 按关键词过滤,列出价格和是否支持结构化输出
npm run models              # 常见几家全列出来
```

这个命令不需要 API key(OpenRouter 的模型列表是公开的)。输出里带 ✓ 的支持 `structured_outputs` —— **本项目靠它保证模型返回合法 JSON,建议优先选带 ✓ 的**。

`deepseek/deepseek-v4-flash` 的实测参数:

| | |
|---|---|
| 上下文 | 1,048,576 |
| 输入 / 输出 | $0.14/M / $0.28/M |
| `structured_outputs` | ✓ |
| `reasoning_effort` | ✓ |

**成本**:按下面「实测体积」那节的数字估算,一局约 94k 输入 + 9k 输出 tokens,**单局约 $0.016**,$10 大概能打 600+ 局。

### 用 Anthropic API

```bash
set ANTHROPIC_API_KEY=sk-ant-...     # 或安装 ant CLI 后 ant auth login
npm run duel                          # 默认 claude-opus-5
npm run duel -- --model=claude-sonnet-5
```

### 通用开关

```bash
npm run duel -- --both --effort=medium   # 模型互搏,思考深度调高
npm run duel -- --human --seed=42        # 你上场,固定牌局便于复现
npm run duel -- --codec=anon             # 代号化(DIY 过技能后建议开)
npm run duel -- --rounds=5 --quiet       # 战报只回溯 5 轮 / 不打印推理
npm run duel -- --generals=关羽,吕布       # 手动点将
npm run duel -- --handicap=0             # 关掉后手补牌
npm run duel -- --provider=openrouter    # 强制后端(一般用不到,靠模型名自动判断)
```

`--effort` 在两个后端上都有效:Anthropic 支持 `low/medium/high/xhigh/max`,OpenRouter 只有三档,`xhigh`/`max` 会收敛到 `high`。

### 换后端为什么不用改 agent

`LLMAgent` 依赖的只是一个很小的接口(`messages.create`),所以接一个新后端 = 写一个实现该接口的客户端。提示词分层、滚动战报、记牌器、代号化、兜底逻辑全部照旧。

`openrouterClient.ts` 做的报文映射:

```
system 块数组         → messages[0] 的 system 消息(拼接)
output_config.format  → response_format: {type:'json_schema', strict:true}
output_config.effort  → reasoning: {effort}
choices[0].message    → content:[{type:'text'}]
usage.prompt_tokens   → input_tokens(缓存命中读 prompt_tokens_details.cached_tokens)
```

另外 `LLMAgent` 的 JSON 解析是**宽松**的:即使模型裹了 ` ```json ` 围栏或前面加了句废话也能抠出来,不会因为一个围栏就退到兜底 AI。测试里让假模型每次都裹围栏,验证整局能打完且零兜底。

### 一个动作会拆成几次决策

引擎按决策点逐个问,不会把「出什么牌 + 打谁 + 拆哪张」打包成一次:

```
1. 出牌阶段选动作        → 问模型
2. 为这张牌选目标        → 只有一个合法目标时自动跳过,不浪费一次调用
3. 对方是否出【无懈可击】 → 问对方(他手上有无懈才会被问到)
4. 对方是否出【闪】/【杀】 → 同上
5. 拆/顺走对方哪个区域的牌 → 问模型
```

所以日志里看到「选完牌直接就打出去了」通常不是跳过了交互,而是那一步只有唯一合法解。

### 重试与兜底

调用失败时会**重试最多 3 次**(退避 0.4s / 0.8s),仍失败才把这一次决策交给规则 AI。三类错误区别对待:

| 情况 | 处理 |
|---|---|
| 网络抖动、超时、5xx | 重试(每次重试都会打印出来,不静默) |
| 正文被推理 token 吃光(`finish_reason=length`) | **把 `max_tokens` 翻倍**再重试 —— 带 reasoning 的模型最常见的失败 |
| 401/403/404、凭据缺失、模型名错 | 不重试,直接兜底(重试多少次都一样) |

兜底时界面上会**红字显示失败原因**,而不是只写一句"兜底":

```
  [llm] 兜底 ← 返回的正文为空(finish_reason=length,推理占了 8000 tokens —— max_tokens 不够)
```

`max_tokens` 默认 8192。DeepSeek 这类会先输出一大段 reasoning 的模型,4096 很容易被吃光导致正文为空,可以用 `LLMAgentOptions.maxTokens` 再调大。

单次请求超时 **60 秒**,且**一直罩到响应体读完为止** —— 只罩 `fetch()` 是不够的,它在收到响应头时就 resolve 了,服务端随后把 body 卡住就会永远等下去。请求超过 10 秒会每 10 秒打一行 `⏳ 等待模型响应 Ns…`,不至于看起来像死机。

### 提示词分四层

```
L0 规则       永不变      → system[0]        1200~1700 字符
L1 本局身份   一局不变    → system[1] 缓存断点
L2 局面       每次重建    ┐
L3 近期战报   滚动窗口    ├→ 每次决策唯一的一条 user 消息,850 字符左右
L4 问题+选项  每次重建    ┘
```

两条设计原则:

**规则里不写合法性。** 引擎已经算好合法动作集,选项列表**就是**合法动作全集,模型不可能出非法牌。所以"杀每回合限一次""顺手牵羊距离1""空城不能被指定"这类规则一律删掉,只留后果和数值 —— 模型需要的是"打出去会怎样",不是"能不能打"。

**L2 必须自足。** 只看当前局面就能做出不离谱的决策,战报只用来推测意图。这样滚动窗口丢掉旧战报也不会让模型失能。

### 不累积对话

每次决策只发一条 user 消息,不保留历史对话。原因:

- 每条消息里都带完整局面快照,保留旧消息 = 让模型看一堆**过期的**局面,既费 token 又干扰判断。
- 猜身份需要的是全局累计信息,而这个已经压进 L2 的**交手记录**(谁对谁造成过多少伤害,从第 1 回合起累计,只占一行),不需要为此保留几十轮原始战报。
- 单条消息 → 每次调用成本恒定,不随对局变长而增长,也不怕 5 分钟缓存过期。

代价是丢掉模型自己的推理连续性,用「你最近的判断」(回带最近 4 条 thinking)补回来。战报默认回溯 10 轮、封顶 30 行,并过滤掉轮次分隔/摸牌/弃牌上限这些能从快照反推的噪声行。

### 记牌器

`cardCounter.ts`,人和 LLM 共用(`npm run play` 的面板里也有)。

**每次从当前状态推导,绝不累加**——因为牌堆用尽时弃牌堆会整个洗回去,任何"已出现牌"的累计计数都会在那一刻失效,而从区域内容推导的结果会自动跟着变。

```
未知牌池 = 牌堆 + 其他人的暗置手牌
某牌未现身数 = 配比总数 − 弃牌堆 − 结算区 − 所有装备区 − 所有判定区
                        − 你的手牌 − 已公开的他人手牌
```

"已公开的他人手牌"指五谷取走的、反间展示的、天妒/洛神拿走的判定牌、奸雄拿走的伤害牌 —— 引擎用 `revealToAll()` 登记,牌一移动就自动失效。给出的估算包括每张牌的未现身数,以及用超几何分布算的"某人手上至少有一张闪/杀/桃"的概率。

### 代号化(`--codec=anon`)

把武将、卡牌、技能全换成 `P0` `S` `w4` `K3`,**连"三国杀"三个字都不出现**。

省的 token 有限(中文常用字大多 1 token,`杀`换成`S`省 0),真正的理由是:**一旦你 DIY 改过技能,武将名带来的预训练先验就从资产变成负债** —— 模型会按记忆里的原版推理,而且错得很自信。anon 模式强制它只读你写的技能文本。

有个测试专门扫所有提示词里有没有漏出原名(`anon 模式下提示词里不出现任何武将名或牌名`)。它已经抓到过两次泄漏:规则里"杀死 lord"的动词用字,以及开头的游戏名本身。

### 实测体积

假客户端跑完整局量出来的(字符数,不是 token;要精确值得用 `count_tokens` 实测):

| | system | 决策次数 | 单次载荷 | 全局传输 |
|---|---|---|---|---|
| verbose 1v1 | 1229 | 45 | 均 861 / 峰 1107 | 94k 字符 |
| anon 1v1 | 1157 | 45 | 均 746 / 峰 950 | 86k |
| verbose 8人 | 1663 | 27 | 均 1055 / 峰 1358 | 73k |
| anon 8人 | 1546 | 27 | 均 899 / 峰 1169 | 66k |

改造前是累积对话式的,同一局全局传输约 396k 字符 —— 现在是 94k,而且**不随对局长度增长**。

## 1v1 的公平性:后手补牌

先手优势在 1v1 里非常大。规则 AI 互打的实测(每档 3000 局):

| 后手补牌 | 先手(主公)胜率 | 偏离 |
|---|---|---|
| 不补 | 61.0% | +11.0 |
| **+1 张(默认)** | **53.1% ± 1.8** | **+3.1** |
| +2 张 | 45.4% ± 1.8 | −4.6 |

**一张起始牌大约值 6~8 个百分点**,真正的平衡点落在 +1 和 +2 之间,+1 更近一些,所以设为默认。加上补牌后 600 局复测是 51.0% / 49.0%。

也试过"先手首回合不摸牌"这个杠杆,但它一下值 18 个百分点(61.0% → 42.8%),粒度太粗,直接矫枉过正了。

```bash
npm run duel -- --handicap=0    # 关掉补牌,回到原始规则
npm run sim 800 2 --handicap=2  # 自己扫别的档位
```

**两个必须说清楚的前提:**

1. **这个标定是基于当前这个规则 AI 的。** 换更强的对手(比如接上 LLM),先手优势的大小会变,应该重新扫一遍。`--handicap` 就是为此留的。
2. **手动点将会破坏这个数字。** 默认情况下 0 号位只从曹操/刘备/孙权里随机,而这三个的主公技在 1v1 里全废(护驾/激将/救援都要队友),等于先手本来就自带减益。一旦你手动把 0 号位点成吕布,+1 张远远不够补。

引擎侧的原语是 `startingHand`(数字 = 所有人相同,数组 = 按座位指定),`--handicap=N` 只是它在 1v1 上的一层包装。

## 手动点将

用于测试特定武将、复现对局、或者摆一个你想验证的组合。

```bash
npm run generals              # 看清单
npm run generals 诸葛亮        # 看某个武将的技能详情

npm run play -- --pick                    # 交互式:逐个座位问你点谁
npm run play -- --generals=关羽,,吕布       # 留空位 = 该位随机
npm run duel -- --generals=,貂蝉           # 1v1 也一样
```

交互式点将里可以输编号或武将名,`?` 重列清单,`名字??` 看详情,直接回车随机。

**点将会覆盖主公武将池** —— 0 号位默认只从三个有主公技的武将里出,点将之后不受限制,任意武将都能当主公。没指定的座位仍然随机分配且不重复。

MCP 那边对应的是 `list_generals` 工具和 `new_game` 的 `generals` / `handicap` 参数,所以让 Claude Code 打的时候也能说"你打诸葛亮,我看看观星怎么用"。


## 让 Claude Code 下场打(MCP)

如果你只有 Max 订阅、没有 API key,就走这条路 —— 把游戏做成 MCP server,Claude Code 连上来当玩家。

项目根目录已经有 `.mcp.json`,在这个目录里启动 Claude Code 就会自动发现 `sanguosha` 服务器。然后直接说:

> 开一局 1v1,你打关羽,我看着

### 三个工具

| 工具 | 作用 |
|---|---|
| `new_game` | 开局。返回完整规则 + 你的身份武将 + 局面 + 第一个待决策。参数:`players` `seat` `seed` `codec` `generals` `handicap` `humanSeat` |
| `decide` | 提交编号数组。引擎跑到下一个属于你的决策点,返回新题面 |
| `list_generals` | 列出可选武将 / 查单个武将技能详情,用于点将 |
| `look` | 重看当前局面,不消耗决策 |

### 控制反转

引擎是个跑到底的 async 循环,轮到你决策时会 `await`;MCP 是请求/响应。做法是 `McpAgent` 在被问到时**挂起一个 Promise**,存下题面就返回;`decide` 调用时兑现它,引擎随之继续跑,直到下一个属于你的决策点或者游戏结束。

对手的整个回合、技能结算、别人濒死求桃,全都在两次工具调用之间跑完 —— 你只会被问到跟你有关的事。所以打完一局 1v1 大约 40~50 次 `decide`。

### 和 API 模式共用同一套呈现

`LLMAgent`(调 API)和 `McpAgent`(等 Claude Code 提交)都继承 `ChoiceAgent`,那 8 个 `Agent` 方法只实现了一份。所以两种驱动方式下,模型看到的题面、选项措辞、编号语义**完全一致**,换驱动不会改变模型看到的东西。

`codec: "anon"` 在 MCP 下同样可用 —— 这在这里格外有意义,因为 Claude Code 自己就知道三国杀,不代号化的话它会按记忆里的原版规则推理你 DIY 过的技能。

### 实际长什么样

```
问题 出牌阶段,选一个动作
0:出 诸葛连弩[♦A]
1:出 杀[♣9]
2:出 南蛮入侵[♠K]
...
6:出 杀[♦A](武圣)
9:结束出牌阶段
选1个

用 decide 工具提交,例如 {"choice":[0]}
```

转化技(武圣把红牌当杀)已经被引擎展开成独立选项,所以模型不需要自己推导有哪些出法。

### 和真人同桌打

默认除了 Claude 那一个座位,其余全是规则 AI —— 所以你只是旁观。要自己下场,开局时指定 `humanSeat`:

> 开一局 1v1,你坐 0 号位打关羽,我坐 1 号位打诸葛亮

Claude 会调 `new_game({players:2, seat:0, humanSeat:1, generals:["关羽","诸葛亮"]})`,返回里带端口。然后你在**另一个终端**:

```bash
npm run join
```

之后就是正常轮流出牌:引擎问到谁谁才动,Claude 打出【杀】会停下来等你出【闪】。你只看得到自己的手牌、所有人的公开状态、记牌器和公开战报;对手的手牌不会发过来。Claude 那边看到"对手正在行动中"是正常的,它用 `look` 再看一次即可。

> **一个绕不开的限制:Claude Code 会把工具的输入输出显示给你,所以 Claude 的手牌你是看得见的。**
> 引擎的信息模型是对的(两边互相看不到),泄漏发生在终端显示这一层。想真正盲打,要么把 Claude Code 那个窗口收起来别看,要么走 API 那条路(`npm run duel -- --human`),那边 Claude 的手牌不会出现在你的终端里。

### 手动启动

```bash
npm run mcp        # stdio,给别的 MCP 客户端用
```

7 个端到端测试真的把 server 当子进程拉起来走 stdio 打完整局,验证的就是 `.mcp.json` 里那条启动命令。


## 当前的 AI 水平

`BasicAI` 是规则型的,只用公开信息(主公身份、伤害记录、存活/手牌数/装备),不偷看手牌和身份。
它靠"谁打过主公"来推测反贼,靠"谁打过已暴露的反贼"来推测忠臣。

300 局实测胜率:

```
8 人局   主公/忠臣 35.3%   反贼 57.0%   内奸 6.7%
5 人局   主公/忠臣 52.3%   反贼 24.0%   内奸 23.3%
1v1     主公 51.0%        反贼 49.0%     (已含默认的后手补牌 +1)
```

真实对局里主忠方大约 40%、反贼 50%、内奸 10%,所以**这个 AI 目前偏向反贼**——
主要短板是主忠方不会协作(不会集火同一个反贼、不会用仁德/桃主动保主公)。
要提升主要改三处,`basicAI.ts` 顶部有注释:`attitude()` 身份推测、`CARD_VALUE` 牌价值表、
`scoreAction()` 出牌决策。引擎本身是纯函数式的,想换成蒙特卡洛搜索或自对弈也接得上。

## 已知的简化

- **借刀杀人**按"1 个目标 + 效果内选被杀者"实现,官方是 2 个目标。差别只在无懈可击的指向上。
- **过河拆桥/顺手牵羊/反馈**选择对方手牌时按"随机抽一张"处理(手牌是暗置的,效果等价)。
- **反间**里对方选牌同样按随机处理。
- 判定区的延时锦囊按后进先出结算。
- 【闪电】绕场一圈发现所有人判定区都已经有闪电时,这里是**弃置**;官方规则是留在原处等下一轮。牌堆只有 2 张闪电,实际几乎碰不到。

## 已知问题

- **MCP 的 `humanSeat` 没生效**。`new_game` 传了 `humanSeat` 之后本地 socket 没起来,`npm run join` 会 ECONNREFUSED。
  已确认是 `mcp/server.ts` 那一侧的接线问题(`GameSession` 本身是好的,`humanSeat.test.ts` 4 个测试都过),**还没修**。
  在修好之前,人机同桌请走 `npm run duel -- --human`。

## 关于平局

**三国杀规则上打不出平局**,能打出来说明是引擎的保护栏被触发了。`game.ts` 里只有两处会判平局:

1. `setupAndRun()` 的 `guard < 500` —— 回合数超上限。纯粹是防死循环的兜底,触发原因是规则 AI 双方都过于保守、谁也不动手。**这是 AI 的问题,不是规则的**。8 人局约 2.5% 会碰到。
2. `reshuffle()` 里牌堆和弃牌堆同时为空 —— 所有牌都在玩家手上/装备区。官方规则没写这种情况,200 局出现 1 次左右。

真要修第一条,应该做成"到 N 轮后强制进入死斗状态",而不是判平局。

## 关于版权

规则和代码都是自己写的,但官方的武将立绘、卡面、音效有版权,自用没问题,别公开分发带原素材的版本。
现在整个项目不含任何美术资源。
