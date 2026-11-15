import { useState } from 'react';
import { ConfirmDialog, Field } from './bits';
import { SelectMenu } from './SelectMenu';
import { useSettings } from '../store/settings';
import { customProfileId } from '../data/customModels';
import { checkCustomModel, type CustomModelCheckResult } from '../services/customModels/check';
import {
  MAX_CUSTOM_MODELS_PER_MODALITY,
  type CustomModality,
  type CustomModelConfig,
  type CustomModelDraft,
  type CustomModelField,
  type CustomProtocol,
} from '../types/customModel';

/**
 * 设置页「自定义接入」：文字 / 图片 / 视频三条自定义配置。
 *
 * 核心层（task-53）已经提供校验、CRUD、Key 存储、动态档案映射与测试连接；
 * 这一层只做界面：列表、表单、就地错误、测试结果、默认模型下拉的选项来源。
 * 不读不写配置 JSON 以外的存储；Key 一律走 store 的 setCustomModelKey。
 */

const MODALITIES: { key: CustomModality; label: string; hint: string }[] = [
  { key: 'text', label: '文字', hint: '写故事、分镜、对话' },
  { key: 'image', label: '图片', hint: '角色图、场景板、出帧' },
  { key: 'video', label: '视频', hint: '下一批支持生成' },
];

const MODALITY_LABEL: Record<CustomModality, string> = {
  text: '文字',
  image: '图片',
  video: '视频',
};

const PROTOCOL_LABEL: Record<CustomProtocol, string> = {
  'openai-chat': 'OpenAI 兼容 chat',
  'openai-images': 'OpenAI Images（/images/generations）',
  'vllm-omni-chat-image': 'vLLM-Omni chat 多图（/chat/completions）',
  'openai-videos': 'OpenAI Videos（下一批）',
};

const MODALITY_PROTOCOLS: Record<CustomModality, CustomProtocol[]> = {
  text: ['openai-chat'],
  image: ['openai-images', 'vllm-omni-chat-image'],
  video: ['openai-videos'],
};

const MODEL_PLACEHOLDER: Record<CustomModality, string> = {
  text: 'gpt-4o-mini',
  image: 'flux-3-image-klein',
  video: '你的视频模型名',
};

const KEY_STORAGE_HINT =
  'Key 和内置厂商用同一套保存方式：默认存本机；勾了「不保存到本机」就只保留到关闭浏览器。';

interface FormState {
  name: string;
  modality: CustomModality;
  protocol: CustomProtocol;
  baseUrl: string;
  model: string;
  requiresKey: boolean;
  timeoutMs: string;
  maxReferenceImages: string;
  negativePrompt: boolean;
  seed: boolean;
  maxOutputImages: string;
  maxOutputTokens: string;
}

function emptyForm(modality: CustomModality): FormState {
  return {
    name: '',
    modality,
    protocol: MODALITY_PROTOCOLS[modality][0]!,
    baseUrl: '',
    model: '',
    requiresKey: true,
    timeoutMs: '',
    maxReferenceImages: '0',
    negativePrompt: false,
    seed: false,
    maxOutputImages: '1',
    maxOutputTokens: '',
  };
}

function formFromConfig(config: CustomModelConfig): FormState {
  const caps = config.capabilities ?? {};
  return {
    name: config.name,
    modality: config.modality,
    protocol: config.protocol,
    baseUrl: config.baseUrl,
    model: config.model,
    requiresKey: config.requiresKey !== false,
    timeoutMs: config.timeoutMs !== undefined ? String(config.timeoutMs) : '',
    maxReferenceImages: String(caps.maxReferenceImages ?? 0),
    negativePrompt: caps.negativePrompt === true,
    seed: caps.seed === true,
    maxOutputImages: String(caps.maxOutputImages ?? 1),
    maxOutputTokens: caps.maxOutputTokens !== undefined ? String(caps.maxOutputTokens) : '',
  };
}

function numberOrUndefined(value: string): number | undefined {
  const text = value.trim();
  if (text.length === 0) return undefined;
  return Number(text);
}

