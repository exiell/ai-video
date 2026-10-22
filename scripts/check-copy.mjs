import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const ROOT = process.cwd();
const PAGE_DIRS = ['src/pages', 'src/components'];
const ALLOWED_FONT_SIZES = new Set([12, 13, 14, 16, 20, 26]);

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.tsx') ? [full] : [];
  });
}

function lineOf(source, node) {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function collectCopy(file) {
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = [];
  const seen = new Set();

  const add = (value, node, kind = 'text') => {
    const clean = value.replace(/\s+/g, ' ').trim();
    if (!clean || !/[\u4e00-\u9fff]/.test(clean)) return;
    const key = `${file}:${lineOf(source, node)}:${clean}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ file: path.relative(ROOT, file), line: lineOf(source, node), text: clean, kind });
  };

  const visit = (node) => {
    if (ts.isJsxText(node)) add(node.text, node);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      add(node.text, node);
    }
    if (ts.isTemplateExpression(node)) {
      add(node.head.text, node.head);
      for (const span of node.templateSpans) add(span.literal.text, span.literal);
    }
    if (ts.isJsxAttribute(node) && node.name.text === 'hint' && node.initializer) {
      const init = node.initializer;
      if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) {
        add(init.text, init, 'hint');
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return found;
}

const hard = [
  { re: /——/g, label: '长破折号 ——' },
  { re: /不是[^。！？\n]{0,30}而是/g, label: '不是…而是' },
  { re: /把「/g, label: '把「…」变成' },
  { re: /(一键|闭环|赋能)/g, label: '产品黑话' },
];
const soft = [
  { re: /就能|一眼|最省力|最能省事/g, label: '过度顺滑/效率词' },
  { re: /「/g, label: '引号「」' },
  { re: /不只是/g, label: '不只是' },
];

const files = PAGE_DIRS.flatMap((dir) => walk(path.join(ROOT, dir))).filter(
  // 这个文件还有一笔外部未提交的 AssetPeek 改动；等它落地后再纳入审计，避免混提交。
  (file) => !file.endsWith(path.join('components', 'ChatSidebar.tsx')),
);
const copy = files.flatMap(collectCopy);
const failures = [];
const warnings = [];

for (const item of copy) {
  for (const rule of hard) {
    if (rule.re.test(item.text)) {
      rule.re.lastIndex = 0;
      failures.push({ ...item, rule: rule.label });
    }
    rule.re.lastIndex = 0;
  }
  for (const rule of soft) {
    if (rule.re.test(item.text)) {
      rule.re.lastIndex = 0;
      warnings.push({ ...item, rule: rule.label });
    }
    rule.re.lastIndex = 0;
  }
  if (item.kind === 'hint' && item.text.length > 45) {
    warnings.push({ ...item, rule: `hint 超过 45 字（${item.text.length}）` });
  }
  if (item.text.length > 45) {
    warnings.push({ ...item, rule: `单条文案超过 45 字（${item.text.length}）` });
  }
}

const css = readFileSync(path.join(ROOT, 'src/styles/global.css'), 'utf8');
const fontSizes = [...css.matchAll(/font-size:\s*([^;]+);/g)]
  .map((m) => m[1].trim())
  .filter((value) => !value.includes('var('));
const invalidFontSizes = fontSizes.filter((value) => {
  const px = /^(\d+(?:\.\d+)?)px$/.exec(value);
  return !px || !ALLOWED_FONT_SIZES.has(Number(px[1]));
});

const unique = (items) => {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.file}:${item.line}:${item.rule}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const failureList = unique(failures);
const warningList = unique(warnings);

console.log(`可见文案：${copy.length} 条`);
console.log(`字号：${[...new Set(fontSizes)].join(', ') || '无'}`);
console.log(`硬规则失败：${failureList.length}`);
for (const item of failureList.slice(0, 12)) {
  console.log(`  ${item.file}:${item.line} [${item.rule}] ${item.text.slice(0, 60)}`);
}
console.log(`警告：${warningList.length}`);
for (const item of warningList.slice(0, 12)) {
  console.log(`  ${item.file}:${item.line} [${item.rule}] ${item.text.slice(0, 60)}`);
}
if (invalidFontSizes.length > 0) {
  console.log(`字号 token 警告：${[...new Set(invalidFontSizes)].join(', ')}`);
}

if (failureList.length > 0) {
  console.error('文案检查未通过。');
  process.exitCode = 1;
} else {
  console.log('文案硬规则通过。');
}
