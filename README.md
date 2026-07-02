# codespace-canvas

A [GitHub Copilot CLI](https://github.com/github/copilot-cli) **canvas extension** that embeds a GitHub Codespace directly in a Copilot side panel.

Open a picker of all your codespaces, or jump straight into a specific one — without leaving the Copilot app.

## Features

- **Picker mode** — lists your codespaces (name, repository, branch, state, last used) with an **Open** button for each, plus **New codespace** and **Refresh**.
- **Direct mode** — open a specific codespace by name, or load an explicit URL (e.g. a forwarded port).
- **Agent actions** — the Copilot agent can call:
  - `list_codespaces` — returns your codespaces as JSON (optionally filtered by repo).
  - `get_current` — reports what the panel is currently showing.

## How it works

GitHub's web editor (`vscode.dev` / `github.com/codespaces`) is served with
`Content-Security-Policy: frame-ancestors 'none'`, which means a codespace
**cannot** be embedded in an `<iframe>`.

This extension works around that by loading the codespace as the **top-level
document** of the canvas webview instead of framing it. `frame-ancestors`
only restricts framing — not top-level navigation — so:

- **Direct mode** returns the codespace URL as the canvas URL.
- **Picker mode** serves a small local HTML page (on an ephemeral `127.0.0.1`
  port) whose links perform a top-level `window.location` navigation to the
  chosen codespace.

Named codespaces open via `https://github.com/codespaces/<name>`, which handles
auth and redirects to the correct editor host.

## Prerequisites

- GitHub Copilot CLI / GitHub app with canvas-extension support.
- The [`gh` CLI](https://cli.github.com/) installed and authenticated.
- For the **picker's list feature**, the `gh` token needs the `codespace` scope:

  ```sh
  gh auth refresh -h github.com -s codespace
  ```

  Direct-open by codespace name or URL works without this scope.

## Install

Ask Copilot to install it from this repository folder:

```
Install the extension from https://github.com/arilivigni/codespace-canvas/tree/main/codespace-canvas
```

Or use the `install_extension` tool directly with that URL.

### Install scopes

| Scope | Effect |
|-------|--------|
| `user` (default) | Available in **all** your projects |
| `project` | Installed into the current repo's `.github/extensions/` |
| `session` | Scoped to a single session only |

## Usage

Once installed, ask Copilot to open the canvas, e.g.:

- "Open the codespaces canvas" → shows the picker.
- "Open codespace `octocat-myrepo-abc123`" → opens that codespace directly.

The canvas id is `codespace-canvas`. Open input:

```jsonc
{
  "codespaceName": "octocat-myrepo-abc123", // optional: open this codespace directly
  "repo": "owner/repo",                     // optional: filter picker + target "New codespace"
  "url": "https://..."                      // optional: load an explicit URL
}
```

## Development

The extension is a single ES module: [`codespace-canvas/extension.mjs`](codespace-canvas/extension.mjs).

```sh
node --check codespace-canvas/extension.mjs   # syntax check
```

After editing, reload extensions in Copilot (`extensions_reload`) to pick up changes.

## License

[MIT](LICENSE)