function draftFromForm(form: FormState): CustomModelDraft {
  const capabilities: CustomModelDraft['capabilities'] = {};
  if (form.modality === 'image') {
    const maxReferenceImages = numberOrUndefined(form.maxReferenceImages);
    const maxOutputImages = numberOrUndefined(form.maxOutputImages);
    if (maxReferenceImages !== undefined) capabilities.maxReferenceImages = maxReferenceImages;
    if (maxOutputImages !== undefined) capabilities.maxOutputImages = maxOutputImages;
    capabilities.negativePrompt = form.negativePrompt;
    capabilities.seed = form.seed;
  } else if (form.modality === 'text') {
    const maxOutputTokens = numberOrUndefined(form.maxOutputTokens);
    if (maxOutputTokens !== undefined) capabilities.maxOutputTokens = maxOutputTokens;
  }
  const timeoutMs = numberOrUndefined(form.timeoutMs);
  return {
    name: form.name,
    modality: form.modality,
    protocol: form.protocol,
    baseUrl: form.baseUrl,
    model: form.model,
    requiresKey: form.requiresKey,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    capabilities,
  };
}

function errorText(errors: Partial<Record<CustomModelField, string>>, field: CustomModelField) {
  return errors[field] ?? '';
}

type Tone = 'ok' | 'warning' | 'error' | 'quiet';

function statusOf(
  config: CustomModelConfig,
  keys: Record<string, string>,
  result: CustomModelCheckResult | undefined,
): { label: string; tone: Tone } {
  // 特殊状态优先于「需不需要 Key」：视频占位和 /models 404 都是可连但无法确认
  if (result?.status === 'not-implemented') return { label: '视频下一批', tone: 'warning' };
  if (result?.status === 'unknown') return { label: '无法自动检测', tone: 'warning' };
  if (!config.requiresKey) {
    return {
      label: result ? (result.ok ? '测试通过' : '测试失败') : '不需要 Key',
      tone: result ? (result.ok ? 'ok' : 'error') : 'ok',
    };
  }
  if (!(keys[`custom:${config.id}`] ?? '').trim()) {
    return { label: '未配置 Key', tone: 'warning' };
  }
  if (!result) return { label: '已保存未测试', tone: 'quiet' };
  if (result.status === 'ready') return { label: '测试通过', tone: 'ok' };
  if (result.status === 'missing-key') return { label: '未配置 Key', tone: 'warning' };
  return { label: '测试失败', tone: 'error' };
}

function resultTone(result: CustomModelCheckResult): Tone {
  // 先看 status 再看 ok：image /models 404 会返回 ok:true,status:'unknown'，
  // 那是「无法自动检测」的警告，不能渲染成绿色成功。
  if (result.status === 'ready') return 'ok';
  if (result.status === 'unknown' || result.status === 'missing-key') return 'warning';
  if (result.status === 'not-implemented') return 'quiet';
  return 'error';
}

/**
 * 写盘失败提示（task-56 会让 CRUD / Key 写入返回失败状态）。
 *
 * 兼容几种可能的返回形状：false、{ ok:false, message }、{ persisted:false }。
 * 目标只有一个：不要把「没存住」显示成成功。
 */
const STORAGE_FAILURE_MESSAGE = '配置没能保存到本机（浏览器存储不可用/已满）。刷新后配置可能丢失。';
const STORAGE_DELETE_FAILURE_MESSAGE = '配置没能从本机删除（浏览器存储不可用/已满）。刷新后可能还在。';

function storageFailure(result: unknown, fallbackMessage = STORAGE_FAILURE_MESSAGE): string | null {
  if (result === false) return fallbackMessage;
  if (typeof result !== 'object' || result === null) return null;
  const value = result as {
    ok?: unknown;
    persisted?: unknown;
    storageError?: unknown;
    message?: unknown;
  };
  const customMessage = typeof value.message === 'string' && value.message.trim().length > 0
    ? value.message
    : fallbackMessage;
  if (value.ok === false) return customMessage;
  if (value.persisted === false || value.storageError === true) return customMessage;
  return null;
}

