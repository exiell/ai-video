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
          <h1>关于</h1>
          <p>AniGuide 是一个开源免费的工具，仅供学习交流。</p>
        </div>
      </div>

      <div className="card">
        <h3 className="card-title">这个工具是什么</h3>
        <p style={{ fontSize: 13, color: 'var(--text-dim)', marginTop: 0 }}>
          你想做一部动漫视频，但还不清楚要准备什么。这个工具用问答带你写出故事、角色、场景、分镜和提示词，
          最后给一份能直接开拍的方案：动漫分镜表、角色与场景设定卡、多平台提示词，外加一份穿帮检查单。
        </p>
        <p style={{ fontSize: 13, color: 'var(--text-dim)' }}>
          <b>它不生成视频，也不做剪辑。</b>
          Toonflow、ArcReel、即梦、可灵解决生产；这个工具解决生产之前要定下的内容。
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

        <div style={{ marginBottom: 14 }}>
          <b style={{ fontSize: 13 }}>界面素材</b>
          <span className="tag" style={{ marginLeft: 8 }}>
            MIT / CC0
          </span>
          <div className="hint">
            <a href="https://github.com/tabler/tabler-icons" target="_blank" rel="noreferrer">
              Tabler Icons
            </a>
            （MIT）提供导航图标；
            <a href="https://github.com/simple-icons/simple-icons" target="_blank" rel="noreferrer">
              Simple Icons
            </a>
            （CC0-1.0）提供厂商品牌标识；
            <a href="https://github.com/LeaVerou/css3patterns" target="_blank" rel="noreferrer">
              css3patterns
            </a>
            （MIT）的「Blueprint grid」几何用于「蓝图」外观的底纹。品牌标识仅用于标识对应厂商，不代表官方背书。
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
          本工具的检查功能是<b>文本约束检查</b>。它检查的是该一致的地方有没有写下来，
          不是生成结果一定没问题；模型仍可能出错。
          这套做法让穿帮在出图前暴露出来，不承诺零穿帮。
        </p>
      </div>
    </>
  );
}

