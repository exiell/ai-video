import { useEffect, useState } from 'react';
import { Field, WhyDetails } from '../components/bits';
import { RichText } from '../components/bits';
import { estimateUsage, assetsByteSize, listAssets } from '../services/storage';
import { useAppStore } from '../store/app';
import { Link, NavLink, useParams } from 'react-router-dom';
import { MODEL_PROFILES } from '../data/models/profiles';
import { VENDORS, findVendor, modelsOfVendor, vendorCors } from '../data/models/vendors';
import { currentTransport, useSettings } from '../store/settings';
import { isModelOverridden, resolveModelName } from '../services/llm/modelName';
import { testConnection, type ConnectionTestResult } from '../services/gateway';
import type { ModelProfile } from '../types/model';

/**
 * 设置的四个子视图。
 *
 * 顺序按用户实际会碰到的先后排：先选模型（决定花钱和效果），
 * 再解决连不上的问题，再看数据安全，最后是语言这类一次设定完不动的。
 */
const SECTIONS: { key: string; label: string; title: string; blurb: string }[] = [
  { key: 'models', label: '默认模型', title: '默认模型', blurb: '选好以后就不用再管。' },
  { key: 'connection', label: '连接与 Key', title: '连接与 Key', blurb: '填 Key，测能不能连上。' },
  { key: 'data', label: '数据与备份', title: '数据与备份', blurb: '你的东西都存在这台电脑上。' },
  { key: 'language', label: '语言', title: '语言', blurb: '界面与提示词的语言。' },
];

/**
 * M0 设置中心（方案.md v0.6 §3.2 + §5.4）
 *
 * 这一页要同时做到三件事：
 *  1. 让不懂技术的人把 Key 填对（图文说明 + 直达链接）
 *  2. 「测试连接」把跨域 / 密钥 / 余额三类问题一次问清楚，并给人话结论
 *  3. 把 Key 的存放位置讲明白——用户有权知道自己花钱买的东西被存在哪
 */

