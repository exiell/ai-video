import type { CharacterCard, CheckIssue, Project, Shot } from '../../types/model';
import { makeIssue, mentionsName, shotLabel } from './shared';

/**
 * 角色一致性检查（方案.md v0.6 §3.2）
 *
 * 覆盖规则：
 *  - character-not-registered  镜头里点名了角色，但角色设定里没有这个人
 *  - character-missing-lock    镜头出现了角色，但没声明该角色的连续性锁
 *  - variant-not-owned         镜头用了某个变体，但它没被登记为对应角色的变体
 *  - （附加）角色卡本身没有连续性锁，提示补上
 */

/** 镜头正文里出现的文本，用于人名匹配 */
function shotText(shot: Shot): string {
  return [shot.startState, shot.action, shot.endState, shot.dialogue].join(' ');
}

/** 找出镜头里被点名（文本提到 或 id 引用）的角色 */
function resolveCharacters(project: Project, shot: Shot): {
  referenced: CharacterCard[];
  mentionedUnregistered: string[];
} {
  const referenced: CharacterCard[] = [];
  for (const id of shot.characterIds) {
    const found = project.characters.find((c) => c.id === id);
    if (found && !referenced.includes(found)) referenced.push(found);
  }

  const text = shotText(shot);
  const mentionedUnregistered: string[] = [];
  for (const character of project.characters) {
    if (referenced.includes(character)) continue;
    if (mentionsName(text, character.name)) referenced.push(character);
  }

  // 文本里出现、但不属于任何已登记角色的「人名」无法自动识别，
  // 因此额外检查：镜头里提到的人名若命中角色卡则正常，否则由用户在角色页补登记。
  // 这里额外扫描角色卡之外的高频称呼（如「他」「她」）没有意义，故不做猜测。

  return { referenced, mentionedUnregistered };
}

