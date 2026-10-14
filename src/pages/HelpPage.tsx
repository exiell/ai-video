import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  searchTerms,
  TERMS,
  TERM_CATEGORY_LABEL,
  type TermCategory,
} from '../domain/help/terms';

/**
 * M7 帮助与术语（方案.md §3.2 M7）
 *
 * 这一页要解决的是障碍 #5：「做出来好不好，我不知道」。
 * 但它的做法不是给一套标准答案，而是把**判断依据**交到用户手上——
 * 每个词条都回答「这个选择会让观众感觉到什么」，而不是「这个词的定义是什么」。
 *
 * 术语全部内置，不依赖网络。断网也能查。
 */
export function HelpPage() {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<TermCategory | 'all'>('all');

  const results = useMemo(() => {
    const matched = query.trim() ? searchTerms(query) : TERMS;
    return category === 'all' ? matched : matched.filter((t) => t.category === category);
  }, [query, category]);

  const categories = Object.keys(TERM_CATEGORY_LABEL) as TermCategory[];

  return (
    <>
      <div className="page-head">
        <div>
          <h2>帮助与术语</h2>
          <p>
            这里不收字典定义，只收<b>判断依据</b>——每个词条回答的是
            「这个选择会让观众感觉到什么」，因为新手缺的不是定义，是不知道该选哪个。
          </p>
        </div>
      </div>

      <div className="card">
        <h3 className="card-title">第一次用？按这个顺序走</h3>
        <ol style={{ fontSize: 13, color: 'var(--text-dim)', paddingLeft: 20, margin: 0 }}>
          <li>
            <b>先看示例项目</b>（在「项目」页）。不用配 Key 就能看到一份完整产出长什么样，
            看完你就知道这些东西最终是为了什么。
          </li>
          <li>
            <b>确认能不能直连</b>。打开「设置」页右上角的跨域实测工具点一下——
            它告诉你你的网络环境能不能直接调模型。
          </li>
          <li>
            <b>填 API Key 并点「测试连接」</b>。它会区分「跨域被拦 / 密钥无效 / 余额不足 / 限流」
            并给出对应做法，比自己猜快得多。
          </li>
          <li>
            <b>走引导向导</b>，把故事写出来。每个问题旁边都有「为什么问这个」，
            看不懂就展开看。
          </li>
          <li>
            <b>先建场景，再建角色，最后写分镜</b>。原因：每个镜头都要挂到一个场景上、
            勾选出场角色。反过来做会让你来回切换，很烦。
          </li>
          <li>
            <b>生成角色形象图</b>：先出「全身多视图」，再出「头部特写」。
            头部特写是锁脸的关键，别跳过。
          </li>
          <li>
            <b>跑一次穿帮检查</b>，把「必须修」的都改掉。
          </li>
          <li>
            <b>逐镜出三帧</b>：先出「首帧（锁角色）」，再出「动作关键帧」和「尾帧」。
            <b>顺序不能反</b>——后两帧会自动拿首帧当构图锚点。最后导出压缩包。
          </li>
        </ol>
        <div className="row" style={{ marginTop: 12 }}>
          <Link className="btn" to="/">
            去项目页
          </Link>
          <Link className="btn" to="/settings">
            去设置页
          </Link>
        </div>
      </div>

      <div className="card">
        <h3 className="card-title">一致性是怎么保证的（这是这类工具最容易出错的地方）</h3>
        <p style={{ fontSize: 13, color: 'var(--text-dim)', marginTop: 0 }}>
          一致性不是一个开关，是**四道防线叠起来**的结果。任何一道漏了，都会出现
          「每张图单独看都挺好，放一起就不像同一部片子」这种最难排查的问题。
        </p>
        <ol style={{ fontSize: 13, color: 'var(--text-dim)', paddingLeft: 20, margin: 0 }}>
          <li style={{ marginBottom: 10 }}>
            <b>第一道：连续性锁（靠文字）</b>
            <br />
            你为角色和场景登记的英文短语，会被<b>原样写进</b>相关每一帧的提示词。
            它负责那些「能说清楚」的特征：服装颜色、发长、手里拿着什么、场地里的固定物件。
            <br />
            <span style={{ color: 'var(--text-faint)' }}>
              漏了会怎样：这一镜的描述里没有这条锁，模型就自由发挥。所以穿帮检查里有一条
              「漏勾锁」专门盯这个，可以一键补齐。
            </span>
          </li>
          <li style={{ marginBottom: 10 }}>
            <b>第二道：角色形象图（靠图锁外观）</b>
            <br />
            出首帧时会把你为该角色生成的<b>头部特写</b>和<b>全身多视图</b>当参考图传进去。
            头部特写优先——<b>脸很难用文字描述清楚，只能靠图</b>；全身图里的脸只有几十像素，
            所以两张要分开出。
            <br />
            <span style={{ color: 'var(--text-faint)' }}>
              漏了会怎样：同一张脸在不同镜头里认不出是同一个人。这是最常见的翻车方式。
            </span>
          </li>
          <li style={{ marginBottom: 10 }}>
            <b>第三道：本镜首帧（靠图锁构图）</b>
            <br />
            出<b>动作关键帧</b>和<b>尾帧</b>时会自动把这一镜的<b>首帧</b>当参考图，
            并在提示词里明确要求保持相同的机位、构图、背景布局与光线方向。
            <br />
            <span style={{ color: 'var(--text-faint)' }}>
              为什么需要这一道：形象图锁的是「这个人长什么样」，锁不住「这一镜的空间长什么样」。
              没有它，三帧的机位可能各自漂移——三张图都好看，放一起却不像同一个镜头。
              <b>所以顺序不能反：先出首帧。</b>
            </span>
          </li>
          <li style={{ marginBottom: 10 }}>
            <b>第四道：上一镜的尾帧（靠图锁跨镜连续）</b>
            <br />
            生成某一镜的<b>首帧</b>时，如果上一镜的衔接说明里写了「接着／保持」这类连续信号，
            工具会自动把<b>上一镜的尾帧</b>当参考图传进去，并在提示词里写明
            「从那张图的那个点继续，保持同一空间、同一光线方向」。
            <br />
            <span style={{ color: 'var(--text-faint)' }}>
              为什么只在连续时才用：跳切时把上一镜尾帧当锚点，
              等于把两个不该相连的镜头强行焊在一起——本镜的构图会被拉向上一镜，
              上一镜的空间会被搬进一个全新场景，两边都毁。
              所以判据是保守的：<b>上一镜写明了「接着」才用；写了「切到」或没写就不用。</b>
              <br />
              想让两镜真的接得住，就在上一镜的衔接说明里写「接着」。
            </span>
          </li>
          <li>
            <b>第五道：场景参考板与主光方向</b>
            <br />
            场景板固定空间结构、固定元素与光线方向。空镜与广角镜头（画面里没有角色）会用它当参考图。
            <br />
            <span style={{ color: 'var(--text-faint)' }}>
              漏了会怎样：同一个地方在不同镜头里像两个地方。穿帮检查里有「固定元素缺失」与
              「光线与场景设定冲突」两条盯这个。
            </span>
          </li>
        </ol>
        <div className="summary-bar" style={{ marginTop: 14 }}>
          <b>一句话记住顺序</b>
          <span style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>
            场景板 → 角色形象图（全身 → 头特）→ 逐镜出帧，每镜按「首帧 → 尾帧 → 动作关键帧」。
            每一步都在为下一步提供锚点。想让两个镜头接得住，就在前一镜的衔接说明里写「接着」。
          </span>
        </div>
      </div>

      <div className="card">
        <h3 className="card-title">几条不用查表也知道的经验</h3>
        <ul style={{ fontSize: 13, color: 'var(--text-dim)', paddingLeft: 20, margin: 0 }}>
          <li>
            <b>一镜只做一件事。</b>这是新手最容易踩的坑，也是模型最容易崩的地方。
            几秒钟的时间里它只能可靠完成一个动作，塞两个的结果通常是两个都做不好。
          </li>
          <li>
            <b>镜头不要都在动。</b>固定镜头是默认值。每镜都想让镜头动起来，整片会显得很吵，
            而且会削弱真正需要运动的那几镜。
          </li>
          <li>
            <b>先出图，再出视频。</b>图不满意可以重出，一次几毛钱；视频重出贵得多。
            本工具交付的是图与方案，视频是下一步的事。
          </li>
          <li>
            <b>首帧只写起点。</b>终点才出现的动作写进首帧提示词，模型会把终点画进第一帧，
            整段动作就错位了。终点交给尾帧去画。
          </li>
          <li>
            <b>一致性靠图和锁，不靠种子。</b>种子只能让「同样的提示词」稳定，
            换动作或构图之后就保不住了。真正有用的是参考图和连续性锁。
          </li>
          <li>
            <b>随时导出备份。</b>所有数据只在你浏览器里，浏览器清理磁盘时可能整个清空。
          </li>
        </ul>
      </div>

      <div className="page-head" style={{ marginTop: 26 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 17 }}>术语速查（{TERMS.length} 条）</h3>
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 12 }}>
          <input
            type="text"
            placeholder="搜索：景别、运镜、连续性锁、reference…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ flex: 1, minWidth: 220 }}
          />
          {query ? (
            <button type="button" className="btn btn-sm" onClick={() => setQuery('')}>
              清空
            </button>
          ) : null}
        </div>
        <div className="row">
          <button
            type="button"
            className={`btn btn-sm${category === 'all' ? ' btn-primary' : ''}`}
            onClick={() => setCategory('all')}
          >
            全部
          </button>
          {categories.map((c) => (
            <button
              key={c}
              type="button"
              className={`btn btn-sm${category === c ? ' btn-primary' : ''}`}
              onClick={() => setCategory(c)}
            >
              {TERM_CATEGORY_LABEL[c]}
            </button>
          ))}
        </div>
      </div>

      {results.length === 0 ? (
        <div className="empty">
          没有匹配的词条。
          <div style={{ marginTop: 8 }}>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setQuery('');
                setCategory('all');
              }}
            >
              看全部
            </button>
          </div>
        </div>
      ) : null}

      {results.map((term) => (
        <div className="card" key={term.zh}>
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
            <b style={{ fontSize: 14 }}>
              {term.zh}
              <span style={{ color: 'var(--text-faint)', fontWeight: 400, marginLeft: 8, fontSize: 12 }}>
                {term.en}
              </span>
            </b>
            <span className="tag">{TERM_CATEGORY_LABEL[term.category]}</span>
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>{term.summary}</div>
          <div style={{ fontSize: 13, marginTop: 8, lineHeight: 1.7 }}>{term.whenToUse}</div>
          {term.example ? (
            <div className="hint" style={{ marginTop: 8 }}>
              例：{term.example}
            </div>
          ) : null}
        </div>
      ))}
    </>
  );
}
