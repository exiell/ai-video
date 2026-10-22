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

/**
 * 颜色词表。
 *
 * ===========================================================================
 * v0.39：中文颜色词最短两个字符，英文按词边界匹配
 * ===========================================================================
 * 原来这份表里有「白」「黑」「红」「灰」这样的单字，用 `text.includes()` 匹配。
 * 结果是把大量**非颜色**的词判成了颜色：
 *
 *   他**明白**了 → 命中「白」
 *   **白天**的光 → 命中「白」
 *   **黑夜**里 → 命中「黑」
 *   英文 hun**dred** → 命中「red」，blue**tooth** → 命中「blue」
 *
 * 于是「这一镜的色调与场景不一致」这条**在正常文本上就会误报**，
 * 而误报会训练用户跳过整份检查单——比不检查更糟。
 *
 * 修法：中文一律用两字及以上的词（单字在中文里不是词，只是词素）；
 * 英文用 `\b` 词边界。代价是「墙是白的」这种写法不再命中，
 * 但那本来就该写成「白色」。
 */
const COLOR_WORDS_ZH = [
  // 复合色（带修饰字）
  '冷灰蓝', '暖橙', '暖黄', '雪白', '青灰', '灰绿', '米白', '灰蓝',
  '墨绿', '藏青', '靛蓝', '暗红', '土黄', '米黄', '乳白', '银白',
  '血红', '漆黑', '惨白', '深蓝', '浅蓝', '淡黄',
  // 基本色
  '白色', '黑色', '红色', '绿色', '蓝色', '青色', '紫色', '灰色',
  '棕色', '金色', '银色', '橙色', '粉色', '黄色', '褐色',
];

/** 英文颜色词，按词边界匹配（`hundred` 里没有 red，`bluetooth` 里没有 blue） */
const COLOR_WORDS_EN = [
  'golden', 'orange', 'red', 'green', 'blue', 'cyan', 'purple',
  'grey', 'gray', 'brown', 'white', 'black', 'teal', 'amber', 'crimson', 'indigo',
];

const COLOR_WORDS = COLOR_WORDS_ZH;

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
  const zh = COLOR_WORDS_ZH.filter((c) => text.includes(c));
  const en = COLOR_WORDS_EN.filter((c) => new RegExp(`\\b${c}\\b`, 'i').test(text));
  return [...zh, ...en];
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
          why:  '不写下来，模型每镜都会重新布置这个空间，看着像换了个地方。',
          suggestion:  '列出一直都在的东西，3–5 条，例如 rows of wooden desks facing a green blackboard。',
          location: { kind: 'scene', id: scene.id, field: 'fixedElements' },
        }),
      );
    }
    if (!scene.identity.spatialStructure.trim()) {
      issues.push(
        makeIssue({
          ruleId: 'scene-missing-space',
          severity: 'warning',
          title: `${label}没有写空间结构`,
          why:  '不写布局，模型每镜重新猜一遍，就成了「角色在动、场景在换」。',
          suggestion:  '用房间的方位写：门在哪、什么在左、什么在右。别写「左边有门」——那是画面左边，反打之后就不对了。',
          location: { kind: 'scene', id: scene.id, field: 'identity.spatialStructure' },
        }),
      );
    }
    if (!scene.lightDirection.trim()) {
      issues.push(
        makeIssue({
          ruleId: 'scene-light-conflict',
          severity: 'warning',
          title: `${label}没有写主光方向`,
          why:  '光从哪来，决定同一处地方在不同镜头里像不像同一个时刻。',
          suggestion:  '填一句，例如：傍晚，暖光从右侧窗户斜射进来。',
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
          why:  '色调是观众判断「还是不是这个地方」最快的线索。',
          suggestion:  '填一个色对，例如：暖橙 + 灰绿。',
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
          why:  '不指定场景，这一镜的固定元素、光线和色调都无从锁定。',
          suggestion:  `给第 ${shot.number} 镜选一个场景；新地方先去场景设定里建出来。`,
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
          why:  '镜头还记着它，提示词里却已经取不到这个场景了。',
          suggestion:  `给第 ${shot.number} 镜重选一个，或把删掉的场景恢复回来。`,
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
            why:  `场景「${scene.name}」是「${scene.lightDirection || scene.timeOfDay}」（${sceneWord}），这一镜写成了「${shotWord}」；除非剧情要变时间，观众会觉得换了地方。`,
            suggestion:  '把这一镜改成和场景一致；或者给这个场景建一个变体，说明时间真的变了。',
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
              why:  `场景主色是「${scene.mainColor}」，这一镜写的是「${shotColors.join('、')}」；色调差最容易被当成换了地方。`,
              suggestion:  '有意的（比如情绪转折）可以不管；不是的话，把颜色词往主色上靠。',
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
          why:  '它可能被忘了，也可能这段戏被删了。',
          suggestion:  '该用就补镜头，不需要就删掉。',
          location: { kind: 'scene', id: scene.id },
        }),
      );
    }
  }

  return issues;
}

export { findTerms, findColorWords, TIME_WORDS, LIGHT_QUALITY, COLOR_WORDS, COLOR_WORDS_EN };
