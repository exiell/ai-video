import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const ROOT = process.cwd();
const PAGE_DIRS = ['src/pages', 'src/components'];
/**
 * 领域层也会产出用户可见文案（检查建议、出图 notes、导出说明、错误提示）。
 *
 * 【v0.54 · P2-13】原来只扫页面与组件，于是 domain/services 里 14 处
 * 用户可见的长破折号一直没被规则覆盖（第 10 批「48→0」只扫了页面层）。
 * 这些目录里同时有**给模型的英文提示词**，所以不能像页面那样见字符串就收，
 * 而是按「字段名白名单」只收用户可见的那几类。
 */
const DOMAIN_DIRS = ['src/domain', 'src/services', 'src/data'];
/**
 * 收集哪些字段的值。正向词、负向词、fragment、build*Messages 等
 * 进提示词的字段**不在这里**——它们不该受用户文案规则约束。
 */
const VISIBLE_FIELD_KEYS = new Set([
  'advice',
  'description',
  'error',
  'example',
  'hint',
  'label',
  'message',
  'notes',
  'reason',
  'suggestion',
  'summary',
  'title',
  'warnings',
  'whenToUse',
  'why',
]);
const ALLOWED_FONT_SIZES = new Set([12, 13, 14, 16, 20, 26]);

function walk(dir, extensions) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return walk(full, extensions);
    return extensions.some((ext) => full.endsWith(ext)) ? [full] : [];
  });
}

function lineOf(source, node) {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

/** 页面/组件：JSX 文本与所有字符串字面量都算可见文案 */
function collectJsxCopy(file) {
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

/**
 * 领域/服务层：只收白名单字段的值。
 *
 * 递归只走「字符串 / 数组 / 拼接 / 条件」这几种表达式，遇到对象字面量就停——
 * 避免把 `positive`、`negative` 这类提示词字段里嵌套的文案也扫进来。
 */
function collectDomainCopy(file) {
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
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

  const collectStrings = (node) => {
    if (!node) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      add(node.text, node);
      return;
    }
    if (ts.isTemplateExpression(node)) {
      add(node.head.text, node.head);
      for (const span of node.templateSpans) add(span.literal.text, span.literal);
      return;
    }
    if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) collectStrings(element);
      return;
    }
    if (
      ts.isBinaryExpression(node) ||
      ts.isParenthesizedExpression(node) ||
      ts.isConditionalExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression?.(node)
    ) {
      ts.forEachChild(node, collectStrings);
    }
  };

  const visit = (node) => {
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)) {
      if (VISIBLE_FIELD_KEYS.has(node.name.text)) collectStrings(node.initializer);
      return; // 白名单字段内部不再深入，避免重复收集
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

const pageFiles = PAGE_DIRS.flatMap((dir) => walk(path.join(ROOT, dir), ['.tsx', '.ts']));
const domainFiles = DOMAIN_DIRS.flatMap((dir) => walk(path.join(ROOT, dir), ['.ts', '.tsx']));
const copy = [...pageFiles.flatMap(collectJsxCopy), ...domainFiles.flatMap(collectDomainCopy)];
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
      warnings.push({ ...item, rule: rule.label });
    }
    rule.re.lastIndex = 0;
  }
  if (item.kind === 'hint' && item.text.length > 45) {
    warnings.push({ ...item, rule: `hint 超过 45 字（${item.text.length}）` });
  }
  if (item.kind === 'text' && item.text.length > 45) {
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

console.log(`可见文案：${copy.length} 条（页面/组件 ${pageFiles.length} 个文件，领域/服务 ${domainFiles.length} 个文件）`);
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
