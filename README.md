# Readmaxxin

Readmaxxin is a local-first reader and editor for technical material. Select an unfamiliar phrase or equation to get an explanation beside the document, explore a prerequisite, and return to where you were reading.

- Paste text or import TXT, Markdown, HTML, PDF, and DOCX into an editable workspace.
- Search across inline formatting, render math with KaTeX, and add temporary highlights.
- Stream explanations, ask follow-up questions, and use Back to return from prerequisite explanations.
- Restore the current document, edits, and reading position in the same browser.

## Run locally

Install Node.js 22.13 or newer, then run:

```sh
git clone https://github.com/riturajjain2000/Readmaxxin.git
cd Readmaxxin
npm ci
npm start
```

Open [Readmaxxin on your computer](http://127.0.0.1:4173). You can read, edit, and search before configuring AI.

## Connect a model

Open **AI settings**, choose Local or Cloud, and enter the endpoint and the exact model name. **Check connection** lists models when the provider supports discovery. Enter an API key if your provider requires one, then select **Save connection**.

| Connection | Protocol | Example endpoint |
| --- | --- | --- |
| Running Ollama instance | Ollama | `http://localhost:11434/api/chat` |
| Compatible local model server | OpenAI compatible | `http://localhost:1234/v1/chat/completions` |
| Compatible cloud provider | OpenAI compatible | Your provider's HTTPS chat completions endpoint |

Start your local inference service and load a model before connecting. Cloud inference uses a model available through your provider.

## Read and explore

1. Paste a passage or use **Open file** to import a document.
2. Select a term and choose **Explain**, or press **Cmd/Ctrl+Shift+E**.
3. Choose a prerequisite or ask a follow-up. Press **Escape** to close the panel and return to the reader.

Use **Cmd/Ctrl+F** to search the document and **Enter** or **Shift+Enter** to move between results. Press **F2** on a focused equation to edit its original notation.

## Data and import limits

The active workspace and connection profiles stay in browser storage. Keep using the same browser profile and address to restore them. Clearing site data removes the saved workspace. API keys entered in the UI last for the current page session.

An explanation sends the selection and its containing paragraph to the configured endpoint. Follow-ups can include the current explanation and your question. The **Summarize** document action sends the document text. Cloud inference sends that request data to your chosen provider.

File imports are limited to 15 MiB. PDF import extracts selectable text from up to 300 pages. Scan-only PDFs require OCR before import, and complex PDF columns or Word layouts may need manual cleanup.

## Development

Run `npm test` for the automated suite. The development guide covers the app structure, local configuration, and troubleshooting. [Development guide](docs/development.md)
