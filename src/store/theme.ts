import { create } from 'zustand';
import { syncDesktopThemeChrome, type ThemeChromeOptions } from '../platform';

/**
 * 界面外观。
 *
 * 五套主题共用完整功能与数据：棱镜霓虹与彩绘棱镜采用顶部制片导航与流光布局，
 * 工作台 / 暗房 / 蓝图保留经典三栏布局。
 * 这里集中管理 data-theme 与 localStorage，避免 Layout 和设置页各存一份。
 */
export type Theme = 'prism' | 'pop' | 'studio' | 'night' | 'blueprint';

export interface ThemeOption {
  id: Theme;
  label: string;
  description: string;
}

export const THEMES: ThemeOption[] = [
  {
    id: 'prism',
    label: '棱镜霓虹',
    description: '深靛星空底、流光多色强调、顶部制片导航。默认外观。',
  },
  {
    id: 'pop',
    label: '彩绘棱镜',
    description: '明亮奶油白底、高饱和彩虹流光、彩色几何图形与活泼动效。',
  },
  {
    id: 'studio',
    label: '工作台',
    description: '冷灰蓝底、白卡、蓝色强调。浅色清晰，适合白天阅读。',
  },
  {
    id: 'night',
    label: '暗房',
    description: '近黑底、黄铜强调。晚上剪片、长时间看画面不刺眼。',
  },
  {
    id: 'blueprint',
    label: '蓝图',
    description: '冷灰纸面、坐标纸网格、衬线标题。像一份分镜档案。',
  },
];

/** 5 套主题对应的 Electron 窗口背景色与 titleBarOverlay 配色（docs/DESIGN.md §5.2） */
export const THEME_CHROME_MAP: Record<Theme, ThemeChromeOptions> = {
  prism: { bg: '#080b16', overlayColor: '#0d1224', symbolColor: '#f1f5ff' },
  pop: { bg: '#faf9ff', overlayColor: '#ffffff', symbolColor: '#1b1734' },
  studio: { bg: '#f3f6f9', overlayColor: '#f8fafc', symbolColor: '#16202b' },
  night: { bg: '#0b0d10', overlayColor: '#11151b', symbolColor: '#f2efe8' },
  blueprint: { bg: '#edf1f4', overlayColor: '#f5f8fa', symbolColor: '#102130' },
};

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  syncDesktopThemeChrome(THEME_CHROME_MAP[theme]);
  try {
    window.localStorage.setItem('aniguide.theme', theme);
  } catch {
    // 隐私模式禁用存储时只影响下次打开，不影响当前会话
  }
}

function initialTheme(): Theme {
  try {
    const saved = window.localStorage.getItem('aniguide.theme');
    if (
      saved === 'prism' ||
      saved === 'pop' ||
      saved === 'studio' ||
      saved === 'night' ||
      saved === 'blueprint'
    ) {
      return saved;
    }
  } catch {
    // 退回默认
  }
  return 'prism';
}

const initial = initialTheme();
if (typeof document !== 'undefined') {
  document.documentElement.dataset.theme = initial;
  syncDesktopThemeChrome(THEME_CHROME_MAP[initial]);
}

interface ThemeState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

export const useTheme = create<ThemeState>((set) => ({
  theme: initial,
  setTheme: (theme) => {
    applyTheme(theme);
    set({ theme });
  },
}));
