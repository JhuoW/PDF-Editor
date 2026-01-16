# Task: Implement Professional Image Insertion Feature

Read CLAUDE.md for project context. I need you to implement a complete image insertion feature for the PDF editor that mirrors the functionality of Microsoft Word, PowerPoint, and Adobe Acrobat. The feature should be accessible via an "Image" button under an "Insert" dropdown menu in the toolbar.

## Core Requirement
Users must be able to upload images (including e-signatures), insert them onto PDF pages, manipulate them freely (move, resize, rotate, crop), adjust properties, and save them persistently in the PDF. The experience should feel identical to mainstream office applications.

## Part 1: Menu Structure

**Create "Insert" Dropdown Menu in Main Toolbar:**
- Position: In the main toolbar, after existing tool groups
- Style: Dropdown button with down arrow indicator
- Label: "Insert"

**Dropdown Contents:**
- Image (with image icon) - primary item for this feature
- (Future items can be added: Shape, Text Box, Link, etc.)

**"Image" Menu Item Behavior:**
- Click opens file picker dialog
- Accepts: JPG, JPEG, PNG, GIF, WebP, BMP, SVG
- Multiple file selection supported
- After selection, enters image placement mode

## Part 2: Image Upload Methods

**Method 1 - File Picker (Primary):**
- Triggered by clicking Insert > Image
- Native file dialog opens
- Filter shows supported image formats
- Single or multiple selection
- Large file warning (suggest compression if > 5MB)

**Method 2 - Drag and Drop:**
- User can drag image files directly onto the PDF canvas
- Drop zone visual indicator appears when dragging over canvas
- Shows "Drop image here" overlay with dashed border
- Supports multiple files dropped at once

**Method 3 - Clipboard Paste:**
- Ctrl+V / Cmd+V when no text is being edited
- Detects image data in clipboard
- Works with screenshots (Snipping Tool, PrintScreen)
- Works with images copied from other applications
- Works with images copied from web browsers

**Method 4 - Drag from Desktop/Explorer:**
- Same as drag and drop but explicitly from file manager
- Show visual feedback during drag

## Part 3: Image Placement Flow

**After Image is Selected/Uploaded:**

**Option A - Click to Place:**
- Cursor changes to crosshair with image thumbnail preview
- Single click on page places image at that position
- Image placed at original size (or fit to reasonable max dimension)
- Image is immediately selected after placement

**Option B - Click and Drag to Define Size:**
- Click and drag to draw rectangle
- Image fills the drawn rectangle
- Aspect ratio preserved (fits within bounds)
- Release to place, image becomes selected

**Placement Behavior:**
- Image centers on click point
- If placed near edge, constrain to page bounds
- Show alignment guides when near other objects or page center
- Escape key cancels placement mode

**Multiple Images:**
- If multiple images uploaded, place them sequentially
- Each click places next image
- Or place all with automatic arrangement (grid or stacked with offset)

## Part 4: Interaction State Machine

**State 1 - Idle:**
- Image displays on page
- No selection indicators
- Click to select

**State 2 - Selected:**
- Single click activates selection
- Display 8 resize handles (corners + edge midpoints)
- Display rotation handle above top-center
- Display crop button or handle (optional, or via context menu)
- Blue/themed border indicates selection
- Can move by dragging image body
- Can resize by dragging handles
- Delete key removes image
- Properties panel shows image properties

**State 3 - Cropping (Sub-state):**
- Activated via toolbar button, context menu, or keyboard shortcut
- Crop handles appear at edges
- Drag handles to define crop area
- Dimmed/darkened area outside crop region
- Enter/Click "Apply Crop" to confirm
- Escape to cancel crop
- Cropping is non-destructive (can be reset)

## Part 5: Image Data Model

Design internal data structure for inserted images:

**Image Object Properties:**
- Unique identifier
- Page number (which page it belongs to)
- Original image data (base64 or blob reference)
- Current display dimensions (width, height)
- Position (x, y coordinates - top-left or center)
- Rotation angle (degrees)
- Crop bounds (top, right, bottom, left percentages)
- Opacity (0-100%)
- Z-index (layer order)
- Border properties (width, color, style)
- Shadow properties (optional)
- Lock aspect ratio flag
- Locked flag (prevent editing)
- Metadata (original filename, dimensions, file size)

**Image Store:**
- Collection of all images in document
- Organized by page
- Methods: add, remove, update, reorder, duplicate

## Part 6: Manipulation Features

**Moving:**
- Drag image body to reposition
- Arrow keys nudge by 1px (10px with Shift)
- Show coordinates tooltip during drag
- Snap to page center, edges, and other objects
- Snap guides appear when aligned
- Constrain to page bounds (optional toggle)

**Resizing:**
- 8 resize handles: 4 corners + 4 edge midpoints
- Corner handles: resize both dimensions, preserve aspect ratio by default
- Edge handles: resize one dimension only
- Hold Shift: toggle aspect ratio lock behavior
- Hold Alt/Option: resize from center point
- Show dimensions tooltip during resize
- Minimum size: 10x10 pixels
- Maximum size: page bounds (or allow overflow)

**Rotation:**
- Rotation handle above top-center
- Drag handle to rotate freely
- Hold Shift: snap to 15° increments
- Show angle tooltip during rotation
- Double-click rotation handle: reset to 0°
- Can also set precise angle in properties panel

**Cropping:**
- Enter crop mode via toolbar, context menu, or double-click
- 8 crop handles appear (can be different style from resize)
- Drag handles inward to define visible area
- Area outside crop is dimmed but visible
- Aspect ratio lock option while cropping
- Common aspect ratio presets (1:1, 4:3, 16:9, custom)
- Apply button confirms crop
- Cancel/Escape reverts
- "Reset Crop" option to restore original

**Flip:**
- Flip Horizontal: mirror left-right
- Flip Vertical: mirror top-bottom
- Available in toolbar and context menu

## Part 7: Image Formatting Toolbar

Create a contextual toolbar that appears when an image is selected:

**Left Section - Common Actions:**
- Crop toggle button
- Flip Horizontal button
- Flip Vertical button
- Rotate Left 90° button
- Rotate Right 90° button

**Middle Section - Arrangement:**
- Bring to Front
- Send to Back
- Bring Forward (one layer)
- Send Backward (one layer)

**Right Section - Quick Properties:**
- Opacity slider or input (0-100%)
- Border toggle with color picker
- Delete button

**Toolbar Behavior:**
- Appears above or below selected image (avoid covering image)
- Alternatively, appears as floating toolbar that follows selection
- Or integrates into main toolbar area when image is selected
- Hides when image is deselected

## Part 8: Image Properties Panel

Create a properties panel (sidebar or dialog) for detailed image settings:

**Position & Size Section:**
- X coordinate input (with unit toggle: px, mm, in, cm)
- Y coordinate input
- Width input
- Height input
- Lock aspect ratio checkbox
- Rotation angle input (degrees)
- "Reset Size" button (restore original dimensions)

**Crop Section:**
- Visual crop preview
- Crop values: Top, Right, Bottom, Left (as percentage or pixels)
- Aspect ratio dropdown for crop
- "Reset Crop" button

**Appearance Section:**
- Opacity slider: 0-100%
- Brightness slider: -100 to +100 (optional/advanced)
- Contrast slider: -100 to +100 (optional/advanced)

**Border Section:**
- Enable border checkbox
- Border color picker
- Border width input (pt)
- Border style: Solid, Dashed, Dotted
- Corner radius input (for rounded corners)

**Shadow Section (Optional/Advanced):**
- Enable shadow checkbox
- Shadow color picker
- Offset X and Y
- Blur radius
- Spread

**Image Info Section (Read-only):**
- Original filename
- Original dimensions
- File size
- Format

