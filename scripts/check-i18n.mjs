import fs from 'node:fs';
import ts from 'typescript';
import path from 'node:path';

function catalog(file) {
  const ast = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  let result;
  function visit(node) {
    if (ts.isObjectLiteralExpression(node) && !result) result = JSON.parse(node.getText(ast));
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return result;
}
const en = catalog('src/i18n/en.ts'), zh = catalog('src/i18n/zh-CN.ts');
const failures = [];
const slots = value => [...value.matchAll(/\{\w+\}/g)].map(match => match[0]).sort().join(',');
for (const key of new Set([...Object.keys(en), ...Object.keys(zh)])) {
  if (!en[key] || !zh[key]?.trim()) failures.push(`Missing translation: ${key}`);
  else if (slots(en[key]) !== slots(zh[key])) failures.push(`Interpolation differs: ${key}`);
}
const sources = new Set(Object.values(en));
for (const file of fs.readdirSync('src', { recursive: true }).filter(file => file.endsWith('.tsx'))) {
  const full = path.join('src', file), ast = ts.createSourceFile(full, fs.readFileSync(full, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const report = (node, message) => failures.push(`${full}:${ast.getLineAndCharacterOfPosition(node.pos).line + 1}: ${message}`);
  function visit(node) {
    if (ts.isJsxText(node) && /[A-Za-z]{2}/.test(node.text.replace(/&[a-z]+;/gi, ''))) {
      const parent = node.parent;
      const autonym = ts.isJsxElement(parent) && parent.openingElement.attributes.properties.some(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(ast) === 'data-i18n-autonym');
      if (!autonym) report(node, 'Untranslated JSX text');
    }
    if (ts.isJsxAttribute(node) && ['aria-label', 'title', 'placeholder', 'alt'].includes(node.name.getText(ast)) && node.initializer && ts.isStringLiteral(node.initializer) && /[A-Za-z]{2}/.test(node.initializer.text)) report(node, 'Untranslated UI attribute');
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 't' && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      const key = node.arguments[0].text;
      if (!en[key] && !sources.has(key)) report(node, `Unknown translation: ${key}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
}
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
else console.log(`i18n: ${Object.keys(en).length} bilingual messages; matching placeholders; JSX and UI attributes checked.`);
