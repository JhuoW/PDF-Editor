# Bug Report - PDF Editor Application

## Instructions for Claude Code

Please fix the following bugs in the PDF editor application. Address each bug individually, test the fix, and ensure no regressions are introduced. After fixing each bug, briefly explain what was wrong and how you fixed it.

---

## Bug #1: Merge Function Button Not Activating

**Severity:** High  
**Component:** Document Manipulation > Merge & Split

**Current Behavior:**
- When adding a new PDF file to combine with the current document, the `Merge & Download` button remains disabled/inactive
- Users cannot proceed with the merge operation even after selecting valid PDF files

**Expected Behavior:**
- The `Merge & Download` button should become enabled/active as soon as at least one additional PDF file is added to the merge queue
- Button state should dynamically update based on the file list

**Suggested Investigation Areas:**
1. Check the state management for the file list in the merge dialog
2. Verify the button's disabled condition logic
3. Ensure file upload handler is correctly updating the state
4. Check if there's a validation function that's incorrectly returning false

**Acceptance Criteria:**
- [ ] Button activates when 1+ files are added
- [ ] Button deactivates if all files are removed
- [ ] Merge operation completes successfully when button is clicked

---

## Bug #2: Missing Save Directory Dialog on Download

**Severity:** Medium  
**Component:** File Export / Download Functionality

**Current Behavior:**
- When triggering any download function (save, export, merge & download, etc.), the file downloads directly to the browser's default download location
- No dialog appears to let the user choose the destination folder or filename

**Expected Behavior:**
- Every download action should open a "Save As" dialog
- User should be able to:
  - Select the target directory
  - Modify the filename before saving
  - Choose the file format (if applicable)

**Technical Notes:**
- Use the File System Access API (`showSaveFilePicker()`) for modern browsers
- Provide fallback for browsers that don't support the API (use traditional download with suggested filename)

**Implementation Hint:**
```typescript
async function saveFileWithDialog(blob: Blob, suggestedName: string) {
  try {
    // Modern browsers with File System Access API
    const handle = await window.showSaveFilePicker({
      suggestedName: suggestedName,
      types: [{
        description: 'PDF Document',
        accept: { 'application/pdf': ['.pdf'] },
      }],
    });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
  } catch (err) {
    // Fallback for unsupported browsers or user cancellation
    if (err.name !== 'AbortError') {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = suggestedName;
      a.click();
      URL.revokeObjectURL(url);
    }
  }
}
```

**Acceptance Criteria:**
- [ ] Save dialog appears on all download actions
- [ ] User can select destination folder
- [ ] User can modify filename
- [ ] Fallback works for unsupported browsers
- [ ] Cancel action is handled gracefully (no error thrown)

---

## Bug #3: Page Rotation Not Reflected in Main View

**Severity:** High  
**Component:** Document Manipulation > Rotate Pages

**Current Behavior:**
- Clicking any rotation button (90° CW, 90° CCW, 180°) only updates the page thumbnail in the sidebar
- The main PDF viewer canvas does not reflect the rotation change
- The rotation state is inconsistent between views

**Expected Behavior:**
- Rotation should be applied globally to the page
- Both the sidebar thumbnail AND the main canvas view should display the rotated page
- The rotation should persist when navigating away and back to the page
- The rotation should be saved when exporting/downloading the PDF

**Suggested Investigation Areas:**
1. Check if rotation state is stored per-page in the document store
2. Verify the main `PageCanvas` component is subscribing to rotation state changes
3. Ensure the PDF.js render call includes the rotation parameter:
   ```typescript
   const viewport = page.getViewport({ 
     scale: scale, 
     rotation: pageRotation  // This might be missing or not updating
   });
   ```
4. Check if thumbnail and main view are reading from the same state source

**Root Cause Hypothesis:**
The rotation state is likely being updated correctly, but the main viewer component is either:
- Not listening to state changes, OR
- Not passing the rotation value to the PDF.js viewport, OR
- Using a stale/cached render

**Acceptance Criteria:**
- [ ] Rotation updates both thumbnail and main view simultaneously
- [ ] All rotation angles work correctly (90°, 180°, 270°)
- [ ] Rotation persists during navigation between pages
- [ ] Rotation is included in exported/saved PDF
- [ ] Rotation can be undone (see Bug #4)

---

## Bug #4: Undo (Ctrl+Z) Not Functional

**Severity:** High  
**Component:** History / Undo-Redo System

**Current Behavior:**
- Pressing `Ctrl+Z` (or `Cmd+Z` on Mac) does nothing
- Users cannot revert their last action
- No undo/redo functionality is available

**Expected Behavior:**
- `Ctrl+Z` / `Cmd+Z` should undo the last action
- `Ctrl+Shift+Z` / `Cmd+Shift+Z` (or `Ctrl+Y`) should redo
- The following actions should be undoable:
  - Page rotation
  - Page deletion
  - Page reordering
  - Adding/removing annotations
  - Text edits (if implemented)

**Implementation Requirements:**

1. **Create History Store:**
```typescript
interface HistoryState {
  past: DocumentSnapshot[];
  present: DocumentSnapshot;
  future: DocumentSnapshot[];
  
  // Actions
  pushState: (snapshot: DocumentSnapshot) => void;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
}
```

2. **Register Keyboard Shortcuts:**
```typescript
useEffect(() => {
  const handleKeyDown = (e: KeyboardEvent) => {
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const modifier = isMac ? e.metaKey : e.ctrlKey;
    
    if (modifier && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      undo();
    }
    if (modifier && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
      e.preventDefault();
      redo();
    }
  };
  
  window.addEventListener('keydown', handleKeyDown);
  return () => window.removeEventListener('keydown', handleKeyDown);
}, [undo, redo]);
```

3. **Add UI Buttons:**
- Add Undo/Redo buttons to the toolbar
- Show disabled state when no actions to undo/redo
- Consider showing action name in tooltip ("Undo Rotate Page")

**Acceptance Criteria:**
- [ ] `Ctrl+Z` triggers undo action
- [ ] `Ctrl+Shift+Z` or `Ctrl+Y` triggers redo action
- [ ] Works on both Windows and Mac
- [ ] Undo/Redo buttons visible in toolbar
- [ ] Buttons show correct disabled state
- [ ] All page operations are undoable
- [ ] History is cleared appropriately (e.g., on new document load)

---

## Testing Checklist

After implementing fixes, please verify:

| Test Case | Bug #1 | Bug #2 | Bug #3 | Bug #4 |
|-----------|--------|--------|--------|--------|
| Basic functionality works | ☐ | ☐ | ☐ | ☐ |
| Edge cases handled | ☐ | ☐ | ☐ | ☐ |
| No console errors | ☐ | ☐ | ☐ | ☐ |
| No regressions introduced | ☐ | ☐ | ☐ | ☐ |

---

## Priority Order

Please fix in this order:
1. **Bug #4** (Undo) - Foundation for safe editing
2. **Bug #3** (Rotation) - Core functionality broken  
3. **Bug #1** (Merge) - Feature completely blocked
4. **Bug #2** (Save Dialog) - UX improvement
