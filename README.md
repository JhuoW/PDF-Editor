![branding](docs/imgs/logo.png)

[中文介绍](README_zh.md)

**PDF-Editor** is a free, open-source PDF editor for your browser. View, edit, annotate, and organize PDFs locally without uploading your files. Switch between English and Chinese instantly.

<p align="center">
  <a href="docs/imgs/new_example_1.png"><img src="docs/imgs/new_example_1.png" width="100%" alt="PDF-Editor workspace overview" /></a>
</p>

<p align="center">
  <strong>Home · Edit · Annotate · Organize</strong><br /><br />
  <a href="docs/imgs/new_example_2.png"><img src="docs/imgs/new_example_2.png" width="100%" alt="Home toolbar with common PDF tools" /></a><br /><br />
  <a href="docs/imgs/new_example_3.png"><img src="docs/imgs/new_example_3.png" width="100%" alt="Edit toolbar for text, images, links, and bookmarks" /></a><br /><br />
  <a href="docs/imgs/new_example_4.png"><img src="docs/imgs/new_example_4.png" width="100%" alt="Annotate toolbar for markup, drawing, notes, and stamps" /></a><br /><br />
  <a href="docs/imgs/new_example_5.png"><img src="docs/imgs/new_example_5.png" width="100%" alt="Organize toolbar for page management" /></a>
</p>

## Features

- **📄 Viewing & Navigation**: Browse PDFs with thumbnails, bookmarks, search, and flexible page views.
- **✏️ Text & Image Editing**: Format original text, arrange objects, crop and transform images, or insert new content.
- **🖊️ Annotations & Signatures**: Highlight, draw, add notes, and place handwritten or image signatures.
- **🔗 Page Organization**: Extract, duplicate, replace, crop, merge, split, and reorder pages.
- **🖼️ PDF & Images**: Create PDFs from images, or export selected PDF pages as PNG/JPEG.
- **📝 Forms**: Create and fill PDF forms, import/export data, and flatten fields.
- **🔍 Scan OCR**: Make English and Simplified Chinese scans searchable with local recognition.
- **🔒 Private & Open Source**: Process documents locally, without subscriptions or cloud uploads.

## Quick Start

**Recommended:** Open [PDF-Editor online](https://wei2hu0.github.io/PDF-Editor/). No installation required.

### Basic Usage

1. **Open**: Click **Open** or drag a PDF into the viewer.
2. **Navigate**: Use thumbnails, page controls, and zoom to browse the document.
3. **Edit & Annotate**: Use **Edit objects** to move text and resize images, or **Edit text** to change the original wording. Add annotations from the toolbar.
4. **Organize**: Merge, split, rotate, or reorder pages. To crop, draw a rectangle and press **Enter** or **Confirm crop**.
5. **Save**: Use **Save** or **File → Save as…**. Use **Convert → PDF to images** to export selected pages as images.

### Local Build (Optional)

Requires [Node.js](https://nodejs.org/) 20.19+ (20.x) or 22.12+, and npm.

```bash
git clone https://github.com/JhuoW/PDF-Editor.git
cd PDF-Editor
npm ci
npm run build
npm run preview
```

Open `http://localhost:4173` in your browser. For development, use `npm run dev`.

## Contributing

Bug reports, feature requests, and pull requests are welcome. Start with an [issue](https://github.com/JhuoW/PDF-Editor/issues).

## Development checks

```bash
npm run build
npm run test:run
npx playwright install chromium
npm run test:e2e
npm run lint
npm run check:i18n
npm run audit:dependencies
```

### Static deployment

Deploy the entire `dist/` directory after `npm run build`. For a subdirectory:

```bash
npm run build -- --base=/pdf-editor/
```

Keep all bundled assets and license files. PDF-Editor and MuPDF use [AGPL-3.0](LICENSE); bundled Tesseract.js components and language data use Apache-2.0.