export function checkCharacters(project: Project): CheckIssue[] {
  const issues: CheckIssue[] = [];

  for (const shot of project.shots) {
    const { referenced } = resolveCharacters(project, shot);
    const label = shotLabel(shot.number);

    for (const character of referenced) {
      // 规则：镜头出现了角色，但没声明该角色的连续性锁
      const characterLockIds = character.continuityLocks.map((l) => l.id);
      const declaredLockIds = shot.activeLockIds.filter((id) => characterLockIds.includes(id));
      const isExplicitlyReferenced = shot.characterIds.includes(character.id);

      if (character.continuityLocks.length === 0) {
        issues.push(
          makeIssue({
            ruleId: 'character-missing-lock',
            severity: 'warning',
            title: `角色「${character.name}」还没有任何连续性锁，${label}无法锁定他的形象`,
            why:
              '连续性锁是保证同一个角色在不同镜头里长得一样的手段。没有锁，模型每镜都会重新“想象”这个人的样子，脸和服装很容易变。',
            suggestion: `去角色设定里，把「${character.name}」身上**不会随剧情改变、且观众看得出不一致**的特征写成一条锁。锁面要写成能直接贴进提示词的短语，例如：pine-green lapel service jacket。`,
            location: { kind: 'character', id: character.id },
          }),
        );
        continue;
      }

      if (declaredLockIds.length === 0) {
        issues.push(
          makeIssue({
            ruleId: 'character-missing-lock',
            severity: isExplicitlyReferenced ? 'error' : 'warning',
            title: `${label}出现了「${character.name}」，但没有声明他的连续性锁`,
            why: `这一镜的提示词不会带上「${character.name}」的锁面，等于每次生成都让模型自由发挥。跨镜穿帮多数就是这么来的。`,
            suggestion: `在第 ${shot.number} 镜勾选「${character.name}」的连续性锁${
              character.continuityLocks.length === 1
                ? `（${character.continuityLocks[0]?.label}）`
                : `（共 ${character.continuityLocks.length} 条，至少勾一条）`
            }。`,
            location: { kind: 'shot', id: shot.id, field: 'activeLockIds' },
          }),
        );
      }
    }

    // 规则：镜头用了某个变体，但它不属于本镜出现的任何角色 / 场景
    const knownVariantIds = new Set<string>([
      ...project.characters.flatMap((c) => c.variants.map((v) => v.id)),
      ...project.scenes.flatMap((s) => s.variants.map((v) => v.id)),
    ]);
    for (const variantId of shot.variantIds) {
      if (knownVariantIds.has(variantId)) continue;
      issues.push(
        makeIssue({
          ruleId: 'variant-not-owned',
          severity: 'warning',
          title: `${label}引用了一个不存在的变体`,
          why: '变体必须登记在某个角色或场景名下，否则提示词不知道它改变的是什么特征。',
          suggestion: `检查第 ${shot.number} 镜的变体选择，或去角色/场景设定里把「${variantId}」补登记为对应的变体。`,
          location: { kind: 'shot', id: shot.id, field: 'variantIds' },
        }),
      );
    }

  }

  // -------------------------------------------------------------------------
  // 已登记但没有分配给任何镜头的变体
  // -------------------------------------------------------------------------
  // 【v0.39 修】原来这段嵌在 `for (const shot of project.shots)` 里，
  // 于是「7 个镜头 × 2 个未分配变体」会报出 14 条一模一样的问题，
  // 而且文案里写着「如果第 N 镜确实用得上它」——N 跟这个变体毫无关系。
  // 重复发报比不报更糟：用户会学会跳过整份检查单。
  //
  // 现在移出循环，每个变体只报一次，并且不指向任何具体镜头。
  for (const character of project.characters) {
    for (const variant of character.variants) {
      if (variant.shotIds.length > 0) continue;
      issues.push(
        makeIssue({
          ruleId: 'variant-not-owned',
          severity: 'info',
          title: `变体「${variant.label}」已创建，但还没有分配给任何镜头`,
          why: '没有分配镜头的变体不会出现在任何提示词里，等于白建。',
          suggestion: `如果它确实用得上，去分镜表里勾选对应镜头；用不上可以删掉，保持设定干净。`,
          location: { kind: 'character', id: character.id },
        }),
      );
    }
  }

  // 规则：角色已登记但在全片中没有出镜
  for (const character of project.characters) {
    const appearsIn = project.shots.filter(
      (s) => s.characterIds.includes(character.id) || mentionsName(shotText(s), character.name),
    );
    if (appearsIn.length === 0) {
      issues.push(
        makeIssue({
          ruleId: 'character-not-registered',
          severity: 'info',
          title: `角色「${character.name}」在分镜里一次都没出现`,
          why: '他可能是被忘了，也可能是已经不需要这个角色了。',
          suggestion: `确认一下：如果这个角色该出场，就补镜；如果不需要了，可以删掉他，避免设定越堆越乱。`,
          location: { kind: 'character', id: character.id },
        }),
      );
    }
  }


  // -------------------------------------------------------------------------
  // 高显著度特征没有被锁覆盖
  // -------------------------------------------------------------------------
  // 【v0.24 新增】这条规则来自一个真实症状：
  // 「上一个镜头只有头巾，下一个镜头戴上了帽子」。
  //
  // 根因是那顶帽子只写在角色的身份描述里，而**锁里没有任何一条提到头饰**。
  // 锁是唯一会「原样注入相关每一帧」的东西，没进锁就等于没有强约束。
  //
  // 判据很保守：只在**身份描述里出现了高显著度特征的词、而所有锁短语里都没有**时才提示。
  // 高显著度 = 帽子 / 面纱 / 面罩 / 眼镜 / 披风 / 斗篷 / 围巾 / 背包 / 饰品 ——
  // 这些东西丢了观众一眼就看得出来，而且很难用「同一个人」解释过去。
  // 一律**加词边界**：不加会踩到「wearing 里含有 ring」这类假阳性
  // （`wearing` 的 `ring` 正好落在词尾，`ring\b` 会命中）。
  // 同理 cap 会命中「escape」「capacity」——都要靠词边界挡住。
  const SALIENT_FEATURES: { source: string; label: string }[] = [
    { source: 'hat|cap|hood|helmet|veil|headdress', label: '帽 / 头巾 / 面纱' },
    { source: 'mask|goggles|glasses|spectacles|eyepatch', label: '面罩 / 眼镜' },
    { source: 'cloak|cape|scarf|shawl|mantle', label: '披风 / 围巾' },
    { source: 'backpack|satchel|pouch|bag', label: '背包 / 挎包' },
    { source: 'necklace|earring|bracelet|ring|pendant|brooch', label: '饰品' },
  ].map((f) => ({ source: `\\b(?:${f.source})\\b`, label: f.label }));

  for (const character of project.characters) {
    const identityText = [
      character.identity.summaryEn,
      character.identity.face,
      character.identity.hair,
      character.identity.bodyType,
    ]
      .filter(Boolean)
      .join(' ');
    if (identityText.trim().length === 0) continue;

    const lockText = character.continuityLocks.map((l) => l.phrase).join(' ');
    const uncovered = SALIENT_FEATURES.filter((f) => {
      const re = new RegExp(f.source, 'i');
      return re.test(identityText) && !re.test(lockText);
    });
    if (uncovered.length === 0) continue;

    const labels = uncovered.map((f) => f.label).join('、');
    issues.push(
      makeIssue({
        ruleId: 'character-unlocked-feature',
        severity: 'warning',
        title: `角色「${character.name}」的身份描述里有${labels}，但没有一条连续性锁管它`,
        why:
          '锁是唯一会**原样写进相关每一帧提示词**的东西。没进锁的高显著度特征，' +
          '就只能靠画面描述偶尔提到——提到的镜头画了，没提到的镜头就没了。' +
          '这类东西（帽子、面纱、眼镜、披风）丢了观众一眼就看得出来。',
        suggestion:
          '加一条锁，锁面写成能直接贴进提示词的英文短语，例如 ' +
          (uncovered[0]!.label.includes('帽')
            ? '`a worn dark felt hat with a low pressed brim`'
            : uncovered[0]!.label.includes('眼镜')
              ? '`round brass-rimmed spectacles`'
              : '`a floor-length dark cloak with a frayed hem`') +
          '。加完之后它会自动进入每一帧的提示词，不用再靠画面描述兜。',
        location: { kind: 'character', id: character.id, field: 'continuityLocks' },
      }),
    );
  }

  return issues;
}

export { resolveCharacters, shotText };
