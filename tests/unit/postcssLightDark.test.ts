import postcss from 'postcss';
import { describe, expect, it } from 'vitest';
import { lightDarkFallback, lightValue } from '../../build/postcssLightDark';

const run = async (css: string) => (await postcss([lightDarkFallback()]).process(css, { from: undefined })).css;

describe('light-dark() fallback', () => {
  it('extracts the light argument, including nested functions and several calls', () => {
    expect(lightValue('light-dark(#fff, #18191c)')).toBe('#fff');
    expect(lightValue('1px solid light-dark(rgb(0 0 0 / 10%), rgba(255, 255, 255, .2))')).toBe('1px solid rgb(0 0 0 / 10%)');
    expect(lightValue('var(--gray-2, light-dark(#fff, #18191c))')).toBe('var(--gray-2, #fff)');
    expect(lightValue('repeating-conic-gradient(light-dark(#f3f4f6, #1f2023) 0% 25%, light-dark(#fff, #18191c) 0% 50%)'))
      .toBe('repeating-conic-gradient(#f3f4f6 0% 25%, #fff 0% 50%)');
    expect(lightValue('light-dark(light-dark(#111, #222), #333)')).toBe('#111');
    expect(lightValue('#356ae6')).toBe('#356ae6');
  });

  it('leaves malformed calls alone', () => {
    expect(lightValue('light-dark(#fff)')).toBe('light-dark(#fff)');
    expect(lightValue('light-dark(#fff, #000')).toBe('light-dark(#fff, #000');
  });

  it('puts a light-only declaration in front of ordinary properties', async () => {
    expect(await run('.a { color: light-dark(#111, #eee); margin: 0; }'))
      .toBe('.a { color: #111; color: light-dark(#111, #eee); margin: 0; }');
  });

  it('keeps custom properties light and moves the adaptive value behind @supports', async () => {
    const css = await run('.app { --bg: light-dark(#fff, #111); --fg: light-dark(#111, #eee); --size: 4px; }');
    expect(css.replace(/\s+/g, ' ')).toBe('.app { --bg: #fff; --fg: #111; --size: 4px; } '
      + '@supports (color: light-dark(#000, #fff)) { .app { --bg: light-dark(#fff, #111); --fg: light-dark(#111, #eee); } }');
  });

  it('is idempotent when the stylesheet is processed again', async () => {
    const once = await run('.a { --bg: light-dark(#fff, #111); color: light-dark(#111, #eee); }');
    const twice = await run(once);
    expect(twice.match(/@supports/g)).toHaveLength(1);
    expect(twice).toBe(once);
  });
});
