# Text Box Formatting Fix - Microsoft Word/PowerPoint Style

## Prompt for Claude Code

```
Fix the text box formatting system to work exactly like Microsoft Word and PowerPoint. Currently, after typing text into a text box, users cannot select text and modify its font, size, color, or other properties. This must be fixed to match the standard text editing experience users expect.

## Core Problem

The text box currently treats formatting as a "whole box" property instead of allowing per-character/per-selection formatting like Word/PowerPoint.

## Required Behavior (Mirror Word/PowerPoint Exactly)

### Behavior 1: Text Selection Within Text Box

When a text box is in edit mode:

1. **Click and drag** → Select characters between start and end points
2. **Double-click on word** → Select entire word
3. **Triple-click** → Select entire line or paragraph
4. **Ctrl/Cmd + A** → Select all text in the text box
5. **Shift + Arrow keys** → Extend selection character by character
6. **Ctrl/Cmd + Shift + Arrow** → Extend selection word by word
7. **Shift + Click** → Extend selection from cursor to click point
8. **Shift + Home/End** → Select to beginning/end of line

Visual feedback:
- Selected text must have a highlight background (use #3297FD at 30% opacity)
- Selection should be visible and clear
- Cursor should blink at selection boundary

### Behavior 2: Apply Formatting to Selection

When text is selected, ANY formatting change applies ONLY to the selected text:

```
Example:
- Text box contains: "Hello World"
- User selects "World"
- User clicks Bold button
- Result: "Hello **World**" (only "World" is bold)

Another example:
- Text box contains: "The quick brown fox"
- User selects "quick"
- User changes color to red
- User then selects "fox"
- User changes color to blue
- Result: "The [quick in red] brown [fox in blue]"
```

### Behavior 3: Formatting Toolbar Reflects Selection

The formatting toolbar must update to show the current selection's format:

1. **When text is selected:**
   - Font dropdown shows the font of selection (or "Multiple" if mixed)
   - Size dropdown shows the size of selection (or blank if mixed)
   - Bold button is pressed/highlighted if selection is bold
   - Italic button is pressed/highlighted if selection is italic
   - Color picker shows the color of selection

2. **When cursor is positioned (no selection):**
   - Toolbar shows format that will apply to newly typed text
   - This is typically the format of the character before the cursor

3. **When mixed formatting is selected:**
   - Buttons show "partially active" state (e.g., semi-highlighted)
   - Clicking a button toggles the format for entire selection

### Behavior 4: Typing with Format

1. **Cursor in text box, no selection:**
   - New typed characters inherit format from character before cursor
   - Or use the "pending format" if user changed format before typing

2. **Text is selected, user types:**
   - Selected text is replaced with new typed character
   - New character uses the format of the selection start (or pending format)

### Behavior 5: Pending Format (Critical Feature)

Like Word, implement "pending format":

```
Scenario:
1. Cursor is at position, nothing selected
2. User clicks Bold button (enabling it)
3. User types "important"
4. Result: "important" appears in bold
5. User clicks Bold button again (disabling it)
6. User types " note"
7. Result: "important note" where "important" is bold, " note" is normal
```

```typescript
interface PendingFormat {
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: 'normal' | 'bold';
  fontStyle?: 'normal' | 'italic';
  textDecoration?: 'none' | 'underline' | 'line-through';
  color?: string;
}

// Store pending format when user changes format with no selection
let pendingFormat: PendingFormat | null = null;

// Apply pending format to newly typed characters
// Clear pending format after typing or moving cursor
```

---

## Implementation Requirements

### Data Structure for Rich Text

Store text as segments with individual formatting:

```typescript
interface TextSegment {
  text: string;
  style: TextStyle;
}

interface TextStyle {
  fontFamily: string;
  fontSize: number;
  fontWeight: 'normal' | 'bold';
  fontStyle: 'normal' | 'italic';
  textDecoration: 'none' | 'underline' | 'line-through';
  color: string;
  backgroundColor?: string;
}

