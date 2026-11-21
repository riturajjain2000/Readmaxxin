# Development guide

Run `npm ci` and `npm start` with Node.js 22.13 or newer. The Node server serves local dependencies and the browser app directly. For a different port, start it with `PORT=4180 npm start` and open [port 4180](http://127.0.0.1:4180). Each port has its own browser storage.

## How it fits together

| Area | Responsibility |
| --- | --- |
| [Browser app](../app.js) | Native editing, text selection, search, explanation UI, and workspace restoration |
| [Document handling](../lib/document.js) and [imports](../lib/imports.js) | Convert supported formats into sanitized, editable HTML |
| [Model integration](../lib/ai.js) | Prepare scoped requests, parse provider streams, and normalize explanations |
| [Local connector](../server.mjs) | Serve local assets, discover available models, and forward streaming requests |

PDF.js extracts selectable PDF text, Mammoth converts Word document structure, and KaTeX renders math. The browser stores the editable copy and the imported source in IndexedDB. The connector runs on loopback for local use. Keep it on your machine and connect it to endpoints you trust.

## Automated checks

```sh
npm test
```

The suite covers document parsing and import limits, search across inline formatting, recovery, prompt construction, stream parsing, and the local HTTP connector. The model tests use synthetic responses and require no model account or API key.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| The app page fails to load | Install dependencies with `npm ci`, run `npm start`, and use the printed loopback URL. |
| No models appear after a connection check | Confirm the service is running, verify the protocol and endpoint, and enter a model name manually if discovery is unavailable. |
| The provider rejects a request | Check the model name and re-enter the key if you refreshed the page. Check provider access and quota for cloud connections. |
| The workspace appears empty after restart | Check the browser profile, hostname, and port. Browser storage is separate for `localhost` and `127.0.0.1`. |
| A PDF imports without usable text | Check whether you can select its text in a PDF reader. Run OCR first for scanned pages. |
