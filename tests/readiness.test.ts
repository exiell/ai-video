// @vitest-environment jsdom
// 这个文件必须有 DOM 环境：它验证的是「Key 默认只存会话、勾选才落盘」这条安全行为，
// 用 mock 顶替 localStorage 就等于没验证。
import { beforeEach, describe, expect, it } from 'vitest';
import { buildGenerateContext, checkLlmReadiness } from '../src/services/llm/readiness';
import { useSettings } from '../src/store/settings';

/**
 * 生成前的「配好了没有」判断。
 *
 * 这段逻辑的价值在于：它决定用户按下生成按钮时，看到的是
 * 「去设置页填 Key」还是「浏览器没能发出这个请求」。写错的后果是用户白折腾。
 */

/** 每个用例都从干净的存储开始，避免互相污染 */
function resetSettings(): void {
  localStorage.clear();
  sessionStorage.clear();
  useSettings.setState({
    prefs: {
      rememberKeys: false,
      defaultLlmProfileId: 'deepseek-flash',
      defaultT2iProfileId: 'qwen-image',
      defaultReferenceProfileId: 'qwen-image-edit',
      proxyBaseUrl: '',
      proxyPassword: '',
    },
    keys: {},
  });
}

describe('生成前置检查', () => {
  beforeEach(resetSettings);

  it('没有 Key 时不可生成，并明确指出去哪个页面做什么', () => {
    const readiness = checkLlmReadiness();
    expect(readiness.ready).toBe(false);
    expect(readiness.reason).toContain('API Key');
    expect(readiness.reason).toContain('设置');
    // 必须告诉用户下一步动作，不能只说「未配置」
    expect(readiness.reason).toContain('测试连接');
  });

  it('填了 Key 且直连已确认时，直接放行且不给多余警告', () => {
    useSettings.getState().setKey('deepseek', 'sk-test');
    const readiness = checkLlmReadiness();
    expect(readiness.ready).toBe(true);
    // 三家都已实测确认可直连，因此不该再提示跨域风险
    expect(readiness.reason).toBeUndefined();
  });

  it('默认档案对应的 Key 才有效，别的档案的 Key 不算数', () => {
    useSettings.getState().setKey('siliconflow', 'sk-other');
    const readiness = checkLlmReadiness();
    expect(readiness.ready).toBe(false);
  });

  it('Key 只有空白字符时视为未填', () => {
    useSettings.getState().setKey('deepseek', '   ');
    expect(checkLlmReadiness().ready).toBe(false);
  });

  it('切换默认档案后，判断跟着切到新档案', () => {
    useSettings.getState().setKey('siliconflow', 'sk-sf');
    useSettings.getState().setPref('defaultLlmProfileId', 'siliconflow-chat');
    const readiness = checkLlmReadiness();
    expect(readiness.ready).toBe(true);
    expect(readiness.profile?.id).toBe('siliconflow-chat');
  });
});

describe('生成上下文组装', () => {
  beforeEach(resetSettings);

  it('未配置时返回的是可读的错误，不是抛异常', () => {
    const built = buildGenerateContext();
    expect('error' in built).toBe(true);
    if ('error' in built) expect(built.error.length).toBeGreaterThan(5);
  });

  it('配置好后返回的上下文带有 Key、模型名与直连传输', () => {
    useSettings.getState().setKey('deepseek', 'sk-real');
    const built = buildGenerateContext();
    expect('ctx' in built).toBe(true);
    if ('ctx' in built) {
      expect(built.ctx.apiKey).toBe('sk-real');
      // 这里曾经断言的是 'DeepSeek Chat'（界面显示名）——
      // 那条断言把 bug 本身当成了正确行为，所以它从来没有报过警。
      // 现在断言的是厂商实际接受的模型名。
      expect(built.ctx.model).toBe('deepseek-flash');
      expect(built.ctx.model).not.toContain(' ');
      // 没填代理地址时不带 transport，即走直连
      expect(built.ctx.transport).toBeUndefined();
    }
  });

  it('填了代理地址时自动带上 transport，业务代码零改动', () => {
    useSettings.getState().setKey('deepseek', 'sk-real');
    useSettings.getState().setPref('proxyBaseUrl', 'https://p.example.com');
    useSettings.getState().setPref('proxyPassword', 'pw');
    const built = buildGenerateContext();
    expect('ctx' in built).toBe(true);
    if ('ctx' in built) {
      expect(built.ctx.transport?.proxyBaseUrl).toBe('https://p.example.com');
      expect(built.ctx.transport?.applicationPassword).toBe('pw');
    }
  });
});

describe('Key 存储策略', () => {
  beforeEach(resetSettings);

  it('默认只写 sessionStorage，不落磁盘', () => {
    useSettings.getState().setKey('deepseek', 'sk-secret');
    expect(sessionStorage.getItem('aniguide:keys:session')).toContain('sk-secret');
    expect(localStorage.getItem('aniguide:keys')).toBeNull();
  });

  it('勾选「记住到本机」后才写 localStorage', () => {
    useSettings.getState().setPref('rememberKeys', true);
    useSettings.getState().setKey('deepseek', 'sk-secret');
    expect(localStorage.getItem('aniguide:keys')).toContain('sk-secret');
  });

  it('取消「记住到本机」时立刻清掉磁盘上的 Key', () => {
    useSettings.getState().setPref('rememberKeys', true);
    useSettings.getState().setKey('deepseek', 'sk-secret');
    expect(localStorage.getItem('aniguide:keys')).not.toBeNull();

    useSettings.getState().setPref('rememberKeys', false);
    expect(localStorage.getItem('aniguide:keys')).toBeNull();
    // 会话里的 Key 仍在，用户不用重填
    expect(useSettings.getState().keys['deepseek']).toBe('sk-secret');
  });

  it('清除某个厂商的 Key 不影响别的厂商', () => {
    // Key 是厂商级的：同一个厂商的对话与出图模型共用一个 Key
    useSettings.getState().setKey('deepseek', 'sk-a');
    useSettings.getState().setKey('siliconflow', 'sk-b');
    useSettings.getState().clearKey('deepseek');
    expect(useSettings.getState().keys['deepseek']).toBeUndefined();
    expect(useSettings.getState().keys['siliconflow']).toBe('sk-b');
  });
});