interface TextBoxContent {
  segments: TextSegment[];
}

// Example: "Hello World" with "World" bold
const content: TextBoxContent = {
  segments: [
    { 
      text: "Hello ", 
      style: { fontFamily: "Arial", fontSize: 12, fontWeight: "normal", fontStyle: "normal", textDecoration: "none", color: "#000000" }
    },
    { 
      text: "World", 
      style: { fontFamily: "Arial", fontSize: 12, fontWeight: "bold", fontStyle: "normal", textDecoration: "none", color: "#000000" }
    }
  ]
};
```

### Selection State

```typescript
interface SelectionState {
  // Character indices in the flattened text
  start: number;
  end: number;
  
  // Direction of selection (for shift+arrow behavior)
  direction: 'forward' | 'backward' | 'none';
}

interface TextBoxEditState {
  isEditing: boolean;
  cursorPosition: number;
  selection: SelectionState | null;
  pendingFormat: Partial<TextStyle> | null;
}
```

### Key Functions to Implement

```typescript
// 1. Get the style at a specific position
function getStyleAtPosition(segments: TextSegment[], position: number): TextStyle;

// 2. Get the combined style of a selection (for toolbar display)
function getSelectionStyle(segments: TextSegment[], start: number, end: number): {
  style: Partial<TextStyle>;  // Common properties
  isMixed: {                   // Which properties have multiple values
    fontFamily: boolean;
    fontSize: boolean;
    fontWeight: boolean;
    fontStyle: boolean;
    textDecoration: boolean;
    color: boolean;
  };
};

// 3. Apply style to a range
function applyStyleToRange(
  segments: TextSegment[], 
  start: number, 
  end: number, 
  styleChanges: Partial<TextStyle>
): TextSegment[];

// 4. Insert text at position with style
function insertTextAtPosition(
  segments: TextSegment[],
  position: number,
  text: string,
  style: TextStyle
): TextSegment[];

// 5. Delete text in range
function deleteTextInRange(
  segments: TextSegment[],
  start: number,
  end: number
): TextSegment[];

// 6. Normalize segments (merge adjacent segments with same style)
function normalizeSegments(segments: TextSegment[]): TextSegment[];
```

### Rendering Rich Text

Render each segment separately with its own styling:

```tsx
function RichTextRenderer({ segments, selection }: Props) {
  let charIndex = 0;
  
  return (
    <div className="text-content">
      {segments.map((segment, i) => {
        const segmentStart = charIndex;
        const segmentEnd = charIndex + segment.text.length;
        charIndex = segmentEnd;
        
        // Check if this segment overlaps with selection
        const isSelected = selection && 
          segmentStart < selection.end && 
          segmentEnd > selection.start;
        
        return (
          <span
            key={i}
            style={{
              fontFamily: segment.style.fontFamily,
              fontSize: `${segment.style.fontSize}px`,
              fontWeight: segment.style.fontWeight,
              fontStyle: segment.style.fontStyle,
              textDecoration: segment.style.textDecoration,
              color: segment.style.color,
            }}
          >
            {renderTextWithSelection(segment.text, segmentStart, selection)}
          </span>
        );
      })}
    </div>
  );
}

