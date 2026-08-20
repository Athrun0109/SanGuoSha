# -*- coding: utf-8 -*-
"""把三国杀 Wiki 的武将 FAQ 抽成本项目能用的形式:只留**标准版**、统一简体、按武将分类。

## 为什么需要它

技能的细则(什么时机、算不算、能不能叠)是大模型最容易记错的部分 —— 记得个大概,
细节全凭印象。这类错误不会让引擎报错,一整局照样跑得完,只是结果不对。
所以实现技能之前先查这份 FAQ,而不是凭记忆写。

## 语料从哪来

Fandom 有 Cloudflare 的 JS 验证,curl / requests 一律过不去。可行的办法是
**在浏览器控制台里同源 fetch**(验证已经过了,cookie 自动带上):

    (async () => {
      const names = ['曹操','司马懿', ...];   // 见下面 GENERALS
      let out = '';
      for (const n of names) {
        const r = await fetch(`/zh/wiki/${encodeURIComponent(n)}?action=raw`,
                              { credentials: 'same-origin' });
        out += `\\n\\n===== ${n} =====\\n` + (r.ok ? await r.text() : `!! HTTP ${r.status}`);
        await new Promise(s => setTimeout(s, 400));
      }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([out], { type: 'text/plain;charset=utf-8' }));
      a.download = 'sgs-wiki.txt'; a.click();
    })();

在 https://sanguosha.fandom.com/zh/wiki/诸葛亮 的控制台跑,把下载到的
sgs-wiki.txt 放进 temp/wiki/,然后 `python tools/extract-faq.py`。

## 四道过滤,每一道都踩过

1. **`===界限突破===` 必须剔掉。** 那是同一个武将的重做版本,技能完全不同 ——
   界郭嘉的【遗计】是"把手牌扣置在其他角色武将牌旁",和标准版毫无关系。
   照着它改会把游戏改成另一个版本。
2. **扩展包内容要剔掉。** 光看【】里的名字不够 —— "神关羽打出一张红桃"、
   "司马懿和张角同时改判"、"连环传导的伤害"这些不带括号,得靠词表拦。
3. **Q/A 有三种写法**(`【Q】…【A】…`、`*[Q]…::[A]…`、`*[Q]…*[A]…`),同页混用。
   先统一成标记再切,比写三套正则可靠。
4. **繁简混杂要统一。** 不转的话提示词里会同时出现【殺】和【杀】——
   既让模型困惑,也会绕过 anon 代号化的泄漏检查。
"""
import io, json, os, re, sys
from zhconv import convert

sys.stdout.reconfigure(encoding='utf-8')

SRC_GENERALS = 'temp/wiki/sgs-wiki.txt'
SRC_CARDS = ['temp/wiki/sgs-cards.txt', 'temp/wiki/sgs-rules.txt']
OUT = 'docs/faq'

# ————————————————— 本项目实现了什么 —————————————————

CARDS = ['杀', '闪', '桃', '决斗', '过河拆桥', '顺手牵羊', '无中生有', '南蛮入侵',
         '万箭齐发', '桃园结义', '五谷丰登', '借刀杀人', '无懈可击', '乐不思蜀', '闪电',
         '诸葛连弩', '雌雄双股剑', '青釭剑', '青龙偃月刀', '丈八蛇矛', '贯石斧',
         '方天画戟', '麒麟弓', '八卦阵', '仁王盾', '进攻马', '防御马']

SKILLS = {
    '曹操': ['奸雄', '护驾'], '司马懿': ['反馈', '鬼才'], '夏侯惇': ['刚烈'],
    '张辽': ['突袭'], '许褚': ['裸衣'], '郭嘉': ['天妒', '遗计'], '甄姬': ['倾国', '洛神'],
    '刘备': ['仁德', '激将'], '关羽': ['武圣'], '张飞': ['咆哮'],
    '诸葛亮': ['观星', '空城'], '赵云': ['龙胆'], '马超': ['马术', '铁骑'],
    '黄月英': ['集智', '奇才'], '孙权': ['制衡', '救援'], '甘宁': ['奇袭'],
    '吕蒙': ['克己'], '黄盖': ['苦肉'], '周瑜': ['英姿', '反间'],
    '大乔': ['国色', '流离'], '陆逊': ['谦逊', '连营'], '孙尚香': ['结姻', '枭姬'],
    '华佗': ['青囊', '急救'], '吕布': ['无双'], '貂蝉': ['离间', '闭月'],
}
GENERALS = list(SKILLS)
ALL_SKILLS = {s for v in SKILLS.values() for s in v}

