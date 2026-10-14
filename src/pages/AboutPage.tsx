/**
 * 关于页 —— 开源许可署名（方案.md v0.6 §0.2 合规执行要求第 2 条与第 6 条）
 *
 * 合规要点：
 *  - MIT 来源：保留版权声明
 *  - 自定义许可来源（水仙的AI提示词）：**必须在用户可见处署名**，且不得暗示官方背书
 *  - 商业用途警示必须出现在这里，不能只写在仓库文件里
 */
export function AboutPage() {
  return (
    <>
      <div className="page-head">
        <div>
          <h2>关于</h2>
          <p>AniGuide 是一个开源免费的工具，仅供学习交流。</p>
        </div>
      </div>

      <div className="card">
        <h3 className="card-title">这个工具是什么</h3>
        <p style={{ fontSize: 13, color: 'var(--text-dim)', marginTop: 0 }}>
          它把「我想做个动漫视频」这个模糊念头，用问答引导的方式，变成一份可以直接开拍的制作方案：
          动漫分镜表、角色与场景设定卡、可直接粘贴的多平台提示词，外加一份穿帮检查单。
        </p>
        <p style={{ fontSize: 13, color: 'var(--text-dim)' }}>
          <b>它不生成视频，也不做剪辑。</b>
          市面上那些工具（Toonflow、ArcReel、即梦、可灵）解决的是「怎么生产」；
          这个工具解决的是「我该生产什么」。
        </p>
      </div>

      <div className="card">
        <h3 className="card-title">你的数据在哪里</h3>
        <p style={{ fontSize: 13, color: 'var(--text-dim)', marginTop: 0 }}>
          全部在你浏览器的本地存储里。没有账号，没有云端，没有服务器在中间转手任何内容。
          你可以在断网状态下使用除「生成」之外的全部功能。
        </p>
      </div>

      <div className="card">
        <h3 className="card-title">开源许可</h3>
        <p style={{ fontSize: 13, color: 'var(--text-dim)', marginTop: 0 }}>
          本项目采用 MIT License。
        </p>
      </div>

      <div className="card">
        <h3 className="card-title">第三方资产署名</h3>
        <p style={{ fontSize: 13, color: 'var(--text-dim)', marginTop: 0 }}>
          本项目在设计与内容上参考了以下开源项目：
        </p>

        <div style={{ marginBottom: 14 }}>
          <b style={{ fontSize: 13 }}>zenstory-ai/drama-skills</b>
          <span className="tag" style={{ marginLeft: 8 }}>
            MIT
          </span>
          <div className="hint">
            Copyright (c) 2026 drama-skills contributors ·{' '}
            <a href="https://github.com/zenstory-ai/drama-skills" target="_blank" rel="noreferrer">
              github.com/zenstory-ai/drama-skills
            </a>
            <br />
            本项目参考了它的一致性三层机制（身份 vs 变体、连续性锁、冻结关键帧）、
            分镜「起点 → 唯一动作 → 终点」字段结构，以及跨文档引用校验的规则设计与报错文案范式。
          </div>
        </div>

        <div style={{ marginBottom: 14 }}>
          <b style={{ fontSize: 13 }}>jijiutong/ai-visual-director</b>
          <span className="tag" style={{ marginLeft: 8 }}>
            MIT
          </span>
          <div className="hint">
            Copyright (c) 2026 AI Visual Director Contributors ·{' '}
            <a
              href="https://github.com/jijiutong/ai-visual-director"
              target="_blank"
              rel="noreferrer"
            >
              github.com/jijiutong/ai-visual-director
            </a>
            <br />
            本项目参考了它的影视知识库结构与内容方向、多平台提示词输出格式规范，以及数据模型骨架。
          </div>
        </div>

        <div style={{ marginBottom: 14 }}>
          <b style={{ fontSize: 13 }}>「水仙的AI提示词」</b>
          <span className="tag" style={{ marginLeft: 8 }}>
            Attribution Required License v1.0
          </span>
          <div className="hint">
            作者：水仙 ·{' '}
            <a href="https://github.com/BaYue-SYJ/shuixian-prompts" target="_blank" rel="noreferrer">
              github.com/BaYue-SYJ/shuixian-prompts
            </a>
            <br />
            本项目基于「水仙的AI提示词」（https://github.com/BaYue-SYJ/shuixian-prompts）二次开发。
            <br />
            该数据源以<b>可插拔数据源</b>的形式提供，未内置在本工具中。
          </div>
        </div>

        <div
          className="issue warning"
          style={{ marginTop: 16, marginBottom: 0, borderLeftColor: 'var(--warning)' }}
        >
          <div className="issue-title">关于「水仙的AI提示词」的许可提示</div>
          <div className="issue-line">
            该数据源采用自定义许可：<b>非商业用途免费</b>，但<b>商业用途需先取得原作者书面授权</b>。
            该仓库收录的提示词原文与图片版权归各自原作者。
          </div>
          <div className="issue-line">
            本工具自身为开源免费项目，仅供学习交流，不属于商业用途。
            若你打算把本工具用于商业场景，请先自行确认该数据源的授权情况。
          </div>
        </div>
      </div>

      <div className="card">
        <h3 className="card-title">免责说明</h3>
        <p style={{ fontSize: 13, color: 'var(--text-dim)', margin: 0 }}>
          本工具的检查功能是<b>文本约束检查</b>，它检查的是「该一致的地方有没有写下来」，
          不是「生成出来一定没问题」。生成模型仍可能出错。
          这套做法的价值是让穿帮在出图之前就能被看见，而不是承诺零穿帮。
        </p>
      </div>
    </>
  );
}
