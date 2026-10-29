import { useMemo } from 'react';
import type { RichTextSegment, TextStyle } from '../../../annotations/types';
import { useTextBoxStore } from '../../../store/textBoxStore';
import { getStyleAtPosition, getSelectionStyle } from '../../../utils/richText';

// Export a hook to get the current selection style for toolbar display
export function useSelectionStyle(segments: RichTextSegment[], defaultStyle: TextStyle) {
  const { cursor, pendingFormat } = useTextBoxStore();

  return useMemo(() => {
    if (pendingFormat) {
      const baseStyle = getStyleAtPosition(segments, cursor.position) || defaultStyle;
      return {
        style: { ...baseStyle, ...pendingFormat },
        isMixed: {
          fontFamily: false,
          fontSize: false,
          fontWeight: false,
          fontStyle: false,
          textDecoration: false,
          color: false,
        },
      };
    }

    const hasSelection = cursor.selectionStart !== null && cursor.selectionEnd !== null;

    if (hasSelection) {
      const selStart = Math.min(cursor.selectionStart!, cursor.selectionEnd!);
      const selEnd = Math.max(cursor.selectionStart!, cursor.selectionEnd!);
      return getSelectionStyle(segments, selStart, selEnd);
    }

    return {
      style: getStyleAtPosition(segments, cursor.position > 0 ? cursor.position - 1 : 0) || defaultStyle,
      isMixed: {
        fontFamily: false,
        fontSize: false,
        fontWeight: false,
        fontStyle: false,
        textDecoration: false,
        color: false,
      },
    };
  }, [segments, cursor, pendingFormat, defaultStyle]);
}
