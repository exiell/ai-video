import type { CheckIssue, Project, SceneCard, Shot } from '../../types/model';
import { makeIssue, shotLabel } from './shared';

/**
 * 场景一致性检查（方案.md v0.6 §3.2，用户明确要求纳入审查范围）
 *
 * 覆盖规则：
 *  - scene-not-registered   镜头发生在一个没登记过的场景
 *  - scene-missing-elements 镜头没写该场景的固定元素，换个镜头就认不出是同一处地方
 *  - scene-light-conflict   镜头的光线/时段与场景卡的设定冲突
 *  - scene-color-drift      镜头出现了与场景主色调不符的颜色词
 *  - （附加）场景卡本身缺固定元素 / 光线 / 主色调，提示补齐
 *
 * 注意：若该镜启用了场景的某个变体，且该变体就是用来改光线或状态的，
 * 则不再报冲突——那是剧情有意为之，不是穿帮。
 */

/** 时段与光线词表，用于冲突检测 */
const TIME_WORDS: Record<string, string[]> = {
  dawn: ['黎明', '破晓', '拂晓', 'dawn', 'sunrise'],
  morning: ['清晨', '早晨', '上午', '早间', 'morning'],
  noon: ['正午', '中午', '晌午', 'noon', 'midday'],
  afternoon: ['下午', '午后', 'afternoon'],
  dusk: ['傍晚', '黄昏', '日落', '夕阳', 'dusk', 'sunset', 'evening'],
  night: ['夜晚', '深夜', '夜里', '入夜', '晚上', 'night', 'midnight'],
};

/**
 * 光质词表。用于判断镜头写的光，和场景卡定的光，是不是同一种。
 *
 * 注意：中文里「冷调」「清冷」这类写法很常见，必须收进来，
 * 否则场景卡说「冷调」、镜头写「暖光」时无法判定为冲突。
 */
const LIGHT_QUALITY: Record<string, string[]> = {
  warm: ['暖光', '暖色', '暖调', '金色光', '橘色光', '暖橙', 'warm light', 'golden hour', 'warm glow', 'warm tone'],
  cool: ['冷光', '冷色', '冷调', '青蓝', '清冷', '月光', 'cool light', 'cold light', 'cold tone', 'moonlight', 'blue hour'],
  overcast: ['阴天', '阴冷', '灰蒙蒙', '无投影', '散光', 'overcast', 'diffuse light'],
  harsh: ['顶光', '硬光', '直射', '烈日', '刺眼', 'harsh light', 'direct sunlight', 'harsh sun'],
};

const COLOR_WORDS = [
  '冷灰蓝', '暖橙', '暖黄', '雪白', '青灰',
  '金', '橙', '红', '绿', '蓝', '青', '紫', '灰', '棕', '白', '黑',
  'golden', 'orange', 'red', 'green', 'blue', 'cyan', 'purple', 'grey', 'gray',
  'brown', 'white', 'black', 'teal', 'amber',
];

function shotVisualText(shot: Shot): string {
  return [shot.startState, shot.action, shot.endState, shot.mood, shot.cameraPosition].join(' ');
}

function findTerms(text: string, table: Record<string, string[]>): string[] {
  const lower = text.toLowerCase();
  const hits: string[] = [];
  for (const [key, words] of Object.entries(table)) {
    if (words.some((w) => lower.includes(w.toLowerCase()))) hits.push(key);
  }
  return hits;
}

function findColorWords(text: string): string[] {
  // 保留所有命中，不做「最长匹配优先」的互斥处理。
  // 复合色由 overlaps() 用包含关系判定：「暖橙」既是暖橙也是橙。
  // 如果在这里就把「暖橙」吃掉，「橙」永远匹配不到，相交判定会假阳性。
  return COLOR_WORDS.filter((c) => text.includes(c));
}

/** 两个颜色词是否指向同一种颜色（支持复合色包含关系） */
function colorOverlaps(shotColors: string[], sceneColors: string[]): boolean {
  return shotColors.some((s) => sceneColors.some((c) => s.includes(c) || c.includes(s)));
}

/**
 * 该镜是否启用了某个场景变体。
 * 启用变体意味着「剧情有意改变了这个场景」，因此豁免光线/色调冲突检查。
 */
