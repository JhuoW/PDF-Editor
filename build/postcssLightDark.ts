import postcss, { type Declaration, type PluginCreator } from 'postcss';

const FUNCTION = 'light-dark(';
const SUPPORTS = '(color: light-dark(#000, #fff))';

/** Replace every light-dark(light, dark) in a CSS value with its light argument. */
export function lightValue(value: string): string {
  let result = '', index = 0;
  for (;;) {
    const start = value.indexOf(FUNCTION, index);
    if (start < 0) return result + value.slice(index);
    result += value.slice(index, start);
    let depth = 0, comma = -1, end = start + FUNCTION.length - 1;
    for (; end < value.length; end++) {
      const character = value[end];
      if (character === '(') depth++;
      else if (character === ')' && --depth === 0) break;
      else if (character === ',' && depth === 1 && comma < 0) comma = end;
    }
    // Leave malformed input untouched; the browser reports it like any other CSS error.
    if (end >= value.length || comma < 0) return result + value.slice(start);
    result += lightValue(value.slice(start + FUNCTION.length, comma).trim());
    index = end + 1;
  }
}

/**
 * Keep the light theme working in browsers without light-dark() (Safari < 17.5,
 * Chrome < 123, Firefox < 120). Ordinary declarations get a light-only copy in
 * front of them, which those browsers use while newer ones override it. Custom
 * properties accept any value at parse time, so their light-dark() value moves
 * into an @supports block and the light value stays as the default.
 */
export const lightDarkFallback: PluginCreator<void> = () => ({
  postcssPlugin: 'light-dark-fallback',
  OnceExit(root) {
    const declarations: Declaration[] = [];
    root.walkDecls(declaration => {
      if (!declaration.value.includes(FUNCTION)) return;
      const parent = declaration.parent?.parent;
      if (parent?.type === 'atrule' && (parent as postcss.AtRule).name === 'supports' && (parent as postcss.AtRule).params === SUPPORTS) return;
      declarations.push(declaration);
    });
    const supportsByRule = new Map<postcss.Rule, postcss.Rule>();
    for (const declaration of declarations) {
      const light = lightValue(declaration.value);
      if (!declaration.prop.startsWith('--')) {
        const previous = declaration.prev();
        if (previous?.type !== 'decl' || previous.prop !== declaration.prop || previous.value !== light) declaration.cloneBefore({ value: light });
        continue;
      }
      const rule = declaration.parent;
      if (!rule || rule.type !== 'rule') continue;
      let copy = supportsByRule.get(rule as postcss.Rule);
      if (!copy) {
        const supports = postcss.atRule({ name: 'supports', params: SUPPORTS });
        copy = postcss.rule({ selector: (rule as postcss.Rule).selector });
        supports.append(copy);
        rule.after(supports);
        supportsByRule.set(rule as postcss.Rule, copy);
      }
      copy.append(declaration.clone());
      declaration.value = light;
    }
  },
});
lightDarkFallback.postcss = true;