function renderTextWithSelection(
  text: string, 
  startIndex: number, 
  selection: SelectionState | null
) {
  if (!selection) return text;
  
  // Split text into selected and non-selected parts
  // Wrap selected parts in highlight span
  // Return array of spans
}
```

### Formatting Toolbar Integration

```tsx
function TextFormatToolbar({ textBox, selection, pendingFormat }: Props) {
  // Get current format to display
  const currentFormat = useMemo(() => {
    if (pendingFormat) {
      return { ...getStyleAtCursor(), ...pendingFormat };
    }
    if (selection && selection.start !== selection.end) {
      return getSelectionStyle(textBox.segments, selection.start, selection.end);
    }
    return getStyleAtPosition(textBox.segments, cursorPosition);
  }, [textBox, selection, pendingFormat, cursorPosition]);

  const handleBoldClick = () => {
    const newWeight = currentFormat.fontWeight === 'bold' ? 'normal' : 'bold';
    
    if (selection && selection.start !== selection.end) {
      // Apply to selection
      applyStyleToSelection({ fontWeight: newWeight });
    } else {
      // Set pending format for next typed character
      setPendingFormat(prev => ({ ...prev, fontWeight: newWeight }));
    }
  };

  const handleFontSizeChange = (size: number) => {
    if (selection && selection.start !== selection.end) {
      applyStyleToSelection({ fontSize: size });
    } else {
      setPendingFormat(prev => ({ ...prev, fontSize: size }));
    }
  };

  // Similar handlers for all formatting options...
  
  return (
    <div className="format-toolbar">
      <FontFamilyDropdown 
        value={currentFormat.fontFamily} 
        mixed={currentFormat.isMixed?.fontFamily}
        onChange={handleFontFamilyChange}
      />
      <FontSizeDropdown 
        value={currentFormat.fontSize}
        mixed={currentFormat.isMixed?.fontSize}
        onChange={handleFontSizeChange}
      />
      <ToolbarButton
        icon={<BoldIcon />}
        active={currentFormat.fontWeight === 'bold'}
        partiallyActive={currentFormat.isMixed?.fontWeight}
        onClick={handleBoldClick}
      />
      <ToolbarButton
        icon={<ItalicIcon />}
        active={currentFormat.fontStyle === 'italic'}
        partiallyActive={currentFormat.isMixed?.fontStyle}
        onClick={handleItalicClick}
      />
      <ToolbarButton
        icon={<UnderlineIcon />}
        active={currentFormat.textDecoration === 'underline'}
        onClick={handleUnderlineClick}
      />
      <ColorPicker
        value={currentFormat.color}
        mixed={currentFormat.isMixed?.color}
        onChange={handleColorChange}
      />
    </div>
  );
}
```

### Keyboard Shortcut Handlers

```typescript
function handleKeyDown(e: KeyboardEvent, state: TextBoxEditState) {
  const { selection, cursorPosition, pendingFormat } = state;
  
  // Ctrl/Cmd + B: Toggle Bold
  if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
    e.preventDefault();
    toggleFormat('fontWeight', 'bold', 'normal');
    return;
  }
  
  // Ctrl/Cmd + I: Toggle Italic
  if ((e.ctrlKey || e.metaKey) && e.key === 'i') {
    e.preventDefault();
    toggleFormat('fontStyle', 'italic', 'normal');
    return;
  }
  
  // Ctrl/Cmd + U: Toggle Underline
  if ((e.ctrlKey || e.metaKey) && e.key === 'u') {
    e.preventDefault();
    toggleFormat('textDecoration', 'underline', 'none');
    return;
  }
  
  // Regular character input
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    
    // Determine style for new character
    const style = pendingFormat 
      ? { ...getStyleAtPosition(cursorPosition), ...pendingFormat }
      : getStyleAtPosition(cursorPosition);
    
    if (selection && selection.start !== selection.end) {
      // Replace selection with new character
      deleteTextInRange(selection.start, selection.end);
      insertTextAtPosition(selection.start, e.key, style);
      setCursorPosition(selection.start + 1);
    } else {
      // Insert at cursor
      insertTextAtPosition(cursorPosition, e.key, style);
      setCursorPosition(cursorPosition + 1);
    }
    
    // Clear pending format after typing
    setPendingFormat(null);
    return;
  }
}

function toggleFormat(
  property: keyof TextStyle, 
  activeValue: any, 
  inactiveValue: any
) {
  const currentStyle = getSelectionOrCursorStyle();
  const newValue = currentStyle[property] === activeValue ? inactiveValue : activeValue;
  
  if (hasSelection()) {
    applyStyleToSelection({ [property]: newValue });
  } else {
    setPendingFormat(prev => ({ ...prev, [property]: newValue }));
  }
}
```

---

## Visual Behavior Reference

### Selection Highlight
```css
.text-selection {
  background-color: rgba(50, 151, 253, 0.3);  /* Light blue highlight */
  border-radius: 2px;
}
```

### Toolbar Button States
```css
/* Normal state */
.toolbar-button {
  background: transparent;
  border: 1px solid transparent;
}

