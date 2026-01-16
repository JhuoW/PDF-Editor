# Text Box & Text Insertion Feature - Complete Implementation Prompt

## Prompt for Claude Code

```
I need you to implement a complete, professional-grade Text Box and Text Insertion feature for our PDF editor. This should mirror the functionality found in Adobe Acrobat or Foxit PDF Editor. Read the CLAUDE.md file for project context, then implement the following comprehensive text box system.

## Overview

The text box feature must support the complete lifecycle: creation, editing, formatting, manipulation, and persistence. It should feel native and responsive, with full undo/redo support at every stage.

---

## Part 1: Text Box Creation

### 1.1 Creation Modes

Implement TWO ways to create a text box:

**Mode A - Click to Create:**
- User clicks the Text Box tool in toolbar
- User clicks anywhere on the PDF canvas
- A default-sized text box appears (e.g., 200x100 pixels)
- Text box immediately enters edit mode with cursor blinking

**Mode B - Drag to Create:**
- User clicks the Text Box tool in toolbar
- User clicks and drags on the PDF canvas
- A selection rectangle shows the text box dimensions while dragging
- On mouse release, text box is created with those exact dimensions
- Text box immediately enters edit mode

### 1.2 Creation State Management

```typescript
interface TextBoxCreationState {
  isCreating: boolean;
  startPoint: { x: number; y: number } | null;
  currentPoint: { x: number; y: number } | null;
  previewRect: DOMRect | null;
}
```

Track creation in the UI store and render a preview rectangle during drag creation.

---

## Part 2: Text Box Data Model

### 2.1 Core Data Structure

```typescript
interface TextBox {
  // Identity
  id: string;
  type: 'textbox';
  pageNumber: number;
  
  // Geometry
  position: { x: number; y: number };  // Top-left corner in PDF coordinates
  width: number;
  height: number;
  rotation: number;  // Degrees
  
  // Content
  content: string;
  richContent?: RichTextSegment[];  // For mixed formatting
  
  // Text Styling
  textStyle: TextStyle;
  
  // Box Styling
  boxStyle: BoxStyle;
  
  // State
  isEditing: boolean;
  isSelected: boolean;
  isLocked: boolean;
  
  // Metadata
  createdAt: Date;
  modifiedAt: Date;
  author?: string;
}

interface TextStyle {
  fontFamily: string;
  fontSize: number;
  fontWeight: 'normal' | 'bold';
  fontStyle: 'normal' | 'italic';
  textDecoration: 'none' | 'underline' | 'line-through';
  color: string;
  lineHeight: number;
  letterSpacing: number;
  textAlign: 'left' | 'center' | 'right' | 'justify';
  verticalAlign: 'top' | 'middle' | 'bottom';
}

interface BoxStyle {
  backgroundColor: string;
  backgroundOpacity: number;
  borderColor: string;
  borderWidth: number;
  borderStyle: 'solid' | 'dashed' | 'dotted' | 'none';
  borderRadius: number;
  padding: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
  shadow?: {
    offsetX: number;
    offsetY: number;
    blur: number;
    color: string;
  };
}

// For rich text with mixed formatting within one text box
interface RichTextSegment {
  text: string;
  startIndex: number;
  endIndex: number;
  style: Partial<TextStyle>;
}
```

### 2.2 Default Values

```typescript
const DEFAULT_TEXT_STYLE: TextStyle = {
  fontFamily: 'Helvetica',
  fontSize: 12,
  fontWeight: 'normal',
  fontStyle: 'normal',
  textDecoration: 'none',
  color: '#000000',
  lineHeight: 1.4,
  letterSpacing: 0,
  textAlign: 'left',
  verticalAlign: 'top',
};