**Actions Section:**
- Replace Image button (swap with new image, keep size/position)
- Reset All button (restore all properties to default)
- Delete button

## Part 9: Keyboard Shortcuts

**When Image is Selected:**
- Delete / Backspace: Remove image
- Ctrl+C: Copy image
- Ctrl+X: Cut image
- Ctrl+V: Paste (duplicate if image in clipboard)
- Ctrl+D: Duplicate image (offset copy)
- Arrow keys: Nudge position 1px
- Shift+Arrow: Nudge position 10px
- Ctrl+] : Bring forward one layer
- Ctrl+[ : Send backward one layer
- Ctrl+Shift+] : Bring to front
- Ctrl+Shift+[ : Send to back
- Escape: Deselect image
- Enter: Enter crop mode (optional)

**Global Shortcuts:**
- Ctrl+V: Paste image from clipboard (when nothing selected)

**In Crop Mode:**
- Enter: Apply crop
- Escape: Cancel crop
- Arrow keys: Adjust crop bounds

## Part 10: Context Menu

Right-click on image shows context menu:

**Edit Section:**
- Cut
- Copy
- Paste
- Duplicate
- Delete

**Transform Section:**
- Crop Image
- Flip Horizontal
- Flip Vertical
- Rotate 90° Clockwise
- Rotate 90° Counter-clockwise
- Reset Transformations

**Arrange Section:**
- Bring to Front
- Send to Back
- Bring Forward
- Send Backward

**Properties Section:**
- Replace Image...
- Image Properties... (opens Properties panel)
- Save Image As... (export original image to file)

## Part 11: E-Signature Workflow

**Special Considerations for Signatures:**
- Often PNG with transparent background
- Preserve transparency when inserting
- Common signature placement locations (bottom of page)
- Quick-size presets for typical signature dimensions
- Optional: Signature library to save frequently used signatures

**Transparency Handling:**
- Detect and preserve alpha channel
- Show checkerboard pattern for transparent areas (optional)
- Ensure transparency renders correctly on PDF

## Part 12: Undo/Redo Integration

**Track These Actions:**
- Insert image (undo removes image)
- Delete image (undo restores image)
- Move image (store start and end positions)
- Resize image (store start and end dimensions)
- Rotate image (store start and end angles)
- Crop image (store previous crop bounds)
- Flip image (toggle operation)
- Change opacity
- Change border properties
- Change shadow properties
- Replace image (store previous image data)
- Layer order changes

**Undo/Redo Behavior:**
- Each action creates a history entry
- Undo restores previous state completely
- Redo reapplies the action
- Moving/resizing can be debounced (don't create entry for every pixel)

## Part 13: Copy/Paste Behavior

**Copy Image Object:**
- Stores complete image data including all properties
- Can paste within same page or different page
- Paste creates new image offset from original position

**Copy to External:**
- Right-click > Copy copies image to system clipboard
- Can paste into other applications

**Paste External Image:**
- Ctrl+V with image in clipboard
- Detects image data and triggers placement mode
- Works with screenshots, copied images, etc.

## Part 14: Visual Design Requirements

**Selection Appearance:**
- Resize handles: 8x8px squares, white fill with blue border
- Rotation handle: circle above image, connected by thin line
- Selection border: 2px solid blue (or theme color)
- Handle hover: cursor changes to appropriate resize cursor

**Crop Mode Appearance:**
- Crop handles: different style from resize (e.g., L-shaped corners)
- Dimmed overlay outside crop area (50% black)
- Crop bounds border: white dashed line
- Toolbar shows "Apply" and "Cancel" buttons prominently

**Placement Mode:**
- Cursor: crosshair with small image thumbnail
- Drop zone: dashed border when dragging file
- Alignment guides: thin colored lines when aligned

**Hover States:**
- Body hover: move cursor
- Handle hover: resize cursor (nwse, nesw, ns, ew)
- Rotation handle hover: rotate cursor
- Crop handle hover: crop cursor

## Part 15: Edge Cases to Handle

- Very large images: auto-scale to fit page or reasonable size
- Very small images: enforce minimum display size
- Corrupt/invalid image files: show error message, skip file
- Unsupported formats: show error, list supported formats
- Image on page edge: allow partial overflow or constrain
- Rotated image selection: proper hit detection
- Multiple images overlapping: click selects top-most
- Selecting image behind another: right-click menu or layer panel
- Zero opacity image: still selectable, show bounds on hover
- CMYK images: convert to RGB for display
- SVG images: rasterize or maintain as vector

## Part 16: PDF Persistence

**When Saving to PDF:**
- Embed image as XObject in PDF
- Compress images appropriately (JPEG for photos, PNG for graphics)
- Store transformation matrix for position, size, rotation
- Store crop as clipping path
- Store opacity in graphics state
- Preserve original image quality option

**When Loading from PDF:**
- Detect embedded images
- Extract transformation matrix
- Make images editable (if originally placed by this editor)
- Read-only mode for images from other sources (optional)

**Compatibility:**
- Images should display correctly in Adobe Reader
- Images should display correctly in web browsers
- Images should print correctly

## Part 17: Performance Considerations

- Lazy load images (don't decode until visible)
- Generate thumbnails for large images
- Cache decoded image data
- Use canvas for rendering, not DOM images
- Compress images before embedding (optional, with quality setting)
- Show loading indicator for large images

## Implementation Order

Implement in this sequence:
1. Menu structure (Insert dropdown with Image button)
2. File picker upload and basic image data handling
3. Image placement mode and click-to-place
4. Basic rendering of image on canvas
5. Selection state with resize handles
6. Move functionality
7. Resize functionality with aspect ratio
8. Rotation functionality
9. Image formatting toolbar
10. Properties panel
11. Crop functionality
12. Keyboard shortcuts
13. Context menu
14. Drag-and-drop upload
15. Clipboard paste
16. Undo/redo integration
17. Copy/paste (internal and external)
18. Flip functionality
19. Layer ordering
20. PDF serialization (save/load)
21. Edge cases and polish
22. Performance optimization

## Testing Checklist

After implementation, verify:
- [ ] Insert > Image menu item exists and opens file picker
- [ ] Can select JPG, PNG, GIF, WebP images
- [ ] Image enters placement mode after selection
- [ ] Click on page places image
- [ ] Image displays correctly (no distortion)
- [ ] Single click selects image and shows handles
- [ ] Can move image by dragging
- [ ] Can resize from all 8 handles
- [ ] Aspect ratio preserved when resizing from corners
- [ ] Edge handles resize one dimension only
- [ ] Rotation handle rotates image
- [ ] Shift constrains rotation to 15° increments
- [ ] Crop mode works correctly
- [ ] Can drag and drop image files onto canvas
- [ ] Can paste images from clipboard (Ctrl+V)
- [ ] All keyboard shortcuts work
- [ ] Context menu shows all options
- [ ] Properties panel displays and updates correctly
- [ ] Opacity changes render correctly
- [ ] Border appears when enabled
- [ ] Flip horizontal/vertical work
- [ ] Layer ordering (bring to front, etc.) works
- [ ] Undo reverses each action type
- [ ] Redo restores undone actions
- [ ] Copy/paste duplicates image correctly
- [ ] PNG transparency is preserved
- [ ] Image saves correctly to PDF
- [ ] Image loads correctly from saved PDF
- [ ] Image displays in Adobe Reader correctly
- [ ] Large images don't cause performance issues

## E-Signature Specific Tests:
- [ ] PNG with transparent background shows transparency
- [ ] Signature can be resized to typical signature size
- [ ] Multiple signatures can be placed on same page
- [ ] Signature position precise for form signing

Begin implementation following this specification. Start with the menu structure and file picker, then progress through the implementation order. Ask clarifying questions if any requirement is unclear.