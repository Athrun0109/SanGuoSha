/**
 * 开局前的探路请求:凭据、网络、模型名,一次验完。
 *
 * 有它才不会"整局都在静默兜底"—— key 打错的话第一秒就该知道,而不是打到一半
 * 发现每一步都是规则 AI 在走。
 *
 * ——— 为什么 max_tokens 给到 2048 ———
 *
 * 这里原本写的是 16("够回一个 OK 就行了")。带推理的模型会先烧一大段思考
 * token,正文一个字都还没吐就撞上 finish_reason=length,于是探路失败、报
 * "max_tokens 不够",而凭据其实完全正常。**探路本身把好模型误判成坏的**,
 * 这比不探路还糟。
 *
 * 给宽不花钱:max_tokens 是上限不是预留,只按实际生成的 token 计费。
 * 再叠一层 effort=low 把思考压到最短。
 */

export const PREFLIGHT_MAX_TOKENS = 2048;

export interface PreflightResult {
  ok: boolean;
  ms: number;
  error?: string;
}

/** 探一次路。**不抛异常** —— 失败也是一种结果,调用方按 ok 分支处理 */
export async function preflight(client: any, model: string): Promise<PreflightResult> {
  const t0 = Date.now();
  try {
    await client.messages.create({
      model,
      max_tokens: PREFLIGHT_MAX_TOKENS,
      messages: [{ role: 'user', content: '回复 OK' }],
      output_config: { effort: 'low' },
    });
    return { ok: true, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
  }
}
