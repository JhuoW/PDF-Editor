import { describe, expect, it } from 'vitest';
import { originalParagraphText } from '../../src/editing/ParagraphText';

describe('original PDF paragraph text', () => {
  it('joins every physical row of a Latin paragraph without losing words or adding duplicate spaces', () => {
    expect(originalParagraphText('First row\nSecond row\nThird row')).toBe('First row Second row Third row');
    expect(originalParagraphText('First row \nSecond row')).toBe('First row Second row');
  });
  it('joins Chinese rows and retains original hyphens and actual paragraph boundaries', () => {
    expect(originalParagraphText('第一行文字\n第二行文字\n第三行文字')).toBe('第一行文字第二行文字第三行文字');
    expect(originalParagraphText('well-\nknown')).toBe('well-known');
    expect(originalParagraphText('First paragraph\n\nSecond paragraph')).toBe('First paragraph\n\nSecond paragraph');
  });
});