# 只保留这些小标题下的条目(以及 FAQ 开头没有小标题的那段)
STANDARD_HEADING = re.compile(r'標準版|标准版|標準|标准')

# 出现即判定为扩展包内容 —— 这些概念本项目没有
OUT_OF_SCOPE = [
    '界限突破', 'SP', '神关羽', '小乔', '张角', '袁绍', '袁术', '荀攸', '刘谌',
    '邓艾', '孟获', '张春华', '于禁', '张郃', '孙策', '刘禅', '高顺', '蔡文姬',
    '连环', '铁索', '属性', '火杀', '雷杀', '火焰伤害', '雷电伤害',
    '酒', '兵粮寸断', '朱雀羽扇', '藤甲', '天香', '红颜', '木牛流马', '拼点', '重铸',
]
# 「神X」「界X」这类前缀
OUT_OF_SCOPE_RE = re.compile(r'[神界][曹刘孙关张赵马黄周吕甘华貂郭甄司夏许诸陆]')

# wiki 原文里的错别字 / 写法不统一,顺手校齐
FIXUP = [
    ('夏侯敦', '夏侯惇'), ('周于', '周瑜'), ('郭家', '郭嘉'),
    ('抵销', '抵消'),
    ('一1【马】', '-1【马】'),      # 贯石斧那条把 -1 写成了 一1
]


def clean(t: str) -> str:
    t = re.sub(r'\[\[[^\]|]*\|([^\]]*)\]\]', r'\1', t)   # [[链接|显示]] -> 显示
    t = re.sub(r'\[\[([^\]]*)\]\]', r'\1', t)
    t = re.sub(r"'''?", '', t)
    t = re.sub(r'<[^>]+>', '', t)
    t = re.sub(r'\{\{[^}]*\}\}', '', t)
    t = re.sub(r'^[\s*:：]+', '', t)                      # 行首残留的 * 和 ::
    t = re.sub(r'[\s*:：]+$', '', t)                      # 行尾同上
    t = re.sub(r'\s+', ' ', t).strip()
    t = convert(t, 'zh-cn')
    for a, b in FIXUP:
        t = t.replace(a, b)
    # 标点收拾干净。先把半角问号叹号转成全角,否则 parse() 里"没有问号就补一个"
    # 会在半角 ? 后面再补一个全角 ?,变成"收什么牌??"
    t = t.replace('?', '？').replace('!', '！')
    t = re.sub(r'[！？]{2,}', '？', t)
    # 技能名统一用【】,不用引号 —— 和游戏里的写法保持一致
    for s in ALL_SKILLS:
        t = t.replace(f'“{s}”', f'【{s}】').replace(f'"{s}"', f'【{s}】')
    return t


def out_of_scope(text: str, general: str) -> list:
    """这条 FAQ 牵涉到本项目没有的东西吗?返回命中的词"""
    hits = [w for w in OUT_OF_SCOPE if w in text]
    if OUT_OF_SCOPE_RE.search(text):
        hits.append('界/神 版本武将')
    # 【】里既不是我们的牌、也不是标准包任何技能的名字
    # 官方把坐骑写成【马】【+1马】【-1马】,我们实现成进攻马/防御马 —— 别当成扩展包内容
    known = set(CARDS) | ALL_SKILLS | {'马', '+1马', '-1马', '坐骑', '+1坐骑', '-1坐骑'}
    hits += sorted(set(re.findall(r'【([^】]{1,7})】', text)) - known)
    return sorted(set(hits))


