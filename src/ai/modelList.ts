/**
 * OpenRouter 的公开模型列表。**不需要 API key** —— 这个接口是公开的,
 * 所以设置页可以在还没配凭据的时候就把可选模型列出来。
 *
 * 抽出来是因为终端向导和网页设置页要用同一份:两边各拉一次、各自过滤,
 * 迟早会出现"命令行里能选的模型网页上没有"这种对不上。
 */

export interface ModelInfo {
  id: string;
  ctx: number;
  /** 每百万 token 的价格,美元 */
  inPrice: number;
  outPrice: number;
  /** 支持 structured_outputs —— 本项目靠它保证模型返回合法 JSON */
  structured: boolean;
}

/** 兜底清单:拉不到列表时用(比如断网)。至少让人能开局 */
export const FALLBACK_MODELS: ModelInfo[] = [
  { id: 'deepseek/deepseek-v4-flash-0731', ctx: 1048576, inPrice: 0.09, outPrice: 0.18, structured: true },
  { id: 'deepseek/deepseek-v4-flash', ctx: 1048576, inPrice: 0.14, outPrice: 0.28, structured: true },
  { id: 'deepseek/deepseek-v4-pro', ctx: 1048576, inPrice: 0.435, outPrice: 0.87, structured: true },
];

export function pickRecommended(all: ModelInfo[], n = 8): ModelInfo[] {
  // 只推荐支持 structured_outputs 的 —— 本项目靠它保证模型返回合法 JSON
  const ok = all.filter(m => m.structured);
  const deepseek = ok.filter(m => m.id.startsWith('deepseek/')).sort((a, b) => a.inPrice - b.inPrice);
  const rest = ok.filter(m => !m.id.startsWith('deepseek/')).sort((a, b) => a.inPrice - b.inPrice);
  const out: ModelInfo[] = [];
  for (const m of [...deepseek, ...rest]) {
    if (out.length >= n) break;
    out.push(m);
  }
  return out;
}

export async function fetchModels(): Promise<ModelInfo[]> {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models');
    if (!res.ok) return FALLBACK_MODELS;
    const data = (await res.json() as any).data ?? [];
    return data.map((m: any): ModelInfo => ({
      id: m.id,
      ctx: m.context_length ?? 0,
      inPrice: Number(m.pricing?.prompt ?? 0) * 1e6,
      outPrice: Number(m.pricing?.completion ?? 0) * 1e6,
      structured: (m.supported_parameters ?? []).includes('structured_outputs'),
    }));
  } catch {
    return FALLBACK_MODELS;
  }
}