export function CustomModelSettings() {
  const customModels = useSettings((s) => s.customModels);
  const prefs = useSettings((s) => s.prefs);
  const keys = useSettings((s) => s.keys);
  const addCustomModel = useSettings((s) => s.addCustomModel);
  const updateCustomModel = useSettings((s) => s.updateCustomModel);
  const removeCustomModel = useSettings((s) => s.removeCustomModel);
  const setCustomModelKey = useSettings((s) => s.setCustomModelKey);
  const getCustomModelKey = useSettings((s) => s.getCustomModelKey);

  const [modality, setModality] = useState<CustomModality>('text');
  const [editing, setEditing] = useState<{ id?: string } | null>(null);
  const [form, setForm] = useState<FormState>(() => emptyForm('text'));
  const [errors, setErrors] = useState<Partial<Record<CustomModelField, string>>>({});
  const [formMessage, setFormMessage] = useState<string | null>(null);
  const [keyValue, setKeyValue] = useState('');
  const [deleting, setDeleting] = useState<CustomModelConfig | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [checkResults, setCheckResults] = useState<Record<string, CustomModelCheckResult>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeError, setNoticeError] = useState(false);

  const items = customModels.filter((config) => config.modality === modality);
  const limitReached = items.length >= MAX_CUSTOM_MODELS_PER_MODALITY;
  const editingKeyExists = editing?.id ? getCustomModelKey(editing.id).trim().length > 0 : false;

  function openAdd() {
    setEditing({});
    setForm(emptyForm(modality));
    setErrors({});
    setFormMessage(null);
    setKeyValue('');
  }

  function openEdit(config: CustomModelConfig) {
    setEditing({ id: config.id });
    setForm(formFromConfig(config));
    setErrors({});
    setFormMessage(null);
    setKeyValue('');
  }

  function closeForm() {
    setEditing(null);
    setErrors({});
    setFormMessage(null);
    setKeyValue('');
  }

  /**
   * 本地模型是自定义接入的一种，不再单独配。
   * 这里只做常用本地服务的预填，字段仍可改。
   */
  function openLocalAdd(kind: 'text' | 'image') {
    const base = emptyForm(kind);
    setEditing({});
    setErrors({});
    setFormMessage(null);
    setKeyValue('');
    setForm(
      kind === 'image'
        ? {
            ...base,
            name: '本地图片模型',
            protocol: 'vllm-omni-chat-image',
            baseUrl: 'http://127.0.0.1:8099/v1',
            model: 'flux-3-image-klein',
            requiresKey: false,
            timeoutMs: '600000',
            maxReferenceImages: '10',
            maxOutputImages: '1',
          }
        : {
            ...base,
            name: '本地文字模型',
            protocol: 'openai-chat',
            baseUrl: 'http://127.0.0.1:8100/v1',
            model: 'qwen3.6-27b',
            requiresKey: false,
            timeoutMs: '600000',
          },
    );
  }

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function save() {
    const draft = draftFromForm(form);
    const result = editing?.id ? updateCustomModel(editing.id, draft) : addCustomModel(draft);
    if (!result.ok) {
      const fieldErrors = result.errors ?? {};
      setErrors(fieldErrors);
      // 没有字段级错误时多半是写盘失败（task-56 的失败状态）；不要静默
      setFormMessage(
        result.message ?? (Object.keys(fieldErrors).length === 0 ? STORAGE_FAILURE_MESSAGE : null),
      );
      return;
    }
    const afterSaveFailure = storageFailure(result);
    if (afterSaveFailure) {
      setFormMessage(afterSaveFailure);
      return;
    }
    const saved = result.config;
    if (saved) {
      if (form.requiresKey && keyValue.trim().length > 0) {
        const setKeyUntyped = setCustomModelKey as unknown as (id: string, key: string) => unknown;
        const keyOutcome = setKeyUntyped(saved.id, keyValue.trim());
        const keyFailure = storageFailure(keyOutcome);
        if (keyFailure) {
          setNoticeError(true);
          setNotice(keyFailure);
          closeForm();
          return;
        }
      }
      if (editing?.id) {
        // 编辑后旧测试结果不再代表新配置，清掉避免误导
        setCheckResults((current) => {
          const next = { ...current };
          delete next[editing.id!];
          return next;
        });
      }
      setNoticeError(false);
      setNotice(editing?.id ? `已保存「${saved.name}」。` : `已添加「${saved.name}」。`);
      setModality(saved.modality);
    }
    closeForm();
  }

  async function test(config: CustomModelConfig) {
    if (checking) return;
    setChecking(config.id);
    try {
      const key = config.requiresKey ? getCustomModelKey(config.id) : '';
      const result = await checkCustomModel(config, key);
      setCheckResults((current) => ({ ...current, [config.id]: result }));
    } catch {
      // 核心层保证不抛异常；这里兜底，避免出现「点了没反应」
      setCheckResults((current) => ({
        ...current,
        [config.id]: {
          ok: false,
          status: 'error',
          message: '测试时出了点问题。确认地址、端口、网络可达后再试。',
        },
      }));
    } finally {
      setChecking(null);
    }
  }

  function isDefault(config: CustomModelConfig): boolean {
    const profileId = customProfileId(config.modality, config.id);
    return (
      prefs.defaultLlmProfileId === profileId ||
      prefs.defaultT2iProfileId === profileId ||
      prefs.defaultReferenceProfileId === profileId
    );
  }

  function confirmDelete() {
    const target = deleting;
    if (!target) return;
    const outcome = removeCustomModel(target.id);
    const failure = storageFailure(outcome, STORAGE_DELETE_FAILURE_MESSAGE);
    if (failure) {
      setNoticeError(true);
      setNotice(failure);
      setDeleting(null);
      return;
    }
    setNoticeError(false);
    setNotice(`已删除「${target.name}」。${isDefault(target) ? '默认模型已切回内置默认。' : ''}`);
    setDeleting(null);
  }

  const keyInput = form.requiresKey ? (
    <Field
      label="API Key"
      hint={editingKeyExists ? '已保存过 Key，留空不修改。' : KEY_STORAGE_HINT}
    >
      <input
        type="password"
        aria-label="自定义接入的 API Key"
        autoComplete="off"
        value={keyValue}
        placeholder={editingKeyExists ? '已保存（留空不修改）' : '粘贴 API Key'}
        onChange={(event) => setKeyValue(event.target.value)}
      />
    </Field>
  ) : null;

  return (
    <div className="custom-models">
      <div className="card">
        <h2 className="card-title">自定义接入</h2>
        <p style={{ fontSize: 13, color: 'var(--text-dim)', marginTop: 0 }}>
          接你自己的 OpenAI 兼容服务。配置只存在本机，Key 不进配置 JSON；服务需要允许浏览器直连（CORS）。
          FLUX3、本机 vLLM 等本地模型也在这里配置。
        </p>

        <div className="custom-tabs" role="tablist" aria-label="自定义接入类型">
          {MODALITIES.map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={modality === item.key}
              className={`btn btn-sm ${modality === item.key ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setModality(item.key)}
            >
              {item.label}
              <span className="custom-tab-hint">{item.hint}</span>
            </button>
          ))}
        </div>

        <div className="row" style={{ justifyContent: 'space-between', marginTop: 12 }}>
          <span className="hint" style={{ marginTop: 0 }}>
            {MODALITY_LABEL[modality]}配置 {items.length} / {MAX_CUSTOM_MODELS_PER_MODALITY}
          </span>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            {modality === 'text' ? (
              <button
                type="button"
                className="btn btn-sm"
                disabled={limitReached}
                aria-label="新建本地文字模型"
                title={
                  limitReached
                    ? '已达 10 条上限，先删一条'
                    : '预填本机 vLLM / OpenAI 兼容文字服务；字段可改'
                }
                onClick={() => openLocalAdd('text')}
              >
                新建本地文字模型
              </button>
            ) : null}
            {modality === 'image' ? (
              <button
                type="button"
                className="btn btn-sm"
                disabled={limitReached}
                aria-label="新建本地图片模型"
                title={
                  limitReached
                    ? '已达 10 条上限，先删一条'
                    : '预填本机 vLLM-Omni / FLUX3；字段可改'
                }
                onClick={() => openLocalAdd('image')}
              >
                新建本地图片模型
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-blue btn-sm"
              disabled={limitReached}
              aria-label={`新增${MODALITY_LABEL[modality]}自定义接入`}
              title={limitReached ? '每个类型最多 10 条' : '新增一条自定义接入'}
              onClick={openAdd}
            >
              + 新增{MODALITY_LABEL[modality]}
            </button>
          </div>
        </div>
        {limitReached ? (
          <div className="hint" style={{ marginTop: 4 }}>
            已达 {MAX_CUSTOM_MODELS_PER_MODALITY} 条上限，先删一条。
          </div>
        ) : null}

        {notice ? (
          <div
            className={`issue${noticeError ? ' error' : ''}`}
            style={{ marginTop: 10, marginBottom: 0 }}
            role={noticeError ? 'alert' : 'status'}
          >
            <div className="issue-line">{notice}</div>
          </div>
        ) : null}

        {items.length === 0 ? (
          <div className="empty" style={{ marginTop: 14 }}>
            还没有{MODALITY_LABEL[modality]}自定义接入。点右上角「新增{MODALITY_LABEL[modality]}」加一条。
          </div>
        ) : (
          <div className="custom-list">
            {items.map((config) => {
              const result = checkResults[config.id];
              const status = statusOf(config, keys, result);
              const tone = result ? resultTone(result) : status.tone;
              return (
                <div className="custom-model" key={config.id}>
                  <div className="custom-model-head">
                    <div className="custom-model-title">
                      <b>{config.name}</b>
                      <span className="tag">{PROTOCOL_LABEL[config.protocol]}</span>
                      <span className={`custom-status is-${tone}`}>{status.label}</span>
                    </div>
                    <div className="custom-actions">
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={checking === config.id}
                        aria-label={`测试「${config.name}」的连接`}
                        title="只做最小探测，不发出真实生成请求"
                        onClick={() => void test(config)}
                      >
                        {checking === config.id ? '测试中…' : '测试连接'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        aria-label={`编辑「${config.name}」`}
                        onClick={() => openEdit(config)}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        aria-label={`删除「${config.name}」`}
                        onClick={() => setDeleting(config)}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                  <div className="hint custom-url" title={config.baseUrl} style={{ marginTop: 2 }}>
                    {config.baseUrl}
                  </div>
                  <div className="hint" style={{ marginTop: 2 }}>
                    模型：<code>{config.model}</code>
                    {config.timeoutMs !== undefined ? ` · 超时 ${config.timeoutMs}ms` : ''}
                  </div>
                  {config.modality === 'video' ? (
                    <div className="hint" style={{ marginTop: 2 }}>
                      视频接入下一批支持生成；当前只能保存配置和测试连接。
                    </div>
                  ) : null}
                  {result ? (
                    <div
                      className={`issue ${tone === 'warning' ? 'warning' : tone === 'error' ? 'error' : ''}`}
                      role="status"
                      aria-live="polite"
                      data-tone={tone}
                      style={{
                        marginTop: 8,
                        marginBottom: 0,
                        borderLeftColor:
                          tone === 'ok'
                            ? 'var(--ok)'
                            : tone === 'quiet'
                              ? 'var(--text-faint)'
                              : undefined,
                      }}
                    >
                      <div className="issue-line">{result.message}</div>
                      {result.detail ? (
                        <details className="why">
                          <summary>服务返回的原始信息</summary>
                          <div className="why-body">
                            <pre>{result.detail.slice(0, 300)}</pre>
                          </div>
                        </details>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}

        <details className="why" style={{ marginTop: 14 }}>
          <summary>自定义接入的安全与限制</summary>
          <div className="why-body">
            <div>自定义接入的 Key 默认保存在本机浏览器；勾了「不保存到本机」就只保留到关闭浏览器。</div>
            <div style={{ marginTop: 4 }}>
              自定义服务需要允许浏览器直连（CORS）。HTTPS 页面连 HTTP 本地服务可能被混合内容拦截，建议端口转发或同源反代。
            </div>
            <div style={{ marginTop: 4 }}>
              图片协议的参考图能力按你勾选的声明发送；不确定就不要开，默认 0。
            </div>
            <div style={{ marginTop: 4 }}>
              OpenAI Images 协议的参考图字段是兼容性假设，标准 OpenAI 图片生成不一定接受；不确定时把参考图上限留 0。
            </div>
            <div style={{ marginTop: 4 }}>删除配置会清掉它的 Key；如果它是默认模型，会自动切回内置默认。</div>
          </div>
        </details>
      </div>

      <ConfirmDialog
        open={editing !== null}
        title={editing?.id ? '编辑自定义接入' : '新增自定义接入'}
        confirmLabel="保存"
        cancelLabel="取消"
        onConfirm={save}
        onCancel={closeForm}
      >
        <div style={{ display: 'grid', gap: 12 }}>
          {Object.keys(errors).length > 0 ? (
            <div className="issue error" style={{ margin: 0 }}>
              <div className="issue-title">还有几项要改</div>
              {Object.entries(errors).map(([field, message]) => (
                <div className="issue-line" key={field}>
                  {message}
                </div>
              ))}
            </div>
          ) : null}
          {formMessage ? <div className="issue error" style={{ margin: 0 }}>{formMessage}</div> : null}

          <Field label="显示名" hint="例如：我的 OpenAI">
            <input
              type="text"
              aria-label="显示名"
              value={form.name}
              onChange={(event) => update('name', event.target.value)}
            />
            {errorText(errors, 'name') ? (
              <div className="field-error">{errorText(errors, 'name')}</div>
            ) : null}
          </Field>

          <Field
            label="类型"
            hint={editing?.id ? '已有配置的类型不能改；要换类型请删除后新增。' : '文字用于故事/分镜，图片用于出图。'}
          >
            <SelectMenu
              value={form.modality}
              disabled={Boolean(editing?.id)}
              options={MODALITIES.map((item) => ({
                value: item.key,
                label: item.label,
                hint: item.hint,
              }))}
              ariaLabel="自定义接入类型"
              onChange={(value) => {
                const next = value as CustomModality;
                update('modality', next);
                update('protocol', MODALITY_PROTOCOLS[next][0]!);
              }}
            />
          </Field>

          <Field label="协议" hint="接口要跟协议匹配；视频协议本批只是占位。">
            <SelectMenu
              value={form.protocol}
              options={MODALITY_PROTOCOLS[form.modality].map((protocol) => ({
                value: protocol,
                label: PROTOCOL_LABEL[protocol],
              }))}
              ariaLabel="自定义接入协议"
              onChange={(value) => update('protocol', value as CustomProtocol)}
            />
            {errorText(errors, 'protocol') ? (
              <div className="field-error">{errorText(errors, 'protocol')}</div>
            ) : null}
          </Field>

          <Field
            label="接口地址"
            hint="通常要含 /v1。例：https://api.openai.com/v1，或本地 http://127.0.0.1:8099/v1"
          >
            <input
              type="text"
              aria-label="接口地址"
              value={form.baseUrl}
              placeholder="https://api.openai.com/v1"
              onChange={(event) => update('baseUrl', event.target.value)}
            />
            {errorText(errors, 'baseUrl') ? (
              <div className="field-error">{errorText(errors, 'baseUrl')}</div>
            ) : null}
          </Field>

          <Field label="模型名" hint="填服务端实际接受的模型 id。">
            <input
              type="text"
              aria-label="模型名"
              value={form.model}
              placeholder={MODEL_PLACEHOLDER[form.modality]}
              onChange={(event) => update('model', event.target.value)}
            />
            {errorText(errors, 'model') ? (
              <div className="field-error">{errorText(errors, 'model')}</div>
            ) : null}
          </Field>

          <label className="row" style={{ gap: 8, fontSize: 13, cursor: 'pointer', width: 'auto' }}>
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={form.requiresKey}
              aria-label="需要 API Key"
              onChange={(event) => update('requiresKey', event.target.checked)}
            />
            需要 API Key（本地模型可关掉）
          </label>

          {keyInput}

          <Field label="超时（毫秒，可选）" hint="1000–600000；留空用默认。">
            <input
              type="text"
              inputMode="numeric"
              aria-label="超时毫秒"
              value={form.timeoutMs}
              placeholder="60000"
              onChange={(event) => update('timeoutMs', event.target.value)}
            />
            {errorText(errors, 'timeoutMs') ? (
              <div className="field-error">{errorText(errors, 'timeoutMs')}</div>
            ) : null}
          </Field>

          {form.modality === 'image' ? (
            <div className="custom-capabilities">
              <b style={{ fontSize: 13 }}>图片能力</b>
              <div className="hint" style={{ marginTop: 2 }}>
                不确定的能力请留 0 / 不勾，不会自动猜。
              </div>
              <Field label="参考图上限" hint="默认 0 表示不声明参考图能力。">
                <input
                  type="text"
                  inputMode="numeric"
                  aria-label="参考图上限"
                  value={form.maxReferenceImages}
                  onChange={(event) => update('maxReferenceImages', event.target.value)}
                />
              </Field>
              <Field label="最多出图张数" hint="默认 1；出图至少 1 张。">
                <input
                  type="text"
                  inputMode="numeric"
                  aria-label="最多出图张数"
                  value={form.maxOutputImages}
                  onChange={(event) => update('maxOutputImages', event.target.value)}
                />
              </Field>
              <label className="row" style={{ gap: 8, fontSize: 13, cursor: 'pointer', width: 'auto' }}>
                <input
                  type="checkbox"
                  style={{ width: 'auto' }}
                  checked={form.negativePrompt}
                  aria-label="支持负向词"
                  onChange={(event) => update('negativePrompt', event.target.checked)}
                />
                支持负向词
              </label>
              <label className="row" style={{ gap: 8, fontSize: 13, cursor: 'pointer', width: 'auto' }}>
                <input
                  type="checkbox"
                  style={{ width: 'auto' }}
                  checked={form.seed}
                  aria-label="支持 seed"
                  onChange={(event) => update('seed', event.target.checked)}
                />
                支持 seed
              </label>
              {errorText(errors, 'capabilities') ? (
                <div className="field-error">{errorText(errors, 'capabilities')}</div>
              ) : null}
            </div>
          ) : null}

          {form.modality === 'text' ? (
            <Field
              label="最大输出 token（可选，用于限制生成长度）"
              hint="留空用任务默认上限；填了必须是 ≥1 的整数。"
            >
              <input
                type="text"
                inputMode="numeric"
                aria-label="最大输出 token"
                value={form.maxOutputTokens}
                onChange={(event) => update('maxOutputTokens', event.target.value)}
              />
              {errorText(errors, 'capabilities') ? (
                <div className="field-error">{errorText(errors, 'capabilities')}</div>
              ) : null}
            </Field>
          ) : null}

          {form.modality === 'video' ? (
            <div className="issue warning" style={{ margin: 0 }}>
              <div className="issue-line">视频接入下一批支持生成；现在可以先保存配置和测试连接。</div>
            </div>
          ) : null}
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={deleting !== null}
        title="删除自定义接入"
        confirmLabel="删除"
        cancelLabel="取消"
        onConfirm={confirmDelete}
        onCancel={() => setDeleting(null)}
      >
        {deleting ? (
          <>
            <p style={{ marginTop: 0 }}>
              会删除「{deleting.name}」的配置和它的 API Key，无法撤销。
            </p>
            {isDefault(deleting) ? (
              <p>它现在是默认模型；删除后会自动切回内置默认。</p>
            ) : null}
          </>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
