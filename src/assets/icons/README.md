# 图标素材

只保留了界面实际用到的单个 SVG，没有引入整个图标包。

- `tabler-*.svg`：[Tabler Icons](https://github.com/tabler/tabler-icons) 3.49.0，MIT
- `brand-*.svg`：[Simple Icons](https://github.com/simple-icons/simple-icons) 16.35.0，CC0-1.0（品牌商标权归各公司）

`Icon.tsx` 用 CSS mask 引入这些文件，所以图标颜色跟随 `currentColor`，三套外观共用一套文件。
完整版权与许可说明见仓库根目录 `THIRD-PARTY-NOTICES.md`。
