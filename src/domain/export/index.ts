import type { CheckReport, Project } from '../../types/model';
import { PLATFORM_LABEL } from '../../types/model';
import { buildAllPrompts } from '../prompt';

/**
 * 导出引擎（方案.md v0.6 §7.2 任务 7）
 *
 * 交付物清单（§1.5）：
 *  - 分镜表.csv / .md
 *  - 角色设定卡.md
 *  - 场景设定卡.md
 *  - 提示词/各平台.md        ← 英文正文 + 中文对照 + 逐项说明
 *  - 穿帮检查单.md
 *  - 拍摄进度表.md
 */

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** CSV 字段转义：含逗号、引号、换行时用双引号包裹 */
function csvCell(value: string | number | undefined): string {
  const s = value === undefined ? '' : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function csvRow(cells: (string | number | undefined)[]): string {
  return cells.map(csvCell).join(',');
}

/** 文件名安全化 */
export function safeFileName(name: string, fallback = 'aniguide'): string {
  const cleaned = name.replace(/[\\/:*?"<>|\n\r\t]/g, '_').trim();
  return cleaned.length > 0 ? cleaned.slice(0, 80) : fallback;
}

// ---------------------------------------------------------------------------
// 分镜表
// ---------------------------------------------------------------------------

export const STORYBOARD_HEADERS = [
  '镜号',
  '时长(秒)',
  '场景',
  '景别',
  '机位',
  '运镜',
  '起点',
  '动作',
  '终点',
  '台词/旁白',
  '声音',
  '情绪',
  '转场',
  '出镜角色',
] as const;

export function storyboardToCsv(project: Project): string {
  const lines: string[] = [csvRow([...STORYBOARD_HEADERS])];
  for (const shot of project.shots) {
    const scene = project.scenes.find((s) => s.id === shot.sceneId);
    const characters = project.characters
      .filter((c) => shot.characterIds.includes(c.id))
      .map((c) => c.name)
      .join('、');
    lines.push(
      csvRow([
        shot.number,
        shot.duration,
        scene?.name ?? '',
        shot.shotSize,
        shot.cameraPosition,
        shot.cameraMove,
        shot.startState,
        shot.action,
        shot.endState,
        shot.dialogue,
        shot.sound,
        shot.mood,
        shot.transition,
        characters,
      ]),
    );
  }
  // 加 BOM，Excel 打开中文不乱码
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

export function storyboardToMarkdown(project: Project): string {
  const total = project.shots.reduce((s, x) => s + (Number.isFinite(x.duration) ? x.duration : 0), 0);
  const out: string[] = [];
  out.push(`# ${project.name} · 分镜表`);
  out.push('');
  if (project.logline) out.push(`> ${project.logline}`);
  out.push('');
  out.push(`- 镜头数：${project.shots.length}`);
  out.push(`- 总时长：${total} 秒（目标 ${project.brief.targetDuration} 秒）`);
  out.push(`- 画幅：${project.brief.aspectRatio || '未设置'}`);
  out.push(`- 目标平台：${project.brief.platforms.map((p) => PLATFORM_LABEL[p]).join(' / ') || '未设置'}`);
  out.push('');

  for (const shot of project.shots) {
    const scene = project.scenes.find((s) => s.id === shot.sceneId);
    const characters = project.characters.filter((c) => shot.characterIds.includes(c.id));
    out.push(`## 第 ${shot.number} 镜 · ${shot.duration} 秒${scene ? ` · ${scene.name}` : ''}`);
    out.push('');
    out.push(`- **景别 / 机位**：${shot.shotSize} / ${shot.cameraPosition || '未设置'}`);
    out.push(`- **运镜**：${shot.cameraMove}`);
    out.push(`- **起点**：${shot.startState || '（空）'}`);
    out.push(`- **动作**：${shot.action || '（空）'}`);
    out.push(`- **终点**：${shot.endState || '（空）'}`);
    if (shot.dialogue) out.push(`- **台词 / 旁白**：${shot.dialogue}`);
    if (shot.sound) out.push(`- **声音**：${shot.sound}`);
    if (shot.mood) out.push(`- **情绪**：${shot.mood}`);
    if (shot.transition) out.push(`- **转场**：${shot.transition}`);
    if (characters.length > 0) {
      out.push(`- **出镜角色**：${characters.map((c) => c.name).join('、')}`);
    }
    if (shot.offscreenCharacters.length > 0) {
      out.push(`- **画外**：${shot.offscreenCharacters.join('、')}`);
    }
    out.push('');
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// 角色卡与场景卡
// ---------------------------------------------------------------------------

export function charactersToMarkdown(project: Project): string {
  const out: string[] = [];
  out.push(`# ${project.name} · 角色设定卡`);
  out.push('');
  out.push('> 每个角色分三层：**身份**（跨集不变）、**变体**（随剧情变）、**连续性锁**（必须跨镜保持）。');
  out.push('> 锁面会被原样写进每一镜的提示词，这是角色不走样的关键。');
  out.push('');

  if (project.characters.length === 0) {
    out.push('（还没有角色）');
    return out.join('\n');
  }

  for (const character of project.characters) {
    out.push(`## ${character.name}`);
    out.push('');
    out.push(`- 重要度：${character.role}`);
    out.push('');
    out.push('### 身份（不变）');
    out.push('');
    out.push(`- 概述：${character.identity.summary || '（未填）'}`);
    out.push(`- 面部：${character.identity.face || '（未填）'}`);
    out.push(`- 发型：${character.identity.hair || '（未填）'}`);
    out.push(`- 体型：${character.identity.bodyType || '（未填）'}`);
    out.push(`- 年龄：${character.identity.ageRange || '（未填）'}`);
    out.push(`- 英文描述：\`${character.identity.summaryEn || '（未填）'}\``);
    out.push('');

    out.push('### 连续性锁（必须跨镜保持）');
    out.push('');
    if (character.continuityLocks.length === 0) {
      out.push('注意： 还没有任何连续性锁。没有锁，模型每一镜都会重新想象这个人的样子。');
    } else {
      for (const lock of character.continuityLocks) {
        out.push(`- **${lock.label}**（${lock.appliesTo}）`);
        out.push(`  - 锁面：\`${lock.phrase}\``);
      }
    }
    out.push('');

    out.push('### 变体（随剧情变）');
    out.push('');
    if (character.variants.length === 0) {
      out.push('（无变体）');
    } else {
      for (const variant of character.variants) {
        const shots = variant.shotIds
          .map((id) => project.shots.find((s) => s.id === id)?.number)
          .filter((n): n is number => n !== undefined);
        out.push(`- **${variant.label}**：${variant.changedFeatures.join('、') || '（未写改变了什么）'}`);
        out.push(`  - 生效镜头：${shots.length > 0 ? shots.map((n) => `第 ${n} 镜`).join('、') : '（尚未分配）'}`);
      }
    }
    out.push('');

    if (character.negativePrompt) {
      out.push(`### 负向词`);
      out.push('');
      out.push(`\`${character.negativePrompt}\``);
      out.push('');
    }
    if (character.seed !== undefined) {
      out.push(`### 固定种子`);
      out.push('');
      out.push(`\`${character.seed}\`（在支持种子的平台上使用，可进一步稳定形象）`);
      out.push('');
    }
  }
  return out.join('\n');
}

export function scenesToMarkdown(project: Project): string {
  const out: string[] = [];
  out.push(`# ${project.name} · 场景设定卡`);
  out.push('');
  out.push('> 场景和角色一样分三层。**固定元素**是观众用来认出「这是同一个地方」的依据，');
  out.push('> 不写下来，模型每个镜头都会重新布置一遍这个空间。');
  out.push('');

  if (project.scenes.length === 0) {
    out.push('（还没有场景）');
    return out.join('\n');
  }

  for (const scene of project.scenes) {
    out.push(`## ${scene.name}`);
    out.push('');
    out.push('### 身份（不变）');
    out.push('');
    out.push(`- 地点类型：${scene.identity.placeType || '（未填）'}`);
    out.push(`- 空间结构：${scene.identity.spatialStructure || '（未填）'}`);
    out.push(`- 概述：${scene.identity.summary || '（未填）'}`);
    out.push(`- 英文描述：\`${scene.identity.summaryEn || '（未填）'}\``);
    out.push('');

    out.push('### 固定元素（跨镜必须出现）');
    out.push('');
    if (scene.fixedElements.length === 0) {
      out.push('注意： 没有登记固定元素，换个镜头就认不出是同一处地方。');
    } else {
      for (const el of scene.fixedElements) out.push(`- \`${el}\``);
    }
    out.push('');

    out.push('### 光线与色调');
    out.push('');
    out.push(`- 主光方向：${scene.lightDirection || '（未填）'}`);
    out.push(`- 主色调：${scene.mainColor || '（未填）'}`);
    if (scene.timeOfDay) out.push(`- 默认时段：${scene.timeOfDay}`);
    if (scene.weather) out.push(`- 默认天气：${scene.weather}`);
    out.push('');

    out.push('### 连续性锁');
    out.push('');
    if (scene.continuityLocks.length === 0) {
      out.push('（无）');
    } else {
      for (const lock of scene.continuityLocks) {
        out.push(`- **${lock.label}**（${lock.appliesTo}）：\`${lock.phrase}\``);
      }
    }
    out.push('');

    out.push('### 变体');
    out.push('');
    if (scene.variants.length === 0) {
      out.push('（无变体）');
    } else {
      for (const variant of scene.variants) {
        const shots = variant.shotIds
          .map((id) => project.shots.find((s) => s.id === id)?.number)
          .filter((n): n is number => n !== undefined);
        out.push(`- **${variant.label}**：${variant.changedFeatures.join('、') || '（未写改变了什么）'}`);
        out.push(`  - 生效镜头：${shots.length > 0 ? shots.map((n) => `第 ${n} 镜`).join('、') : '（尚未分配）'}`);
      }
    }
    out.push('');
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// 穿帮检查单
// ---------------------------------------------------------------------------

const SEVERITY_LABEL: Record<string, string> = {
  error: '必须修',
  warning: '建议修',
  info: '看一眼',
};

export function checkReportToMarkdown(project: Project, report: CheckReport): string {
  const out: string[] = [];
  out.push(`# ${project.name} · 穿帮检查单`);
  out.push('');
  out.push(`检查时间：${new Date(report.checkedAt).toLocaleString('zh-CN')}`);
  out.push('');
  out.push(
    `结果：**${report.counts.error}** 个必须修 · **${report.counts.warning}** 个建议修 · **${report.counts.info}** 个可以看一眼`,
  );
  out.push('');
  out.push('> 这份单子检查的是「该一致的地方有没有写下来」，不是「生成出来一定没问题」。');
  out.push('> 生成模型仍可能出错，但把事实写清楚，你能在出图之前就看出哪些地方会穿帮。');
  out.push('');

  if (report.issues.length === 0) {
    out.push('没有发现问题。可以开始生成画面了。');
    return out.join('\n');
  }

  for (const severity of ['error', 'warning', 'info'] as const) {
    const group = report.issues.filter((i) => i.severity === severity);
    if (group.length === 0) continue;
    out.push(`## ${SEVERITY_LABEL[severity]}（${group.length}）`);
    out.push('');
    for (const issue of group) {
      const where = describeLocation(project, issue.location);
      out.push(`### ${where}：${issue.title}`);
      out.push('');
      out.push(`- **为什么**：${issue.why}`);
      out.push(`- **怎么改**：${issue.suggestion}`);
      out.push('');
    }
  }
  return out.join('\n');
}

function describeLocation(
  project: Project,
  location: { kind: string; id: string; field?: string },
): string {
  switch (location.kind) {
    case 'shot': {
      const shot = project.shots.find((s) => s.id === location.id);
      return shot ? `第 ${shot.number} 镜` : '某个镜头';
    }
    case 'character': {
      const c = project.characters.find((x) => x.id === location.id);
      return c ? `角色「${c.name}」` : '某个角色';
    }
    case 'scene': {
      const s = project.scenes.find((x) => x.id === location.id);
      return s ? `场景「${s.name}」` : '某个场景';
    }
    case 'story': {
      const s = project.story.scenes.find((x) => x.id === location.id);
      return s ? `剧本场次「${s.label}」` : '剧本场次';
    }
    default:
      return '项目设置';
  }
}

// ---------------------------------------------------------------------------
// 拍摄进度表
// ---------------------------------------------------------------------------

export function shootingProgressToMarkdown(project: Project): string {
  const out: string[] = [];
  const total = project.shots.reduce((s, x) => s + (Number.isFinite(x.duration) ? x.duration : 0), 0);
  out.push(`# ${project.name} · 拍摄进度表`);
  out.push('');
  out.push('> 这是你的执行清单。每一镜按顺序做，做完打勾。');
  out.push('> 提示：先在平台里生成关键帧图，图满意了再拿去生成视频，能省很多钱。');
  out.push('');
  out.push(`共 ${project.shots.length} 镜，总时长 ${total} 秒，目标平台：${
    project.brief.platforms.map((p) => PLATFORM_LABEL[p]).join(' / ') || '未设置'
  }`);
  out.push('');
  out.push('---');
  out.push('');

  for (const shot of project.shots) {
    const scene = project.scenes.find((s) => s.id === shot.sceneId);
    const characters = project.characters.filter((c) => shot.characterIds.includes(c.id));
    out.push(`## [ ] 第 ${shot.number} 镜 · ${shot.duration} 秒 · ${scene?.name ?? '未指定场景'}`);
    out.push('');
    out.push(`**要拍什么**：${shot.action || '（未填）'}`);
    out.push('');
    out.push(`- 起点画面：${shot.startState || '（未填）'}`);
    out.push(`- 终点画面：${shot.endState || '（未填）'}`);
    if (characters.length > 0) {
      out.push(`- 出场：${characters.map((c) => c.name).join('、')}`);
      const locks = characters.flatMap((c) =>
        c.continuityLocks
          .filter((l) => shot.activeLockIds.includes(l.id))
          .map((l) => `${c.name}·${l.label} → ${l.phrase}`),
      );
      if (locks.length > 0) {
        out.push(`- 必须带上的锁：`);
        for (const lock of locks) out.push(`  - \`${lock}\``);
      }
    }
    if (shot.dialogue) out.push(`- 台词：${shot.dialogue}`);
    out.push('');
    out.push('- [ ] 生成关键帧图，确认角色和场景没走样');
    out.push('- [ ] 生成视频片段');
    out.push('- [ ] 检查首尾和相邻镜头接得上');
    out.push('');
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// 提示词包
// ---------------------------------------------------------------------------

export function promptsToMarkdown(project: Project): { fileName: string; content: string }[] {
  const bundles = buildAllPrompts(project);
  return bundles.map(({ platform, lines }) => {
    const out: string[] = [];
    out.push(`# ${project.name} · ${PLATFORM_LABEL[platform]} 提示词`);
    out.push('');
    out.push('> 每镜分三块：**英文正文**（直接复制去平台）、**中文对照**（看懂自己要生成什么）、');
    out.push('> **逐项说明**（每个片段为什么这么写）。正文里已经带了连续性锁，不要删。');
    out.push('');
    out.push(`画幅：${project.brief.aspectRatio || '未设置'}`);
    if (project.brief.negativePrompt) {
      out.push('');
      out.push(`负向词（贴到平台的负向词框里，别混进正文）：`);
      out.push('');
      out.push('```');
      out.push(project.brief.negativePrompt);
      out.push('```');
    }
    out.push('');

    for (const { shot, prompt } of lines) {
      out.push(`## 第 ${shot.number} 镜（${shot.duration} 秒）`);
      out.push('');
      out.push('### 英文正文（复制这段）');
      out.push('');
      out.push('```');
      out.push(prompt.en);
      out.push('```');
      out.push('');
      out.push('### 中文对照');
      out.push('');
      out.push('```');
      out.push(prompt.zh);
      out.push('```');
      out.push('');
      if (prompt.notes.length > 0) {
        out.push('### 为什么这么写');
        out.push('');
        for (const note of prompt.notes) {
          out.push(`- **${note.label}** \`${note.fragment}\``);
          out.push(`  - ${note.reason}`);
        }
        out.push('');
      }
    }
    return { fileName: `${PLATFORM_LABEL[platform]}.md`, content: out.join('\n') };
  });
}