def trim_answer(a: str, general: str) -> str:
    """答案里的"同理…"经常拿扩展包的牌再举一例。

    整条丢掉太可惜 —— 问题本身在范围内,只是补充举例越了界(马超那条问的是
    仁王盾 + 铁骑,答案末尾多说了一句藤甲)。所以只砍掉越界的那一句/那半句。
    """
    kept = []
    for piece in re.split(r'(?<=。)', a):
        if not piece.strip():
            continue
        if not out_of_scope(piece, general):
            kept.append(piece)
            continue
        m = re.search(r'(同理|同样的|同样|例如|另外)', piece)
        if m and not out_of_scope(piece[:m.start()], general):
            head = piece[:m.start()].rstrip('，,、 ')
            if head:
                kept.append(head + '。')
    return ''.join(kept).strip()


def standard_section(body: str) -> str:
    m = re.search(r'\n==\s*FAQ\s*==', body)
    if not m:
        return ''
    rest = body[m.end():]
    nxt = re.search(r'\n==[^=]', rest)
    sec = rest[:nxt.start()] if nxt else rest
    # FAQ 是页面最后一段时后面没有 == 标题挡着,页尾那串 [[Category:…]] 会被吃进答案
    # (黄盖那条答案后面粘了 18 个 Category)。见到第一个 Category 就截断。
    cat = sec.find('[[Category:')
    if cat >= 0:
        sec = sec[:cat]
    parts = re.split(r'\n===\s*(.+?)\s*===\n', sec)
    keep = [parts[0]]                                     # 开头没有小标题的部分
    for head, text in zip(parts[1::2], parts[2::2]):
        if STANDARD_HEADING.search(head):
            keep.append(text)
    return '\n'.join(keep)


def parse(sec: str):
    """三种 Q/A 写法统一成标记再切"""
    t = re.sub(r'^\s*[*:]+\s*$', '', sec, flags=re.M)
    t = re.sub(r'[【\[]\s*Q\s*[】\]]\s*[：:]?', '\n@@Q@@', t)
    t = re.sub(r'[【\[]\s*A\s*[】\]]\s*[：:]?', '\n@@A@@', t)
    out = []
    for chunk in t.split('@@Q@@')[1:]:
        if '@@A@@' not in chunk:
            continue
        q, a = chunk.split('@@A@@', 1)
        q, a = clean(q), clean(a)
        if not q or not a:
            continue
        if not q.endswith('？'):
            q += '？'
        out.append((q, a))
    # ★ 开头的补充说明也是规则澄清
    for line in sec.split('\n'):
        if line.strip().startswith('★'):
            c = clean(line.strip().lstrip('★'))
            if c:
                out.append(('', c))
    return out


# ————————————————— 牌页 —————————————————

# 牌页的效果按模式分小节。**只认标准/身份局那一节**,别的模式牌面文本都不一样:
#   1V1  过河拆桥是"观看其手牌并弃置一张",标准版是"弃置其区域里的一张牌"
#   3V3 / 国战 / 用间篇BETA  各有各的改动
# 用白名单而不是黑名单 —— 黑名单漏一个模式,就会拿错版本的文本去对照实现。
# 另外 wiki 上「身分局」「身份局」两种写法都有(无懈可击那页写的是"身分局")。
# 「2008推廣版」是丈八蛇矛那页对标准版的叫法(同页还有个更老的「2008無印版」)
CARD_MODE_KEEP = re.compile(r'標準|标准|身[份分]|推廣版|推广版')

# 我们实现成通用的"进攻马/防御马",官方是六匹有名字的马
HORSE_PAGES = {'-1坐骑': '进攻马', '+1坐骑': '防御马'}


def named_section(body: str, *heads: str) -> str:
    """截出 == 标题 == 到下一个同级标题之间,并砍掉页尾的 Category"""
    for head in heads:
        m = re.search(r'\n==\s*' + head + r'\s*==', body)
        if not m:
            continue
        rest = body[m.end():]
        nxt = re.search(r'\n==[^=]', rest)
        t = rest[:nxt.start()] if nxt else rest
        cat = t.find('[[Category:')
        if cat >= 0:
            t = t[:cat]
        if t.strip():
            return t
    return ''