/* Hover */
.toolbar-button:hover {
  background: #f0f0f0;
  border-color: #ddd;
}

/* Active (format is applied) */
.toolbar-button.active {
  background: #e0e7ff;
  border-color: #818cf8;
  color: #4f46e5;
}

/* Partially active (mixed selection) */
.toolbar-button.partial {
  background: #f0f0f0;
  border-color: #ccc;
  position: relative;
}
.toolbar-button.partial::after {
  content: '';
  position: absolute;
  bottom: 2px;
  left: 50%;
  transform: translateX(-50%);
  width: 4px;
  height: 4px;
  background: #4f46e5;
  border-radius: 50%;
}
```

---

## Testing Checklist

After implementation, verify ALL of these work:

### Text Selection
- [ ] Click and drag selects text
- [ ] Double-click selects word
- [ ] Triple-click selects line/paragraph  
- [ ] Ctrl+A selects all text
- [ ] Shift+Arrow extends selection
- [ ] Shift+Click extends selection
- [ ] Selection is visually highlighted

### Apply Formatting to Selection
- [ ] Select text → Click Bold → Only selection becomes bold
- [ ] Select text → Change font size → Only selection changes
- [ ] Select text → Change color → Only selection changes
- [ ] Select text → Change font family → Only selection changes
- [ ] Select text → Click Italic → Only selection becomes italic
- [ ] Select text → Click Underline → Only selection becomes underlined

### Mixed Formatting
- [ ] Can have multiple formats in same text box
- [ ] Each word can have different font
- [ ] Each word can have different size
- [ ] Each word can have different color
- [ ] Formats persist after deselecting

### Toolbar Reflects Selection
- [ ] Select bold text → Bold button shows active
- [ ] Select italic text → Italic button shows active
- [ ] Select text with size 24 → Size dropdown shows 24
- [ ] Select text with mixed sizes → Size dropdown shows blank or "—"
- [ ] Select text with mixed bold/normal → Bold button shows partial state

### Pending Format
- [ ] No selection + Click Bold + Type → New text is bold
- [ ] No selection + Change size to 24 + Type → New text is size 24
- [ ] No selection + Change color to red + Type → New text is red
- [ ] Pending format clears after typing
- [ ] Pending format clears when moving cursor

### Keyboard Shortcuts
- [ ] Ctrl/Cmd+B toggles bold on selection
- [ ] Ctrl/Cmd+I toggles italic on selection
- [ ] Ctrl/Cmd+U toggles underline on selection
- [ ] Shortcuts work with pending format when no selection

---

## Priority Implementation Order

1. **Rich text data structure** - Change from single style to segments array
2. **Text selection system** - Click, drag, keyboard selection
3. **Selection rendering** - Visual highlight of selected text
4. **applyStyleToRange function** - Core formatting logic
5. **Connect toolbar to selection** - Toolbar buttons modify selection
6. **Toolbar state reflection** - Toolbar shows current selection format
7. **Pending format system** - Format changes without selection
8. **Keyboard shortcuts** - Ctrl+B, Ctrl+I, Ctrl+U
9. **Mixed format indicators** - Partial active states in toolbar
10. **Undo/redo integration** - Track formatting changes in history

---

## Critical Notes

1. **Do NOT apply formatting to entire text box** - Only apply to selection
2. **Segments must merge** - Adjacent segments with identical styles should merge
3. **Empty segments must be removed** - Clean up after deletions
4. **Cursor position is separate from selection** - Maintain both states
5. **Pending format is temporary** - Clear after use or cursor movement
6. **Test with complex formatting** - Multiple colors, sizes, fonts in one box

Implement this fix now. The text box MUST behave exactly like Microsoft Word when selecting and formatting text.
```