# codespace-canvas

A [GitHub Copilot CLI](https://github.com/github/copilot-cli) **canvas extension** that embeds a GitHub Codespace directly in a Copilot side panel.

Open a picker of all your codespaces, or jump straight into a specific one — without leaving the Copilot app.

## Features

- **Picker mode** — lists your codespaces (name, repository, branch, state, last used) with an **Open** button for each, plus **New codespace** and **Refresh**.
- **Direct mode** — open a specific codespace editor by name (one-time github.com sign-in in the webview, then it persists), or load an explicit URL.
- **Public port (auth-free)** — set `publicPort` to flip a codespace port to **public** visibility and load its real GitHub browse URL. Shareable and requires no sign-in. ⚠️ Anyone with the URL can reach it.
- **Private forward (auth-free)** — set `remotePort` to forward a codespace port to loopback (`127.0.0.1`) over the app's `gh` login. No sign-in, private to your machine.
- **Agent actions** — the Copilot agent can call:
  - `list_codespaces` — returns your codespaces as JSON (optionally filtered by repo).
  - `get_current` — reports what the panel is currently showing (mode, url, ports, browseUrl).
  - `make_port_private` — revert a `publicPort` exposure back to private.
  - `stop_forward` — stop a private `remotePort` forward for the instance.

## Auth model

There are two separate auth surfaces:

- **`gh` API calls** (listing codespaces, forwarding ports, changing visibility) use your `gh` CLI login. The `publicPort` and `remotePort` features run entirely over this, so **the app authenticates them for you — no sign-in appears in the webview.**
- **The hosted editor** (direct mode) is a github.com web app that needs a browser session cookie. That cookie can't be minted from an OAuth token, so the **editor asks you to sign in once** in the webview; it persists afterward.

If you want to preview an app running inside a codespace with **zero webview login**, use `publicPort` (shareable) or `remotePort` (private) instead of the editor.

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

**Port previews** don't need the editor's cookie at all:

- `publicPort` runs `gh codespace ports visibility <port>:public`, then reads
  the real `browseUrl` from `gh codespace ports --json` (never guessed) and
  loads it. Public ports serve without any auth.
- `remotePort` runs `gh codespace ports forward <local>:<remote>` to an
  ephemeral loopback port and loads `http://127.0.0.1:<local>` — private to
  your machine, no auth.

Both rely only on the Codespaces port-forwarding service (no in-container
`sshd` required). The app must already be **listening** on the port inside the
codespace.

## Prerequisites

- GitHub Copilot CLI / GitHub app with canvas-extension support.
- The [`gh` CLI](https://cli.github.com/) installed and authenticated.
- For **listing codespaces** and the **auth-free port previews** (`publicPort` /
  `remotePort`), the `gh` token needs the `codespace` scope:

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
- "Open codespace `octocat-myrepo-abc123`" → opens that codespace editor directly.
- "Preview port 3000 of my codespace publicly" → `publicPort` (auth-free, shareable).
- "Forward port 3000 of my codespace privately" → `remotePort` (auth-free, local only).

The canvas id is `codespace-canvas`. Open input:

```jsonc
{
  "codespaceName": "octocat-myrepo-abc123", // open this codespace editor directly
  "repo": "owner/repo",                     // filter picker + target "New codespace"
  "url": "https://...",                     // load an explicit URL
  "publicPort": 3000,                       // set port public + load its GitHub URL (auth-free, shareable)
  "remotePort": 3000                        // forward port to 127.0.0.1 (auth-free, private)
}
```

`publicPort` and `remotePort` require `codespaceName` and an app already
listening on that port inside the codespace.

## Development

The extension is a single ES module: [`codespace-canvas/extension.mjs`](codespace-canvas/extension.mjs).

```sh
node --check codespace-canvas/extension.mjs   # syntax check
```

After editing, reload extensions in Copilot (`extensions_reload`) to pick up changes.

## License

[MIT](LICENSE)
