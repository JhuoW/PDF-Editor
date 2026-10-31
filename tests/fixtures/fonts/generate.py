"""Rebuild tiny test fonts; requires fontTools and the system Noto CJK package.
The TTF contains deliberately simple test outlines, not a usable typeface.
The OTF is a renamed Noto subset; see OFL.txt. No fonts are downloaded at runtime.
"""
from pathlib import Path
from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
root = Path(__file__).parent
text = ''.join(chr(i) for i in range(32, 127)) + '中文字体编辑搜索测试删除替换新增第一二行这是保留内容原始混排标点，（）。'
font = TTFont('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', fontNumber=2)
sub = subset.Subsetter(); sub.populate(text=text); sub.subset(font)
for record in font['name'].names:
    if record.nameID in (1, 3, 4, 6): record.string = 'PDFEditorTestCJK'.encode(record.getEncoding())
font['CFF '].cff.fontNames = ['PDFEditorTestCJK']
font.save(root / 'TestCJK.otf')
chars = list(dict.fromkeys(text)); names = ['.notdef'] + [f'uni{ord(c):04X}' for c in chars]
fb = FontBuilder(1000, isTTF=True); fb.setupGlyphOrder(names); fb.setupCharacterMap({ord(c): name for c,name in zip(chars,names[1:])})
glyphs = {}
for name in names:
    pen = TTGlyphPen(None)
    if name != 'uni0020':
        pen.moveTo((60, 0)); pen.lineTo((60, 700)); pen.lineTo((540, 700)); pen.lineTo((540, 0)); pen.closePath()
    glyphs[name] = pen.glyph()
fb.setupGlyf(glyphs); fb.setupHorizontalMetrics({n:(600, 0) for n in names}); fb.setupHorizontalHeader(ascent=800, descent=-200)
fb.setupNameTable({'familyName':'PDFEditorTestTTF', 'styleName':'Regular', 'uniqueFontIdentifier':'PDFEditorTestTTF', 'fullName':'PDFEditorTestTTF', 'psName':'PDFEditorTestTTF'})
fb.setupOS2(sTypoAscender=800,sTypoDescender=-200,usWinAscent=800,usWinDescent=200,fsType=0)
fb.setupPost(); fb.save(root / 'TestCJK.ttf')
