/**
 * 查 OpenRouter 上有哪些模型可用(不需要 API key,模型列表是公开的)。
 *
 *   npm run models              列出常见的几家
 *   npm run models deepseek     只看名字里含 deepseek 的
 *   npm run models -- --json    输出原始 JSON
 */

const KEY = process.argv.slice(2).filter(a => !a.startsWith('--'))[0] ?? '';
const asJson = process.argv.includes('--json');

const price = (v: string | undefined) =>
  v === undefined ? '?' : `$${(Number(v) * 1e6).toFixed(3)}/M`;

const res = await fetch('https://openrouter.ai/api/v1/models');
if (!res.ok) {
  console.error('取模型列表失败:', res.status, await res.text());
  process.exit(1);
}
const all = (await res.json() as any).data ?? [];

const hits = KEY
  ? all.filter((m: any) => m.id.toLowerCase().includes(KEY.toLowerCase()))
  : all.filter((m: any) => /^(deepseek|anthropic|google|openai|meta-llama|qwen|x-ai)\//.test(m.id));

if (asJson) {
  console.log(JSON.stringify(hits, null, 2));
} else {
  console.log(`共 ${hits.length} 个${KEY ? `(含「${KEY}」)` : ''}\n`);
  console.log('模型 id'.padEnd(42) + '上下文'.padEnd(12) + '输入'.padEnd(14) + '输出'.padEnd(14) + '结构化输出');
  for (const m of hits.sort((a: any, b: any) => a.id.localeCompare(b.id))) {
    const structured = (m.supported_parameters ?? []).includes('structured_outputs') ? '✓' : '—';
    console.log(
      m.id.padEnd(42) +
      String(m.context_length ?? '?').padEnd(12) +
      price(m.pricing?.prompt).padEnd(14) +
      price(m.pricing?.completion).padEnd(14) +
      structured,
    );
  }
  console.log('\n带 ✓ 的支持 structured_outputs —— 本项目靠它保证模型返回合法 JSON,建议优先选。');
}

export {};
