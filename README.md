<img src="assets/pdf-maestro-logo.svg" width="64" alt="">

# PDF Maestro

Split, merge, convert and edit PDFs, page by page. Everything runs on your own computer: files are never uploaded, and the offline build blocks all network access.

**Use it online:** https://sys32.github.io/pdf-maestro/

**Use it offline:** download `index.html` and open it in Chrome or Edge. It works with no internet connection.

## Features

- **Split** a PDF into single pages, or into files of every N pages
- **Merge** several PDFs into one, in any order
- **Images**: export pages as JPG or PNG at 72, 150 or 300 dpi
- Preview pages full screen, select them by clicking or by range (`1-3, 7, 10-`)
- Rotate, reorder (drag and drop), delete with undo
- Print a single page or a whole document's included pages
- **Edit** the real text in a PDF: click a line and type. Original fonts and colours are kept; the old text is removed from the file, not covered
  - Bold, italic, underline, strikethrough, size, colour, alignment, plus advanced options (font, spacing, width, highlight, superscript/subscript, case, opacity)
  - New lines, new text boxes anywhere on the page, move text by dragging, delete text, undo/redo
  - Fill in PDF form fields
  - Spots invoices billed to Kodart Netvork with missing or incomplete company details and offers to fix them in the invoice's own font
- Thumbnail and list views with adjustable thumbnail size
- Removes hidden info (author, software, dates) from output files
- Save to a folder you pick, or as one ZIP
- Macedonian and English interface (MK | EN)

## Project layout

| Path | What it is |
| --- | --- |
| `index.html` | The offline app: one file with every library and font embedded |
| `src/app.html` | Source page (loads libraries from a CDN) |
| `src/editor/` | The text editor (`app.html` UI, `engine.js` PDF text engine) |
| `tools/build_standalone.py` | Builds `index.html` from `src/app.html` and `src/editor/` |
| `assets/` | Logo (SVG and PNG) |

## Build

```
npm install
npm run build
```

## Libraries

[pdf-lib](https://github.com/Hopding/pdf-lib), [fontkit](https://github.com/Hopding/fontkit), [PDF.js](https://github.com/mozilla/pdf.js), [JSZip](https://github.com/Stuk/jszip), [Inter](https://rsms.me/inter/).
