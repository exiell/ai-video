import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { RichText } from '../components/bits';
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
          <h1>帮助与术语</h1>
          <p>
            这里解释词的意思和判断依据。每个词条回答：这个选择会让观众看到什么。
          </p>
        </div>
      </div>

      <div className="card">
        <h3 className="card-title">第一次使用</h3>
        <ol style={{ fontSize: 13, color: 'var(--text-dim)', paddingLeft: 20, margin: 0 }}>
          <li>
            <b>先打开示例项目</b>。不用配 Key，也能看到一份完整产出。
          </li>
          <li>
            <b>确认网络能直连</b>。到「设置」页点跨域实测，填 API Key，再用「测试连接」确认。
          </li>
          <li>
            <b>去「故事」把故事写出来</b>。按问题走，看不懂就展开「为什么问这个」。
          </li>
          <li>
            <b>先建场景，再建角色，最后写分镜</b>。角色先出全身多视图，再出头部特写，锁脸主要靠这张。
          </li>
          <li>
            <b>跑一次穿帮检查</b>。逐镜出三帧：首帧（锁角色）→ 动作关键帧 → 尾帧，最后导出压缩包。
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
        <h3 className="card-title">一致性怎么保证</h3>
        <p style={{ fontSize: 13, color: 'var(--text-dim)', marginTop: 0 }}>
          <RichText>
            {'一致性是**五道防线**叠起来的结果：角色锁、场景固定元素、首帧、尾帧、动作关键帧。缺一道，单张图能看，放一起就不像同一部片子。'}
          </RichText>
        </p>
        <div className="help-defenses">
          <details className="why help-defense">
            <summary>
              <b>第一道：连续性锁</b>
              <span>靠文字</span>
            </summary>
            <div className="why-body help-defense-body">
              <p>
                你为角色和场景登记的英文短语，会被原样写进相关每一帧的提示词。它负责那些能说清楚的特征：服装颜色、发长、手里拿着什么、场地里的固定物件。
              </p>
              <p className="help-defense-note">
                漏了会怎样：这一镜的描述里没有这条锁，模型就自由发挥。穿帮检查里的「漏勾锁」专门盯这个，可以补齐。
              </p>
            </div>
          </details>

          <details className="why help-defense">
            <summary>
              <b>第二道：角色形象图</b>
              <span>靠图锁外观</span>
            </summary>
            <div className="why-body help-defense-body">
              <p>
                出首帧时会把你为该角色生成的头部特写和全身多视图当参考图。头部特写优先。脸很难用文字描述清楚，只能靠图；全身图里的脸只有几十像素，所以两张要分开出。
              </p>
              <p className="help-defense-note">
                漏了会怎样：同一张脸在不同镜头里认不出是同一个人。这是最常见的翻车方式。
              </p>
            </div>
          </details>

          <details className="why help-defense">
            <summary>
              <b>第三道：本镜首帧</b>
              <span>靠图锁构图</span>
            </summary>
            <div className="why-body help-defense-body">
              <p>
                出动作关键帧和尾帧时，会自动把这一镜的首帧当参考图，并在提示词里要求保持相同的机位、构图、背景布局与光线方向。
              </p>
              <p className="help-defense-note">
                为什么需要这一道：形象图锁的是「这个人长什么样」，锁不住「这一镜的空间长什么样」。没有它，三帧的机位可能各自漂移。三张图都好看，放一起却不像同一个镜头。
              </p>
              <p className="help-defense-note">所以顺序不能反：先出首帧。</p>
            </div>
          </details>

          <details className="why help-defense">
            <summary>
              <b>第四道：上一镜的尾帧</b>
              <span>靠图锁跨镜连续</span>
            </summary>
            <div className="why-body help-defense-body">
              <p>
                生成某一镜的首帧时，如果上一镜的衔接说明里写了「接着」或「保持」，工具会自动把上一镜的尾帧当参考图传进去，并在提示词里写明从那张图的点继续，保持同一空间、同一光线方向。
              </p>
              <p className="help-defense-note">
                为什么只在连续时才用：跳切时把上一镜尾帧当锚点，等于把两个不该相连的镜头强行焊在一起。本镜的构图会被拉向上一镜，上一镜的空间会被搬进一个全新场景。
              </p>
              <p className="help-defense-note">判据是保守的：上一镜写了「接着」才用；写了「切到」或没写就不用。</p>
            </div>
          </details>

          <details className="why help-defense">
            <summary>
              <b>第五道：场景参考板与主光方向</b>
              <span>靠图锁空间</span>
            </summary>
            <div className="why-body help-defense-body">
              <p>
                场景板固定空间结构、固定元素与光线方向。空镜与广角镜头（画面里没有角色）会用它当参考图。
              </p>
              <p className="help-defense-note">
                漏了会怎样：同一个地方在不同镜头里像两个地方。穿帮检查里的「固定元素缺失」与「光线与场景设定冲突」会盯这个。
              </p>
            </div>
          </details>
        </div>
        <div className="summary-bar" style={{ marginTop: 14 }}>
          <b>顺序</b>
          <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>
            场景板 → 角色形象图 → 逐镜出帧（首帧 → 动作关键帧 → 尾帧）。想让两个镜头接住，就在上一镜的衔接说明里写「接着」。
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
          <h3 style={{ margin: 0, fontSize: 16 }}>术语速查（{TERMS.length} 条）</h3>
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

      {results.length > 0 ? (
        <div className="card term-list">
          {results.map((term) => (
            <article className="term-item" key={term.zh}>
              <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
                <b style={{ fontSize: 14 }}>
                  {term.zh}
                  <span style={{ color: 'var(--text-faint)', fontWeight: 400, marginLeft: 8, fontSize: 12 }}>
                    {term.en}
                  </span>
                </b>
                <span className="tag">{TERM_CATEGORY_LABEL[term.category]}</span>
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>
                <RichText>{term.summary}</RichText>
              </div>
              <div style={{ fontSize: 13, marginTop: 8, lineHeight: 1.7 }}>
                <RichText>{term.whenToUse}</RichText>
              </div>
              {term.example ? (
                <div className="hint" style={{ marginTop: 8 }}>
                  例：<RichText>{term.example}</RichText>
                </div>
              ) : null}
            </article>
          ))}
        </div>
      ) : null}
    </>
  );
}