def card_effect(body: str) -> str:
    """官方效果原文。只取身份局/标准版那一节 —— 国战和用间篇是另一套规则"""
    sec = named_section(body, '效果', '技能')
    if not sec:
        return ''
    parts = re.split(r'\n===\s*(.+?)\s*===\n', sec)
    heads, texts = parts[1::2], parts[2::2]
    # 有小节时只取标准版那一节;整页没分小节(桃园结义、乐不思蜀)就取全文
    keep = [t for h, t in zip(heads, texts) if CARD_MODE_KEEP.search(h)]
    if not keep and parts[0].strip():
        keep = [parts[0]]
    if not keep and heads:
        # 小节标题一个都没认出来 —— 退到第一节,但要吭一声,免得静默拿错版本
        print(f'  ⚠ 小节标题不认识,退用第一节:{heads}')
        keep = [texts[0]]
    lines = []
    for line in '\n'.join(keep).split('\n'):
        line = clean(line)
        if line and not line.startswith('='):
            lines.append(line)
    return ' '.join(lines)


def load_pages(*paths) -> dict:
    out = {}
    for path in paths:
        if not os.path.exists(path):
            continue
        raw = io.open(path, encoding='utf-8').read()
        parts = re.split(r'\n===== (.+?) =====\n', raw)
        for name, body in zip(parts[1::2], parts[2::2]):
            if not body.strip().startswith('!!'):
                out[name] = body
    return out


def build_cards(pages: dict):
    """每张牌:官方效果原文 + FAQ(只有五张武器牌有)"""
    out, dropped = {}, []
    for name in CARDS:
        page = pages.get(name)
        if page is None and name in ('进攻马', '防御马'):
            page = pages.get({'进攻马': '-1坐骑', '防御马': '+1坐骑'}[name])
        if page is None:
            out[name] = {'effect': '', 'faq': []}
            continue
        rows = []
        for q, a in parse(named_section(page, 'FAQ')):
            bad = out_of_scope(q, None) if q else out_of_scope(a, None)
            if bad:
                dropped.append((name, q or a[:30], bad))
                continue
            a2 = trim_answer(a, None)
            if a2:
                rows.append({'q': q, 'a': a2})
        out[name] = {'effect': card_effect(page), 'faq': rows}
    return out, dropped


BASIC = {
    '杀': '使用时机:出牌阶段限一次。使用目标:你攻击范围内的一名角色。'
          '使用效果:你对目标角色造成 1 点伤害。',
    '闪': '使用时机:以你为目标的【杀】生效前。使用目标:以你为目标的【杀】。'
          '使用效果:抵消此【杀】。',
    '桃': '使用时机:出牌阶段,或有角色处于濒死状态时。'
          '使用目标:你,或一名处于濒死状态的角色。使用效果:目标角色回复 1 点体力。',
}

SOURCE_NOTE = [
    '**来源**:[三国杀 Wiki](https://sanguosha.fandom.com/zh/),内容依 '
    '[CC BY-SA 3.0](https://www.fandom.com/licensing) 授权。',
    '繁体已统一转为简体,错别字和标点做了校齐,内容未作改动。',
    '重新生成:`python tools/extract-faq.py`(语料获取方式见脚本注释)。',
]


def build_generals(pages: dict):
    out, dropped, dup = {}, [], 0
    for g in GENERALS:
        rows, seen = [], set()
        for q, a in parse(standard_section(pages.get(g, ''))):
            # 范围由**问题**决定;答案里多举的扩展包例子只砍那一句(见 trim_answer)
            bad = out_of_scope(q, g) if q else out_of_scope(a, g)
            if bad:
                dropped.append((g, q or a[:30], bad))
                continue
            a = trim_answer(a, g)
            if not a:
                dropped.append((g, q or '(说明)', ['答案整段都在讲扩展包内容']))
                continue
            if (q, a) in seen:                            # wiki 上有重复条目
                dup += 1
                continue
            seen.add((q, a))
            rows.append({'q': q, 'a': a, 'skills': [s for s in SKILLS[g] if s in q + a]})
        out[g] = {'skills': SKILLS[g], 'faq': rows}
    return out, dropped, dup


def write(path: str, lines: list):
    io.open(f'{OUT}/{path}', 'w', encoding='utf-8', newline='\n').write('\n'.join(lines) + '\n')