const DEFAULT_BOX_STYLE: BoxStyle = {
  backgroundColor: 'transparent',
  backgroundOpacity: 1,
  borderColor: '#000000',
  borderWidth: 1,
  borderStyle: 'solid',
  borderRadius: 0,
  padding: { top: 8, right: 8, bottom: 8, left: 8 },
};
```

---

## Part 3: Text Editing Capabilities

### 3.1 Edit Mode Activation

- **Double-click** on text box → Enter edit mode
- **Single-click** when already selected → Enter edit mode
- **Press Enter** when text box is selected → Enter edit mode
- **Click outside** or **Press Escape** → Exit edit mode and save

### 3.2 Text Input & Cursor

Implement a proper text cursor system:

```typescript
interface CursorState {
  position: number;  // Character index in content
  selectionStart: number | null;
  selectionEnd: number | null;
  isBlinking: boolean;
}
```

**Cursor Features:**
- Blinking cursor animation (530ms interval)
- Click to position cursor at nearest character
- Arrow keys to move cursor left/right
- Ctrl/Cmd + Arrow to move by word
- Home/End to move to line start/end
- Ctrl/Cmd + Home/End to move to content start/end

### 3.3 Text Selection

- **Click and drag** to select text
- **Double-click** to select word
- **Triple-click** to select entire paragraph/line
- **Ctrl/Cmd + A** to select all text in box
- **Shift + Arrow keys** to extend selection
- **Shift + Click** to extend selection to click point

Render selection with highlight background (e.g., light blue #3297FD with 30% opacity).

### 3.4 Keyboard Input

Handle all standard text input:
- Regular character input
- Backspace - delete character before cursor (or selection)
- Delete - delete character after cursor (or selection)
- Enter - new line (or paragraph based on settings)
- Tab - insert tab character or spaces
- Paste - handle plain text and rich text paste
- Cut/Copy - standard clipboard operations

### 3.5 Rich Text Editing (Mixed Formatting)

Allow different formatting within the same text box:

1. User selects a portion of text
2. User applies formatting (bold, color, size change)
3. Only the selected portion changes
4. Store as RichTextSegment array

Example: "Hello **world**" would be:
```typescript
richContent: [
  { text: 'Hello ', startIndex: 0, endIndex: 6, style: {} },
  { text: 'world', startIndex: 6, endIndex: 11, style: { fontWeight: 'bold' } }
]
```

---

## Part 4: Text Formatting Controls

### 4.1 Formatting Toolbar

When a text box is selected or in edit mode, show a formatting toolbar with:

**Font Controls:**
- Font family dropdown (list available PDF standard fonts + system fonts)
- Font size dropdown + direct input (6, 8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72)
- Bold button (Ctrl/Cmd + B)
- Italic button (Ctrl/Cmd + I)
- Underline button (Ctrl/Cmd + U)
- Strikethrough button

**Color Controls:**
- Text color picker
- Background/fill color picker
- Opacity slider

**Alignment Controls:**
- Align left
- Align center
- Align right
- Justify

**Spacing Controls:**
- Line height/spacing
- Letter spacing
- Paragraph spacing

**List Controls (optional but nice):**
- Bullet list
- Numbered list

### 4.2 Format Painter

Implement a format painter tool:
1. Select text with desired formatting
2. Click format painter button
3. Click on another text box or select text
4. Formatting is applied to target

### 4.3 Keyboard Shortcuts

```typescript
const FORMATTING_SHORTCUTS = {
  'Ctrl+B': 'toggleBold',
  'Ctrl+I': 'toggleItalic',
  'Ctrl+U': 'toggleUnderline',
  'Ctrl+Shift+X': 'toggleStrikethrough',
  'Ctrl+L': 'alignLeft',
  'Ctrl+E': 'alignCenter',
  'Ctrl+R': 'alignRight',
  'Ctrl+J': 'alignJustify',
  'Ctrl+Shift+>': 'increaseFontSize',
  'Ctrl+Shift+<': 'decreaseFontSize',
  'Ctrl+]': 'increaseFontSize',
  'Ctrl+[': 'decreaseFontSize',
};
```

---

## Part 5: Box Manipulation

### 5.1 Selection

- **Single click** on text box → Select it
- **Ctrl/Cmd + Click** → Add to multi-selection
- **Click and drag on empty area** → Marquee selection
- Show selection handles (8 points: corners + midpoints)

### 5.2 Moving

- **Drag** selected text box to move it
- **Arrow keys** to nudge by 1 pixel
- **Shift + Arrow keys** to nudge by 10 pixels
- Implement snapping:
  - Snap to page edges
  - Snap to other annotation edges
  - Snap to grid (if enabled)
  - Show alignment guides while dragging

```typescript
interface SnapGuide {
  type: 'horizontal' | 'vertical';
  position: number;
  source: 'page-edge' | 'annotation' | 'grid' | 'center';
}
```

### 5.3 Resizing

- **Drag corner handles** → Resize proportionally (with Shift) or freely
- **Drag edge handles** → Resize in one dimension
- **Minimum size** constraint (e.g., 20x20 pixels)
- Auto-resize option: box grows as text is typed

```typescript
interface ResizeState {
  isResizing: boolean;
  handle: 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | null;
  startBounds: DOMRect;
  aspectRatio: number | null;  // Lock when Shift is held
}
```

### 5.4 Rotation

- **Rotation handle** above the text box (circular icon)
- Drag to rotate freely
- Hold **Shift** to snap to 15° increments
- Show rotation degree indicator while rotating
- Support 0°, 90°, 180°, 270° quick rotation via context menu

### 5.5 Z-Index / Layering

- **Bring to Front** (Ctrl/Cmd + Shift + ])
- **Send to Back** (Ctrl/Cmd + Shift + [)
- **Bring Forward** (Ctrl/Cmd + ])
- **Send Backward** (Ctrl/Cmd + [)

---

## Part 6: Context Menu

Right-click on text box shows context menu:

```
┌─────────────────────────┐
│ Cut            Ctrl+X   │
│ Copy           Ctrl+C   │
│ Paste          Ctrl+V   │
│ Duplicate      Ctrl+D   │
├─────────────────────────┤
│ Delete         Del      │
├─────────────────────────┤
│ Edit Text               │
│ Text Properties...      │
│ Box Properties...       │
├─────────────────────────┤
│ Bring to Front          │
│ Send to Back            │
│ Bring Forward           │
│ Send Backward           │
├─────────────────────────┤
│ Lock Position           │
│ Lock Content            │
├─────────────────────────┤
│ Align                 ▶ │
│   ├─ Align Left         │
│   ├─ Align Center       │
│   ├─ Align Right        │
│   ├─ Align Top          │
│   ├─ Align Middle       │
│   └─ Align Bottom       │
├─────────────────────────┤
│ Rotate                ▶ │
│   ├─ Rotate 90° CW      │
│   ├─ Rotate 90° CCW     │
│   ├─ Rotate 180°        │
│   └─ Custom Rotation... │
└─────────────────────────┘
```

---

## Part 7: Undo/Redo System

### 7.1 Trackable Actions

Every action must be tracked in history:

```typescript
type TextBoxAction =
  | { type: 'CREATE_TEXTBOX'; textBox: TextBox }
  | { type: 'DELETE_TEXTBOX'; textBox: TextBox }
  | { type: 'MOVE_TEXTBOX'; id: string; fromPosition: Position; toPosition: Position }
  | { type: 'RESIZE_TEXTBOX'; id: string; fromBounds: Bounds; toBounds: Bounds }
  | { type: 'ROTATE_TEXTBOX'; id: string; fromRotation: number; toRotation: number }
  | { type: 'EDIT_TEXT'; id: string; fromContent: string; toContent: string }
  | { type: 'FORMAT_TEXT'; id: string; fromStyle: TextStyle; toStyle: TextStyle }
  | { type: 'FORMAT_BOX'; id: string; fromStyle: BoxStyle; toStyle: BoxStyle }
  | { type: 'CHANGE_ZINDEX'; id: string; fromIndex: number; toIndex: number };