function hasSceneVariantActive(shot: Shot, scene: SceneCard): boolean {
  const sceneVariantIds = new Set(scene.variants.map((v) => v.id));
  return shot.variantIds.some((id) => sceneVariantIds.has(id));
}

export function checkScenes(project: Project): CheckIssue[] {
  const issues: CheckIssue[] = [];

  for (const scene of project.scenes) {
    const label = `场景「${scene.name}」`;

    if (scene.fixedElements.length === 0) {
      issues.push(
        makeIssue({
          ruleId: 'scene-missing-elements',
          severity: 'warning',
          title: `${label}没有登记固定元素`,
          why: '固定元素是观众用来认出「这是同一个地方」的依据。不写下来，模型每个镜头都会重新布置一遍这个空间，看起来就像换了个地方。',
          suggestion: `列出这个场景里**一直都在**的东西，用能直接贴进提示词的短语，例如：rows of wooden desks facing a green blackboard。3–5 条就够。`,
          location: { kind: 'scene', id: scene.id, field: 'fixedElements' },
        }),
      );
    }
    if (!scene.lightDirection.trim()) {
      issues.push(
        makeIssue({
          ruleId: 'scene-light-conflict',
          severity: 'warning',
          title: `${label}没有写主光方向`,
          why: '光从哪来，决定了同一处地方在不同镜头里看起来像不像同一个时刻。',
          suggestion: `填一句就够，例如：傍晚，暖光从右侧窗户斜射进来。`,
          location: { kind: 'scene', id: scene.id, field: 'lightDirection' },
        }),
      );
    }
    if (!scene.mainColor.trim()) {
      issues.push(
        makeIssue({
          ruleId: 'scene-color-drift',
          severity: 'warning',
          title: `${label}没有写主色调`,
          why: '色调是观众判断「还是不是这个地方」最直接的线索。',
          suggestion: `填一句就够，例如：暖橙 + 灰绿。`,
          location: { kind: 'scene', id: scene.id, field: 'mainColor' },
        }),
      );
    }
  }

  for (const shot of project.shots) {
    const shotLabelText = shotLabel(shot.number);
    const scene = project.scenes.find((s) => s.id === shot.sceneId);
    const text = shotVisualText(shot);

    // 规则：镜头没有归属场景
    if (!shot.sceneId) {
      issues.push(
        makeIssue({
          ruleId: 'scene-not-registered',
          severity: 'error',
          title: `${shotLabelText}还没有归属到任何场景`,
          why: '场景是场景一致性的锚点。不指定场景，这一镜的固定元素、光线和色调都无从锁定。',
          suggestion: `在分镜表里给第 ${shot.number} 镜选一个场景；如果这段故事发生在一个新地方，先去场景设定里把它建出来。`,
          location: { kind: 'shot', id: shot.id, field: 'sceneId' },
        }),
      );
      continue;
    }

    // 规则：镜头指向的场景不存在
    if (!scene) {
      issues.push(
        makeIssue({
          ruleId: 'scene-not-registered',
          severity: 'error',
          title: `${shotLabelText}指向的场景已经不存在了`,
          why: '它可能被删掉了，但镜头还记着它。这种断链会让提示词里缺少场景描述。',
          suggestion: `重新给第 ${shot.number} 镜选择场景，或恢复被删掉的场景。`,
          location: { kind: 'shot', id: shot.id, field: 'sceneId' },
        }),
      );
      continue;
    }

    const variantActive = hasSceneVariantActive(shot, scene);

    // ---------------------------------------------------------------------
    // 【v0.23 撤掉的一条规则】
    // ---------------------------------------------------------------------
    // 原来这里有一条「镜头正文没有提到场景的标志物」的警告。
    // 它**在正常用法下几乎必然误报**，因为：
    //   * 用户用中文写画面描述，而固定元素登记的是英文短语 → 字面永远匹配不上
    //   * 更根本的是，**固定元素本来就会被自动注入到出图提示词里**
    //     （见 domain/image/prompts.ts 里 scene.fixedElements 的注入），
    //     所以正文提没提根本不影响生成结果
    //
    // 一个「在正常用法下必然报警、而且报的还是系统已经自动处理好的事」的规则，
    // 只会训练用户忽略整份检查单。删掉它比留着更有价值。
    //
    // 它想防的真实问题（这一镜的空间不被固定）由另外两条覆盖：
    //   * 场景没登记固定元素 → scene-missing-elements（场景卡级）
    //   * 这一镜没勾场景锁 → 已由 addLockProposals 自动补齐
    void variantActive;

    // 规则：光线 / 时段冲突
    if (!variantActive) {
      const sceneTimes = findTerms(scene.lightDirection + ' ' + (scene.timeOfDay ?? ''), TIME_WORDS);
      const shotTimes = findTerms(text, TIME_WORDS);
      // 场景可能同时提到多个时段（如「傍晚到入夜」），因此只要镜头写的时段在场景名单里就不算冲突
      const conflictTime = shotTimes.find((t) => sceneTimes.length > 0 && !sceneTimes.includes(t));

      const sceneQuality = findTerms(scene.lightDirection + ' ' + scene.mainColor, LIGHT_QUALITY);
      const shotQuality = findTerms(text, LIGHT_QUALITY);
      // 只要镜头写了场景没写过的光质，就算冲突。
      // （不能用「取第一个」的写法：一盏暖灯 + 冷调环境是合法的，
      //   但场景卡里没提暖光时，镜头突然写「暖光洒满房间」就是穿帮。）
      const conflictQuality = shotQuality.find(
        (q) => sceneQuality.length > 0 && !sceneQuality.includes(q),
      );

      if (conflictTime || conflictQuality) {
        const isTime = Boolean(conflictTime);
        const sceneWord = isTime ? sceneTimes.join('/') : sceneQuality.join('/');
        const shotWord = isTime ? conflictTime : conflictQuality;
        const aspect = isTime ? '时段' : '光线性质';
        issues.push(
          makeIssue({
            ruleId: 'scene-light-conflict',
            severity: 'warning',
            title: `${shotLabelText}的${aspect}与场景设定不一致`,
            why: `场景「${scene.name}」设定的是「${scene.lightDirection || scene.timeOfDay}」，也就是「${sceneWord}」；但这一镜写成了「${shotWord}」。除非剧情要求时间变化，否则观众会觉得换了个地方或者穿帮了。`,
            suggestion: `两个选择：把这一镜改成与场景一致；或者，如果剧情就是要变（比如从天亮拍到天黑），去场景设定里为它建一个变体，这样系统会知道这是有意的，不再报冲突。`,
            location: { kind: 'shot', id: shot.id, field: isTime ? 'startState' : 'mood' },
          }),
        );
      }
    }

    // 规则：主色调漂移
    if (!variantActive && scene.mainColor.trim()) {
      const sceneColors = findColorWords(scene.mainColor);
      const shotColors = findColorWords(text);
      if (sceneColors.length > 0 && shotColors.length > 0) {
        if (!colorOverlaps(shotColors, sceneColors)) {
          issues.push(
            makeIssue({
              ruleId: 'scene-color-drift',
              severity: 'info',
              title: `${shotLabelText}的色调可能与「${scene.name}」不一致`,
              why: `场景主色调是「${scene.mainColor}」，但这一镜的画面描述里出现的是「${shotColors.join('、')}」。色调差异是观众判断「换了地方」最直接的线索。`,
              suggestion: `如果是有意的（比如情绪转折），可以忽略；如果不是，把这一镜的颜色词往场景主色调上靠一靠。`,
              location: { kind: 'shot', id: shot.id, field: 'startState' },
            }),
          );
        }
      }
    }
  }

  // 规则：场景登记了但全片没用上
  for (const scene of project.scenes) {
    const used = project.shots.some((s) => s.sceneId === scene.id);
    if (!used) {
      issues.push(
        makeIssue({
          ruleId: 'scene-not-registered',
          severity: 'info',
          title: `场景「${scene.name}」在分镜里一次都没用到`,
          why: '它可能是被忘了，也可能是这段戏被删了。',
          suggestion: `确认一下：该用就补镜；不需要就删掉，避免设定越来越乱。`,
          location: { kind: 'scene', id: scene.id },
        }),
      );
    }
  }

  return issues;
}

export { findTerms, findColorWords, TIME_WORDS, LIGHT_QUALITY, COLOR_WORDS };