export function SettingsPage() {
  const prefs = useSettings((s) => s.prefs);
  const keys = useSettings((s) => s.keys);
  const modelOverrides = useSettings((s) => s.modelOverrides);
  const setPref = useSettings((s) => s.setPref);
  const setKey = useSettings((s) => s.setKey);
  const clearKey = useSettings((s) => s.clearKey);
  const setModelOverride = useSettings((s) => s.setModelOverride);

  const project = useAppStore((s) => s.project);

  /**
   * 厂商列表（每张卡一个 Key）。
   *
   * 为什么要分「厂商」与「模型」两层：**API Key 是厂商级的**。
   * 原来一个模型一张卡，于是智谱、MiniMax、硅基流动各出现两个 Key 输入框，
   * 而它们其实是同一个 Key——用户得填两遍、测两遍，还容易以为填错了。
   */
  const vendorCards = VENDORS.map((vendor) => ({
    vendor,
    models: modelsOfVendor(vendor.id),
    cors: vendorCors(vendor.id),
  })).filter((card) => card.models.length > 0);

  const llmProfiles = MODEL_PROFILES.filter((p) => p.type === 'llm');
  const t2iProfiles = MODEL_PROFILES.filter((p) => p.type === 't2i');

  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, ConnectionTestResult>>({});
  const [usage, setUsage] = useState<{ usage: number; quota: number } | null>(null);
  const [imageStats, setImageStats] = useState<{ count: number; bytes: number } | null>(null);

  useEffect(() => {
    void estimateUsage().then(setUsage);
  }, []);

  useEffect(() => {
    if (!project) {
      setImageStats(null);
      return;
    }
    void Promise.all([listAssets(project.id), assetsByteSize(project.id)]).then(
      ([assets, bytes]) => setImageStats({ count: assets.filter((a) => a.dataUrl).length, bytes }),
    );
  }, [project]);

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  async function runTest(profile: ModelProfile) {
    const apiKey = keys[profile.vendorId ?? '']?.trim() ?? '';
    if (!apiKey) {
      setResults((r) => ({
        ...r,
        [profile.vendorId ?? profile.id]: {
          ok: false,
          via: currentTransport() ? 'proxy' : 'direct',
          elapsedMs: 0,
          info: {
            kind: 'auth',
            title: '还没填 API Key',
            advice: '先在上面这个厂商的输入框里填上 Key，再点测试连接。',
          },
        },
      }));
      return;
    }
    setTesting(profile.vendorId ?? profile.id);
    try {
      // 关键：模型名的解析必须和生成走同一处，否则又会出现
      // 「测试连接通过、一生成就报错」
      const result = await testConnection(profile, apiKey, currentTransport(), fetch, {
        modelName: resolveModelName(profile),
      });
      // 结果按**厂商**记：一个厂商一次测试，界面也按厂商取。
      // 用 vendorId 而不是 profileId——后者是模型级的，一个厂商有多个。
      setResults((r) => ({ ...r, [profile.vendorId ?? profile.id]: result }));
    } finally {
      setTesting(null);
    }
  }

  /**
   * 四个子视图（v0.38）。
   *
   * 【为什么要拆】原来是一条长页：CORS 检测 → 默认模型 → 八个厂商的 Key →
   * 代理 → 语言 → 备份 → 存储用量。用户滚很久才能找到自己要改的那一项，
   * 而且「第一步/第二步」的编号暗示必须按顺序做——其实不用。
   *
   * tasteskill 的 app-screens 章节对这件事有明确要求：
   * 「设置跨多个区时，每个侧边项开自己的一屏，不要一条长页把所有区串起来」。
   *
   * 实现上用嵌套路由而不是内部 state：这样地址栏能直接分享到某一区，
   * 刷新也停在同一区。状态仍然留在这一个组件里——拆成四个组件会让
   * 钥匙串、测试结果这些状态各忘一份。
   */
  const { section } = useParams<{ section?: string }>();
  const tab = SECTIONS.some((x) => x.key === section) ? (section as string) : 'models';

  return (
    <>
      <div className="page-head">
        <div>
          <h2>{SECTIONS.find((x) => x.key === tab)?.title ?? '设置'}</h2>
          <p>{SECTIONS.find((x) => x.key === tab)?.blurb ?? ''}</p>
        </div>
      </div>

      <nav className="subnav">
        {SECTIONS.map((item) => (
          <NavLink
            key={item.key}
            to={`/settings/${item.key}`}
            className={({ isActive }) => `subnav-item${isActive ? ' active' : ''}`}
          >
            {item.label}
          </NavLink>
        ))}
      </nav>

      {tab === 'connection' ? (<>

      <div className="card">
        <h3 className="card-title">能不能直连</h3>
        <p style={{ fontSize: 13, color: 'var(--text-dim)', marginTop: 0 }}>
          点开测一下能不能直连。通就不用管下面「代理」那一栏。
        </p>
        <a className="btn btn-primary" href="./cors-check.html" target="_blank" rel="noreferrer">
          打开跨域实测工具
        </a>
      </div>

      </>) : null}

      {tab === 'models' ? (<>
      <div className="card">
        <p style={{ fontSize: 13, color: 'var(--text-dim)', marginTop: 0 }}>
          <RichText>
            {'Key 在「连接与 Key」那一页按厂商填——同一个厂商的对话模型与出图模型共用一个 Key，只填一次。'}
          </RichText>
        </p>

        <div className="row" style={{ marginBottom: 12 }}>
          <span className="hint" style={{ marginTop: 0, minWidth: 96 }}>
            写故事与分镜
          </span>
          <select
            style={{ flex: 1, minWidth: 260 }}
            value={prefs.defaultLlmProfileId}
            onChange={(e) => setPref('defaultLlmProfileId', e.target.value)}
          >
            {llmProfiles.map((p) => (
              <option key={p.id} value={p.id}>
                {findVendor(p.vendorId)?.name ?? p.provider} · {p.name.replace(/^[^·]*·\s*/, '')}
              </option>
            ))}
          </select>
        </div>

        <div className="row" style={{ marginBottom: 12 }}>
          <span className="hint" style={{ marginTop: 0, minWidth: 96 }}>
            生成画面
          </span>
          <select
            style={{ flex: 1, minWidth: 260 }}
            value={prefs.defaultReferenceProfileId}
            onChange={(e) => {
              setPref('defaultReferenceProfileId', e.target.value);
              setPref('defaultT2iProfileId', e.target.value);
            }}
          >
            {t2iProfiles.map((p) => (
              <option key={p.id} value={p.id}>
                {findVendor(p.vendorId)?.name ?? p.provider} · {p.name.replace(/^[^·]*·\s*/, '')}
                {p.capabilities.referenceImage ? `（参考图 ${p.capabilities.maxReferenceImages} 张）` : '（不支持参考图）'}
              </option>
            ))}
          </select>
        </div>

        <div className="hint">
          不确定选哪个就用默认的：写故事用 DeepSeek 快速版，出图用通义千问图生图。
        </div>
      </div>

      </>) : null}

      {tab === 'connection' ? (<>
      <div className="card">
        <h3 className="card-title">按厂商填 Key</h3>
        <p style={{ fontSize: 13, color: 'var(--text-dim)', marginTop: 0 }}>
          一个厂商一个 Key，只填你要用的那几家。
        </p>

        {vendorCards.map(({ vendor, models, cors }) => {
          const key = keys[vendor.id] ?? '';
          const result = results[vendor.id];
          // 测连接要挑一个模型：优先用这个厂商当前被选为默认的那个
          const preferred =
            models.find((m) => m.id === prefs.defaultLlmProfileId) ??
            models.find((m) => m.id === prefs.defaultReferenceProfileId) ??
            models.find((m) => m.type === 'llm') ??
            models[0]!;

          return (
            <div
              key={vendor.id}
              style={{
                marginBottom: 18,
                paddingBottom: 16,
                borderBottom: '1px solid var(--border)',
              }}
            >
              <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
                <b style={{ fontSize: 13.5 }}>
                  {vendor.name}
                  <span
                    className={`tag ${cors === 'unknown' ? 'tag-warning' : 'tag-ok'}`}
                    style={{ marginLeft: 8 }}
                  >
                    {cors === 'unknown' ? '直连待实测' : '可直连'}
                  </span>
                </b>
                <a
                  className="btn btn-ghost btn-sm"
                  href={vendor.consoleUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  去申请 Key →
                </a>
              </div>

              <div className="row">
                <input
                  type="password"
                  style={{ flex: 1, minWidth: 240 }}
                  value={key}
                  autoComplete="off"
                  placeholder={`粘贴 ${vendor.name} 的 API Key`}
                  onChange={(e) => setKey(vendor.id, e.target.value)}
                />
                <button
                  type="button"
                  className="btn"
                  disabled={testing === vendor.id}
                  onClick={() => void runTest(preferred)}
                >
                  {testing === vendor.id ? '测试中…' : '测试连接'}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => clearKey(vendor.id)}
                >
                  清除
                </button>
              </div>

              <div className="hint">
                可用模型：
                {models.map((m) => (
                  <span key={m.id} style={{ marginLeft: 6, display: 'inline-block' }}>
                    <code>{m.model || '（待填模型名）'}</code>
                    <span style={{ color: 'var(--text-faint)', marginLeft: 3 }}>
                      {m.type === 'llm' ? '对话' : '出图'}
                    </span>
                  </span>
                ))}
                {vendor.notes ? <div style={{ marginTop: 4 }}>{vendor.notes}</div> : null}
              </div>

              <details className="why" style={{ marginTop: 6 }}>
                <summary>某个模型报「模型名不支持」时改这里</summary>
                <div className="why-body">
                  {models.map((m) => (
                    <div key={m.id} className="row" style={{ marginBottom: 6 }}>
                      <span className="hint" style={{ marginTop: 0, minWidth: 140 }}>
                        {m.type === 'llm' ? '对话' : '出图'}
                      </span>
                      <input
                        type="text"
                        style={{ flex: 1, minWidth: 200 }}
                        value={modelOverrides[m.id] ?? ''}
                        placeholder={m.model || '（必须填）'}
                        onChange={(e) => setModelOverride(m.id, e.target.value)}
                      />
                      {isModelOverridden(m.id) ? (
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => setModelOverride(m.id, '')}
                        >
                          恢复
                        </button>
                      ) : null}
                    </div>
                  ))}
                  <div className="hint">
                    <RichText>
                      {'留空就用上面显示的默认名。厂商会下架旧模型、上架新模型——**报「模型名不被接受」时，把错误信息里列出的名字填到这里即可**，不用等工具更新。'}
                    </RichText>
                    <br />
                    接口地址：<code>{preferred.endpoint}</code>
                  </div>
                </div>
              </details>

              {result ? (
                <div
                  className={`issue ${result.ok ? '' : 'error'}`}
                  style={{
                    marginTop: 10,
                    marginBottom: 0,
                    borderLeftColor: result.ok ? 'var(--ok)' : undefined,
                  }}
                >
                  <div className="issue-title">
                    {result.ok ? '✓ 连接正常' : `✗ ${result.info?.title ?? '连接失败'}`}
                    <span className="tag" style={{ marginLeft: 8 }}>
                      {result.via === 'proxy' ? '经代理' : '直连'}
                    </span>
                    {result.elapsedMs > 0 ? (
                      <span className="tag" style={{ marginLeft: 6 }}>
                        {result.elapsedMs}ms
                      </span>
                    ) : null}
                  </div>
                  {result.ok ? (
                    <div className="issue-line">
                      模型回复：<code>{result.sample}</code>
                    </div>
                  ) : (
                    <>
                      <div className="issue-line">{result.info?.advice}</div>
                      {result.info?.raw ? (
                        <details className="why">
                          <summary>厂商返回的原始信息</summary>
                          <div className="why-body">
                            <pre>{result.info.raw.slice(0, 600)}</pre>
                          </div>
                        </details>
                      ) : null}
                    </>
                  )}
                </div>
              ) : null}
            </div>
          );
        })}

        <div className="row" style={{ marginTop: 6 }}>
          <label className="row" style={{ gap: 6, fontSize: 12.5, cursor: 'pointer', width: 'auto' }}>
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={prefs.dontSaveKeys}
              onChange={(e) => setPref('dontSaveKeys', e.target.checked)}
            />
            不保存到本机（关掉浏览器就失效）
          </label>
        </div>
        <div className="hint">
          Key 会存在这台电脑上，下次打开不用重填。共用电脑就勾上面那个框。
        </div>
      </div>

      <div className="card">
        <h3 className="card-title">
          代理
          {prefs.proxyBaseUrl.trim() ? <span className="tag tag-warning">已启用</span> : null}
        </h3>
        <p style={{ fontSize: 13, color: 'var(--text-dim)', marginTop: 0 }}>
          直连不通时才需要。填了之后所有模型请求都经过它转发。
        </p>
        <Field
          label="代理地址"
          hint="例：https://your-worker.example.workers.dev —— 留空表示不使用代理"
        >
          <input
            type="text"
            value={prefs.proxyBaseUrl}
            onChange={(e) => setPref('proxyBaseUrl', e.target.value)}
            placeholder="留空 = 直连"
          />
        </Field>
        <Field label="通行口令（可选）" hint="防止别人蹭你的代理额度。代理侧校验后会丢弃，不参与记录。">
          <input
            type="text"
            value={prefs.proxyPassword}
            onChange={(e) => setPref('proxyPassword', e.target.value)}
          />
        </Field>
        <WhyDetails>
          想自己搭一个的话，Cloudflare Workers 免费版每天 10 万次请求够个人用。
          这一栏填上就启用，清空就回到直连。
        </WhyDetails>
      </div>


      </>) : null}

      {tab === 'language' ? (<>
      <div className="card">
        <h3 className="card-title">语言</h3>
        <Field label="界面语言">
          <select value="zh" disabled>
            <option value="zh">简体中文</option>
          </select>
        </Field>
      </div>

      </>) : null}

      {tab === 'data' ? (<>
      <div className="card">
        <h3 className="card-title">
          存储与备份
          {imageStats && imageStats.count > 0 ? (
            <span className="tag tag-warning">有 {imageStats.count} 张图未备份</span>
          ) : null}
        </h3>
        <p style={{ fontSize: 13, color: 'var(--text-dim)', marginTop: 0 }}>
          图片只在这个浏览器里，清缓存就没了。
        </p>
        {imageStats && imageStats.count > 0 ? (
          <div className="issue warning" style={{ marginBottom: 12 }}>
            <div className="issue-title">
              当前项目有 {imageStats.count} 张图，共 {formatBytes(imageStats.bytes)}
            </div>
            <div className="issue-line">建议现在就导出一份。</div>
            <div className="row" style={{ marginTop: 8 }}>
              <Link className="btn btn-primary btn-sm" to="/export">
                去导出备份
              </Link>
            </div>
          </div>
        ) : null}
        <h3 className="card-title" style={{ marginTop: 20 }}>
          存储用量
        </h3>
        {usage ? (
          <>
            <div className="row" style={{ marginBottom: 8 }}>
              <span>已用</span>
              <b>{formatBytes(usage.usage)}</b>
              <span style={{ color: 'var(--text-faint)' }}>
                / 浏览器给这个站点约 {formatBytes(usage.quota)}
              </span>
            </div>
            <div
              style={{
                height: 6,
                background: 'var(--bg)',
                borderRadius: 3,
                overflow: 'hidden',
                border: '1px solid var(--border)',
              }}
            >
              <div
                style={{
                  width: `${Math.min(100, (usage.usage / Math.max(usage.quota, 1)) * 100).toFixed(2)}%`,
                  height: '100%',
                  background: 'var(--accent)',
                }}
              />
            </div>
          </>
        ) : (
          <div className="hint">这个浏览器不支持查看存储用量。</div>
        )}
        <WhyDetails summary="为什么图必须存在本地">
          图片必须存在本地，因为平台返回的是<b>24 小时后失效</b>的临时链接。
          只存链接的话，图库第二天会集体变成裂图。
          <br />
          <br />
          代价是占空间（一张 2K 图几百 KB 到 1 MB）。浏览器清缓存时会一并清空，
          所以养成定期导出的习惯。
        </WhyDetails>
      </div>
      </>) : null}
    </>
  );
}