```

### 7.2 History Store

```typescript
interface HistoryStore {
  past: TextBoxAction[];
  future: TextBoxAction[];
  
  pushAction: (action: TextBoxAction) => void;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
  clear: () => void;
}
```

### 7.3 Text Editing Batching

For text typing, batch multiple keystrokes into one undo action:
- Start a new action group on focus
- Batch all typing until:
  - 3 seconds of inactivity, OR
  - User presses space/enter, OR
  - User blurs the text box

This prevents undo from going character-by-character.

---

## Part 8: Properties Panel

### 8.1 Text Properties Panel

When text box selected, show properties panel:

```
┌─── Text Properties ───────────────┐
│                                   │
│ Font: [Helvetica        ▼]       │
│ Size: [12   ] pt                 │
│                                   │
│ Style: [B] [I] [U] [S]           │
│                                   │
│ Color: [■ #000000]               │
│                                   │
│ Alignment: [≡] [≡] [≡] [≡]      │
│            L   C   R   J         │
│                                   │
│ Line Height: [1.4  ]             │
│ Letter Spacing: [0   ] px        │
│                                   │
│ Vertical Align: [Top      ▼]    │
│                                   │
└───────────────────────────────────┘
```

### 8.2 Box Properties Panel

```
┌─── Box Properties ────────────────┐
│                                   │
│ Position                          │
│ X: [120.5 ] pt   Y: [340.2 ] pt │
│                                   │
│ Size                              │
│ W: [200  ] pt    H: [100  ] pt  │
│ [✓] Lock aspect ratio            │
│                                   │
│ Rotation: [0    ]°               │
│                                   │
│ Background                        │
│ Color: [■ transparent]           │
│ Opacity: [━━━━━━━○━━] 100%       │
│                                   │
│ Border                            │
│ Color: [■ #000000]               │
│ Width: [1    ] pt                │
│ Style: [Solid     ▼]            │
│ Radius: [0    ] pt               │
│                                   │
│ Padding                           │
│ T: [8 ] R: [8 ] B: [8 ] L: [8 ] │
│ [Link all]                       │
│                                   │
└───────────────────────────────────┘
```

---

## Part 9: Persistence & PDF Export

### 9.1 Save to PDF

Text boxes must be saved as FreeText annotations in the PDF:

```typescript
async function saveTextBoxToPDF(textBox: TextBox, pdfDoc: PDFDocument): Promise<void> {
  const page = pdfDoc.getPage(textBox.pageNumber - 1);
  
  // Create FreeText annotation
  // Set appearance stream with proper text rendering
  // Include all styling information
  // Handle rotation
  // Embed fonts if necessary
}
```

### 9.2 Load from PDF

Detect and load existing FreeText annotations:

```typescript
async function loadTextBoxesFromPDF(pdfDoc: PDFDocument): Promise<TextBox[]> {
  const textBoxes: TextBox[] = [];
  
  for (const page of pdfDoc.getPages()) {
    const annotations = page.node.Annots();
    // Filter for FreeText type
    // Parse appearance and content
    // Convert to TextBox objects
  }
  
  return textBoxes;
}
```

### 9.3 Flatten Text Boxes

Option to convert text boxes to permanent PDF content:

```typescript
async function flattenTextBox(textBox: TextBox, pdfDoc: PDFDocument): Promise<void> {
  // Render text box content directly into page content stream
  // Remove the annotation
  // Text becomes part of the page, no longer editable
}
```

---

## Part 10: Text Insertion (Inline Editing)

In addition to text boxes, implement inline text insertion on existing PDF text:

### 10.1 Insert Mode

- User clicks "Insert Text" tool
- User clicks at a position in the PDF
- A text cursor appears at that position
- User types to insert new text
- Text is added as a new content element at those coordinates

### 10.2 Difference from Text Box

| Feature | Text Box | Text Insertion |
|---------|----------|----------------|
| Visual boundary | Has visible/invisible border | No border, blends with content |
| Use case | Adding notes, comments, new blocks | Filling gaps, adding words |
| Selection | Selected as object | Behaves more like native text |

---

## Part 11: Component Architecture

```
src/
├── components/
│   └── TextBox/
│       ├── TextBoxTool.tsx          # Toolbar button and creation logic
│       ├── TextBoxCanvas.tsx        # Renders text box on canvas
│       ├── TextBoxEditor.tsx        # Edit mode with cursor/selection
│       ├── TextBoxHandles.tsx       # Selection/resize/rotation handles
│       ├── TextBoxContextMenu.tsx   # Right-click menu
│       ├── TextFormatToolbar.tsx    # Formatting toolbar
│       ├── TextPropertiesPanel.tsx  # Properties sidebar
│       ├── BoxPropertiesPanel.tsx   # Box styling sidebar
│       └── hooks/
│           ├── useTextBoxCreation.ts
│           ├── useTextBoxEditing.ts
│           ├── useTextBoxSelection.ts
│           ├── useTextBoxManipulation.ts
│           ├── useTextBoxHistory.ts
│           └── useTextBoxKeyboard.ts
├── store/
│   └── textBoxStore.ts              # Zustand store for text boxes
└── utils/
    ├── textBoxSerializer.ts         # Save/load from PDF
    ├── textMeasurement.ts           # Font metrics and text layout
    └── richTextParser.ts            # Parse/render rich text
```

---

## Part 12: Implementation Order

Please implement in this order:

1. **Data model and store** - TextBox interface and Zustand store
2. **Basic creation** - Click to create a simple text box
3. **Basic rendering** - Display text box on canvas with border
4. **Edit mode** - Double-click to edit, type text, exit on blur
5. **Cursor and selection** - Proper cursor positioning and text selection
6. **Basic formatting** - Font size, color, bold/italic/underline
7. **Move and resize** - Drag to move, handles to resize
8. **Undo/redo** - History tracking for all operations
9. **Rotation** - Rotation handle and snapping
10. **Rich text** - Mixed formatting within text box
11. **Properties panel** - Full control over all properties
12. **Context menu** - Right-click options
13. **Keyboard shortcuts** - All formatting shortcuts
14. **PDF persistence** - Save and load from PDF files
15. **Text insertion tool** - Inline text insertion

---

## Part 13: Testing Checklist

After implementation, verify:

- [ ] Can create text box by clicking
- [ ] Can create text box by dragging
- [ ] Can type text after creation
- [ ] Can double-click to edit existing text box
- [ ] Cursor blinks and positions correctly
- [ ] Can select text by dragging
- [ ] Can select word by double-click
- [ ] Can select all with Ctrl+A
- [ ] Cut/Copy/Paste work correctly
- [ ] Bold/Italic/Underline toggle correctly
- [ ] Font family changes apply
- [ ] Font size changes apply
- [ ] Text color changes apply
- [ ] Text alignment works
- [ ] Can move text box by dragging
- [ ] Can resize text box via handles
- [ ] Can rotate text box via rotation handle
- [ ] Shift constrains resize to aspect ratio
- [ ] Shift snaps rotation to 15° increments
- [ ] Undo reverts all operations
- [ ] Redo restores all operations
- [ ] Context menu shows all options
- [ ] Keyboard shortcuts work
- [ ] Text box saves to PDF correctly
- [ ] Text box loads from PDF correctly
- [ ] Properties panel updates live
- [ ] Multiple selection works
- [ ] Z-index ordering works
- [ ] Lock position/content works

---

Please implement this complete text box system. Start with the data model and store, then work through each part systematically. Test each feature as you implement it before moving to the next.
```

---

## Quick Reference Summary

This prompt instructs Claude Code to build:

| Category | Features |
|----------|----------|
| **Creation** | Click-to-create, drag-to-create, default sizing |
| **Editing** | Full text editing with cursor, selection, rich text |
| **Formatting** | Font, size, color, weight, alignment, decoration |
| **Box Styling** | Background, border, padding, shadow, opacity |
| **Manipulation** | Move, resize, rotate, z-index, lock |
| **History** | Full undo/redo for every operation |
| **Persistence** | Save/load as PDF FreeText annotations |
| **UI** | Toolbar, properties panel, context menu, shortcuts |