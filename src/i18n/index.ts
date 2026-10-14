/** 界面文案。方案.md v0.6 §5.6：P0 以中文为主，英文可后补。 */

export interface Dict {
  appName: string;
  tagline: string;
  nav: {
    home: string;
    guide: string;
    storyboard: string;
    checks: string;
    characters: string;
    scenes: string;
    prompts: string;
    export: string;
    settings: string;
    about: string;
  };
  common: {
    save: string;
    cancel: string;
    delete: string;
    add: string;
    edit: string;
    back: string;
    next: string;
    loading: string;
    empty: string;
    copy: string;
    copied: string;
    unnamed: string;
  };
}

export const zh: Dict = {
  appName: 'AniGuide',
  tagline: '把「我想做个动漫视频」变成一份可以直接开拍的方案',
  nav: {
    home: '项目',
    guide: '引导向导',
    storyboard: '分镜表',
    checks: '穿帮检查',
    characters: '角色设定',
    scenes: '场景设定',
    prompts: '提示词',
    export: '导出',
    settings: '设置',
    about: '关于',
  },
  common: {
    save: '保存',
    cancel: '取消',
    delete: '删除',
    add: '添加',
    edit: '编辑',
    back: '上一步',
    next: '下一步',
    loading: '加载中…',
    empty: '还没有内容',
    copy: '复制',
    copied: '已复制',
    unnamed: '未命名',
  },
};

/** 供将来扩展的英文占位。P0 不启用，先指向中文以保证不出现空白界面。 */
export const en: Dict = zh;

export const dictionaries = { zh, en } as const;
export type Lang = keyof typeof dictionaries;

export function t(lang: Lang = 'zh'): Dict {
  return dictionaries[lang];
}
