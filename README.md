<img src="assets/pdf-maestro-logo.svg" width="64" alt="">

# PDF Maestro

Split, merge and convert PDFs, page by page. Everything runs on your own computer: files are never uploaded, and the offline build blocks all network access.

**Use it:** download `index.html` and open it in Chrome or Edge. It works with no internet connection.

## Features

- **Split** a PDF into single pages, or into files of every N pages
- **Merge** several PDFs into one, in any order
- **Images**: export pages as JPG or PNG at 72, 150 or 300 dpi
- Preview pages full screen, select them by clicking or by range (`1-3, 7, 10-`)
- Rotate, reorder (drag and drop), delete with undo
- Thumbnail and list views with adjustable thumbnail size
- Removes hidden info (author, software, dates) from output files
- Save to a folder you pick, or as one ZIP
- Macedonian and English interface (MK | EN)

## Project layout

| Path | What it is |
| --- | --- |
| `index.html` | The offline app: one file with every library and font embedded |
| `src/app.html` | Source page (loads libraries from a CDN) |
| `tools/build_standalone.py` | Builds `index.html` from `src/app.html` |
| `assets/` | Logo (SVG and PNG) |

## Build

```
npm install
npm run build
```

## Libraries

[pdf-lib](https://github.com/Hopding/pdf-lib), [PDF.js](https://github.com/mozilla/pdf.js), [JSZip](https://github.com/Stuk/jszip), [Inter](https://rsms.me/inter/).
