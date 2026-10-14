# 第三方开源资产声明 / Third-Party Notices

本项目在设计与内容上参考、复用了以下开源项目的成果。按各自许可要求，此处收录完整许可原文与版权声明。

生成日期：2026-10-12

---

## 1. zenstory-ai/drama-skills

- 仓库：https://github.com/zenstory-ai/drama-skills
- 许可：MIT License
- 版权：Copyright (c) 2026 drama-skills contributors
- 本项目复用内容：
  - 角色/场景一致性的三层机制（身份 vs 变体、连续性锁、冻结关键帧）
  - 分镜「起点 → 唯一动作 → 终点」字段结构
  - 跨文档引用校验的规则设计与面向创作者的报错文案范式
  - 参考图状态标记思路（提示词条目 / 计划提供 / 已核对可用）

### MIT License 原文

```
MIT License

Copyright (c) 2026 drama-skills contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 2. jijiutong/ai-visual-director

- 仓库：https://github.com/jijiutong/ai-visual-director
- 许可：MIT License
- 版权：Copyright (c) 2026 AI Visual Director Contributors
- 本项目复用内容：
  - 影视知识库结构与内容方向（运镜、构图、灯光、色彩、节奏、微表情等）
  - 多平台提示词输出格式规范（平台特性对比、运镜/主体运动/环境运动描述、转场写法）
  - 数据模型骨架（角色 DNA 字段、`immutable_features` / `mutable_features` 分离、镜头起止状态）
  - 角色卡与分镜表模板结构

### MIT License 原文

```
MIT License

Copyright (c) 2026 AI Visual Director Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 3. BaYue-SYJ/shuixian-prompts（「水仙的AI提示词」）

- 仓库：https://github.com/BaYue-SYJ/shuixian-prompts
- 站点：https://prompt.qqsrc.com/
- 许可：Attribution Required License v1.0（自定义许可，非标准开源许可）
- 作者：水仙
- 本项目使用方式：**可插拔数据源**，不作为内置数据打包。用户可自行导入。

> ⚠️ **重要提示**：该许可允许非商业用途自由使用，但**商业用途需先取得作者书面授权**。
> 若本项目将来转向商业用途（打包售卖、付费社群、引流变现站点、企业内训等），使用该数据源前必须先取得授权，或整体剔除该数据源。
> 该仓库收录的提示词原文与图片**版权归各自原作者**，原仓库仅作整理与分类，不对其可用性作担保。

### 署名要求（已在 README 与工具「关于」页履行）

本项目如使用了该数据源，须在显著位置注明：

> 本项目基于「水仙的AI提示词」（https://github.com/BaYue-SYJ/shuixian-prompts）二次开发

### Attribution Required License v1.0 原文

```
# 水仙的AI提示词 · 使用与署名说明

**Attribution Required License · v1.0（2026-09-18）**

本仓库包含站点代码、数据组织与分类体系，以及整理后的提示词数据。
使用本项目的任何部分，即视为你已阅读并同意以下约定。

---

## 一、可以自由使用

- 学习、克隆、fork、二次开发
- 转载、引用，用于个人学习与非商业分享
- 基于本项目做自己的画廊 —— 换皮肤、换数据、改功能都可以

## 二、必须遵守

1. **保留署名**：在你项目的主页、README 或站点页脚的显著位置注明来源，并附上原仓库链接。
   可以直接使用这一句：

   > 本项目基于「水仙的AI提示词」（https://github.com/BaYue-SYJ/shuixian-prompts）二次开发

2. **衍生项目必须写清来源**：任何 fork、改写、二次开发或搬运的版本，都必须在显著位置说明它来自本项目，
   并保留原仓库链接；不得删除、遮蔽、弱化原署名，也不得对外宣称原创。

3. **不得暗示官方背书**：未经许可，不得使用本项目名称、作者名义为自己的版本做推广或背书。

## 三、商业用途需先获得授权

商业用途 —— 包括打包售卖、付费课程或社群、用于引流变现的商业站点、企业内训等 ——
**需先联系作者取得书面授权**，包括但不限于去除署名后使用的情形。

- 联系方式：公众号「水仙的AI提示词」后台留言
- 或在本仓库提交 Issue：https://github.com/BaYue-SYJ/shuixian-prompts/issues

## 四、关于数据与图片

仓库内的提示词原文与图片来自公开渠道的整理与收录，**版权归各自原作者**。
本项目仅作整理、分类与展示，不对这部分内容主张权利，也不对其可用性作任何担保；
如需商业使用，请自行确认权利来源。

## 五、署名信息

| 项 | 内容 |
| --- | --- |
| 项目 | 水仙的AI提示词 |
| 作者 | 水仙 |
| 仓库 | https://github.com/BaYue-SYJ/shuixian-prompts |
| 站点 | https://prompt.qqsrc.com/ |
| 公众号 | 水仙的AI提示词 |

---

## English Summary

You are free to learn from, fork, modify, and build upon this project for **non-commercial** purposes.

**Attribution is required.** Any fork or derivative work must clearly credit the original project and link back to
<https://github.com/BaYue-SYJ/shuixian-prompts>. You may not remove, obscure, or weaken the original attribution,
and you may not present the work as your own.

**Commercial use requires prior written permission** from the author. Contact via the WeChat Official Account
「水仙的AI提示词」or by opening an issue in this repository.

Prompt texts and images collected in this repository remain the property of their respective original authors.
This project only curates and organizes them and makes no claim over that content.
```

---

## 4. 运行时依赖（npm 包）

本项目通过 npm 依赖以下第三方库，均为宽松许可，与本项目的 MIT 许可兼容。
**这些包的完整许可原文随包一起分发**（安装后见 `node_modules/<包名>/LICENSE`）。

| 包 | 许可 | 用途 |
|---|---|---|
| [dexie](https://www.npmjs.com/package/dexie) | **Apache-2.0** | IndexedDB 封装 |
| [fflate](https://www.npmjs.com/package/fflate) | MIT | zip 打包（导出） |
| [react](https://www.npmjs.com/package/react) / [react-dom](https://www.npmjs.com/package/react-dom) | MIT | UI 框架 |
| [react-router-dom](https://www.npmjs.com/package/react-router-dom) | MIT | 路由 |
| [zod](https://www.npmjs.com/package/zod) | MIT | 模型输出的运行时校验 |
| [zustand](https://www.npmjs.com/package/zustand) | MIT | 状态管理 |

开发依赖（不进入产物）：`typescript`（Apache-2.0）、`vite` / `vitest` / `jsdom` /
`@vitejs/plugin-react` / `@types/react` / `@types/react-dom` / `fake-indexeddb`（均为 MIT 或 Apache-2.0）。

### Apache-2.0 组件的 NOTICE 保留

Apache License 2.0 第 4(d) 条要求：若被分发作品含有 NOTICE 文件，衍生作品须保留其中的归属声明。
本项目实际分发的 Apache-2.0 组件中，**Dexie.js 带有 NOTICE 文件**，其原文如下（逐字保留）：

```
Dexie.js

Copyright (c) 2014-2017 David Fahlander

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

> 说明：本项目以**源码形式**分发，npm 依赖由使用者通过 `pnpm install` 自行获取，
> 因此各包的许可原文随包提供，本文件不再逐个复制。但 Apache-2.0 的 NOTICE 归属声明
> 按要求在此保留。