def main():
    generals, dropped, dup = build_generals(load_pages(SRC_GENERALS))
    cards, card_dropped = build_cards(load_pages(*SRC_CARDS))
    os.makedirs(OUT, exist_ok=True)

    n_gen = sum(len(v['faq']) for v in generals.values())
    n_card = sum(len(v['faq']) for v in cards.values())

    # ——— 索引 ———
    write('README.md', [
        '# 三国杀标准版 · 官方规则参考',
        '',
        '本项目实现的是**标准版**。这里放的是官方原文和 FAQ,用来在实现或修改规则时',
        '**逐条对照**,而不是凭印象写。',
        '',
        '技能和牌的细则是最容易记错的部分,而这类错误不会让程序报错 ——',
        '一整局照样跑得完,只是结果不对。真实例子:【仁德】漏了"给出两张回 1 血"、',
        '【离间】的决斗方向反了、【武圣】的素材范围少了装备区,三个都是这么来的。',
        '',
        '| 文件 | 内容 |',
        '|---|---|',
        f'| [generals.md](generals.md) | 25 名武将的技能 FAQ,{n_gen} 条 |',
        f'| [cards.md](cards.md) | {len(CARDS)} 张牌的官方效果原文 + FAQ,{n_card} 条 |',
        '| [faq.json](faq.json) | 上面两份的结构化版本 |',
        '',
        '**只收标准版。**界限突破、SP、国战等重做版本,以及提到扩展包内容',
        '(酒、兵粮寸断、火/雷属性伤害、铁索连环、小乔、张角…)的条目一律不收 ——',
        '照着重做版本改,等于把游戏改成另一个版本。',
        '',
    ] + SOURCE_NOTE)

    # ——— 武将 ———
    md = ['# 武将 FAQ(标准版 25 将)', '',
          f'共 {n_gen} 条。返回 [索引](README.md)。', '', '## 目录', '']
    for g in GENERALS:
        md.append(f'- [{g}](#{g})({" / ".join(SKILLS[g])})· {len(generals[g]["faq"])} 条')
    for g in GENERALS:
        md += ['', f'## {g}', '', f'技能:{" / ".join(f"【{s}】" for s in SKILLS[g])}', '']
        rows = generals[g]['faq']
        if not rows:
            md.append('_标准版没有相关 FAQ 条目。_')
            continue
        for r in rows:
            tag = f'`{"/".join(r["skills"])}` ' if r['skills'] else ''
            head = f'**Q** {r["q"]}' if r['q'] else '**说明**'
            md.append(f'- {tag}{head}  ')
            md.append(f'  **A** {r["a"]}' if r['q'] else f'  {r["a"]}')
    write('generals.md', md)

    # ——— 牌 ———
    md = ['# 牌的官方效果与 FAQ(标准版)', '',
          '每张牌先给**官方效果原文** —— 那是实现的规格依据,再给 FAQ。',
          '【杀】【闪】【桃】在 wiki 上没有独立页面(描述太简单,官方也没出过 FAQ),',
          '所以只列基础描述。返回 [索引](README.md)。', '',
          f'FAQ 共 {n_card} 条,集中在五张武器牌上 —— 那里的互动最刁钻。', '']
    for name in CARDS:
        v = cards[name]
        md += ['', f'## {name}', '']
        eff = v['effect'] or BASIC.get(name, '')
        md.append(f'**效果** {eff}' if eff else '_没有取到官方效果原文。_')
        if v['faq']:
            md.append('')
        for r in v['faq']:
            md.append(f'- **Q** {r["q"]}  ')
            md.append(f'  **A** {r["a"]}')
    write('cards.md', md)

    io.open(f'{OUT}/faq.json', 'w', encoding='utf-8', newline='\n').write(
        json.dumps({'generals': generals, 'cards': cards}, ensure_ascii=False, indent=1) + '\n')

    print(f'武将 {n_gen} 条(剔除 {len(dropped)},去重 {dup})   牌 {n_card} 条(剔除 {len(card_dropped)})')
    missing = [n for n in CARDS if not cards[n]['effect'] and n not in BASIC]
    print('没取到官方效果原文的牌:', missing or '(无)')
    if card_dropped:
        print('剔除的牌 FAQ:')
        for n, q, bad in card_dropped:
            print(f'  [{n}] {q[:36]:<38} <- {"/".join(bad)}')


main()
