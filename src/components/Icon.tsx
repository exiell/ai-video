import type { CSSProperties } from 'react';
import home from '../assets/icons/tabler-home.svg?url';
import book from '../assets/icons/tabler-book.svg?url';
import users from '../assets/icons/tabler-users.svg?url';
import map from '../assets/icons/tabler-map.svg?url';
import layoutGrid from '../assets/icons/tabler-layout-grid.svg?url';
import alertTriangle from '../assets/icons/tabler-alert-triangle.svg?url';
import terminal from '../assets/icons/tabler-terminal-2.svg?url';
import download from '../assets/icons/tabler-download.svg?url';
import settings from '../assets/icons/tabler-settings.svg?url';
import help from '../assets/icons/tabler-help-circle.svg?url';
import chevronRight from '../assets/icons/tabler-chevron-right.svg?url';
import plus from '../assets/icons/tabler-plus.svg?url';
import sparkles from '../assets/icons/tabler-sparkles.svg?url';
import movie from '../assets/icons/tabler-movie.svg?url';
import photo from '../assets/icons/tabler-photo.svg?url';
import listCheck from '../assets/icons/tabler-list-check.svg?url';
import fileText from '../assets/icons/tabler-file-text.svg?url';
import palette from '../assets/icons/tabler-palette.svg?url';
import arrowRight from '../assets/icons/tabler-arrow-right.svg?url';
import key from '../assets/icons/tabler-key.svg?url';
import clock from '../assets/icons/tabler-clock.svg?url';
import circleCheck from '../assets/icons/tabler-circle-check.svg?url';
import playerPlay from '../assets/icons/tabler-player-play.svg?url';
import adjustments from '../assets/icons/tabler-adjustments.svg?url';
import deviceFloppy from '../assets/icons/tabler-device-floppy.svg?url';
import brandDeepseek from '../assets/icons/brand-deepseek.svg?url';
import brandQwen from '../assets/icons/brand-qwen.svg?url';
import brandMoonshot from '../assets/icons/brand-moonshotai.svg?url';
import brandMinimax from '../assets/icons/brand-minimax.svg?url';
import brandBaidu from '../assets/icons/brand-baidu.svg?url';

/**
 * 图标只取用到的单个 SVG（Tabler outline，MIT；品牌图标来自 Simple Icons，CC0）。
 *
 * 用 mask 而不是 <img>：颜色跟着 currentColor 走，三套外观切换时不用换图标。
 * 原始 SVG 放在 src/assets/icons/，来源与许可见 THIRD-PARTY-NOTICES.md。
 */
const ICONS = {
  home,
  book,
  users,
  map,
  'layout-grid': layoutGrid,
  'alert-triangle': alertTriangle,
  terminal,
  download,
  settings,
  help,
  'chevron-right': chevronRight,
  plus,
  sparkles,
  movie,
  photo,
  'list-check': listCheck,
  'file-text': fileText,
  palette,
  'arrow-right': arrowRight,
  key,
  clock,
  'circle-check': circleCheck,
  'player-play': playerPlay,
  adjustments,
  'device-floppy': deviceFloppy,
  deepseek: brandDeepseek,
  qwen: brandQwen,
  moonshot: brandMoonshot,
  minimax: brandMinimax,
  baidu: brandBaidu,
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({
  name,
  size = 16,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  const style = {
    width: size,
    height: size,
    '--icon-url': `url("${ICONS[name]}")`,
  } as CSSProperties;

  return <span className={`icon${className ? ` ${className}` : ''}`} style={style} aria-hidden="true" />;
}

