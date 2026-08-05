import fs from 'node:fs';
let s = fs.readFileSync('README.md', 'utf8');

s = s.split('npm run duel -- --model=deepseek/deepseek-v4-flash\n')
     .join('npm run duel -- --model=deepseek/deepseek-v4-flash-0731\n');

s = s.replace(
  '# A. OpenRouter(便宜,一局约 $0.016)',
  '# A. OpenRouter(便宜,一局约 $0.010)',
);

const oldTable = `\`deepseek/deepseek-v4-flash\` 的实测参数:

| | |
|---|---|
| 上下文 | 1,048,576 |
| 输入 / 输出 | $0.14/M / $0.28/M |
| \`structured_outputs\` | ✓ |
| \`reasoning_effort\` | ✓ |

**成本**:按下面「实测体积」那节的数字估算,一局约 94k 输入 + 9k 输出 tokens,**单局约 $0.016**,$10 大概能打 600+ 局。`;

const newTable = `**默认模型是 \`deepseek/deepseek-v4-flash-0731\`**(2026-07-31 那版)。几个 flash 变体的实测参数:

| 模型 id | 上线 | 输入 | 输出 | structured_outputs | 上下文 |
|---|---|---|---|---|---|
| **\`deepseek/deepseek-v4-flash-0731\`** | 2026-07-31 | **$0.09/M** | **$0.18/M** | ✓ | 1M |
| \`deepseek/deepseek-v4-flash\` | 2026-04-24 | $0.14/M | $0.28/M | ✓ | 1M |
| \`~deepseek/deepseek-v4-flash-latest\` | 滚动别名 | $0.09/M | $0.18/M | ✓ | 1M |

两个坑:不带后缀的 \`deepseek-v4-flash\` **不是滚动别名**,它钉在四月快照(显示名就叫「0423」);真正跟着最新版走的是带 \`~\` 前缀的 \`latest\`。另外 0731 的 \`max_completion_tokens\` 是 65536(0423 是 393216),本项目只用 8192,无影响。

**成本**:按下面「实测体积」那节的数字估算,一局约 94k 输入 + 9k 输出 tokens,0731 的价格下**单局约 $0.010**,$10 大概能打 1000 局。

这些数字都是从 OpenRouter 的模型接口实时查的,自己核对:\`npm run models deepseek\`。`;

if (!s.includes(oldTable)) { console.error('模型表没匹配上'); process.exit(1); }
s = s.replace(oldTable, newTable);
fs.writeFileSync('README.md', s);
console.log('README 更新完成');
