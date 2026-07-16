# codespace-canvas

A **canvas extension** for the [GitHub Copilot app](https://github.com/features/copilot) that embeds a GitHub Codespace directly in a Copilot side panel.

Open a picker of all your codespaces, or jump straight into a specific one — without leaving the Copilot app.

## Features

- **Picker mode** — lists your codespaces (name, repository, branch, state, last used) with an **Open** button for each, plus **New codespace** and **Refresh**.
- **Direct mode** — open a specific codespace editor by name (one-time github.com sign-in in the webview, then it persists), or load an explicit URL.
- **Sign-in-free editor (`editorServe`)** — set `editorServe: true` to get a **full VS Code editor with no github.com sign-in at all**. The extension runs `code serve-web` inside the codespace (authenticated by a per-open connection token in the URL, not a github.com cookie), exposes its port, and loads the tokenized URL. Opens in a **dark theme by default** (seeded once; your later theme change sticks). Requires the devcontainer `sshd` feature (see below).
- **Public port (auth-free)** — set `publicPort` to expose a codespace port with **public** visibility and load its real GitHub browse URL. Shareable and requires no sign-in. ⚠️ Anyone with the URL can reach it.
- **Private forward (auth-free)** — set `remotePort` to forward a codespace port to loopback (`127.0.0.1`) over the app's `gh` login. No sign-in, private to your machine.
- **Start the app for you (`startCommand`)** — combined with `publicPort`/`remotePort`, runs a command inside the codespace over `gh` to launch the app first, then previews it. **No web editor at all** — requires the devcontainer `sshd` feature (see below).
- **Agent actions** — the Copilot agent can call:
  - `list_codespaces` — returns your codespaces as JSON (optionally filtered by repo).
  - `get_current` — reports what the panel is currently showing (mode, url, ports, browseUrl).
  - `exec_in_codespace` — run any shell command inside a codespace over `gh` (auth-free); `background: true` to start a long-running server. Requires the `sshd` feature.
  - `make_port_private` — revert a `publicPort` exposure back to private.
  - `refresh` — reload the canvas; for the sign-in-free editor it repairs `serve-web` / the port forward if they died, or `hard: true` restarts `serve-web` with a fresh token. Re-open the canvas afterward to reload the panel.
  - `stop_forward` — stop a private `remotePort` forward for the instance.

## Running commands / starting the app (`sshd` feature)

`startCommand` and `exec_in_codespace` run commands via `gh codespace ssh`, which
needs an **SSH server in the container**. Add the feature to your repo's
`.devcontainer/devcontainer.json` and rebuild (or create) the codespace:

```jsonc
"features": {
  "ghcr.io/devcontainers/features/sshd:1": { "version": "latest" }
}
```

With that in place, the whole preview flow is **fully auth-free** — the extension
starts your app and exposes the port using only the app's `gh` login, and you
never open the web editor or hit a 2FA prompt. Without `sshd`, use `publicPort`/
`remotePort` on a port you started yourself (e.g. from the editor terminal).

## Auth model

There are two separate auth surfaces:

- **`gh` API calls** (listing codespaces, forwarding ports, changing visibility) use your `gh` CLI login. The `publicPort` and `remotePort` features run entirely over this, so **the app authenticates them for you — no sign-in appears in the webview.**
- **The hosted editor** (direct mode) is a github.com web app that needs a browser session cookie. That cookie can't be minted from an OAuth token, so the **editor asks you to sign in once** in the webview; it persists afterward.

If you want a **full editor with zero github.com sign-in**, use `editorServe: true` — it runs `code serve-web` inside the codespace and authenticates with a connection token in the URL instead of a github.com cookie. If you just want to preview a running app with **zero webview login**, use `publicPort` (shareable) or `remotePort` (private) instead of the editor.

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

- `remotePort` runs `gh codespace ports forward <remote>:<local>` to an
  ephemeral loopback port and loads `http://127.0.0.1:<local>` — private to
  your machine, no auth.
- `publicPort` first forwards the port (headless, a listening port isn't
  auto-detected the way the web editor does it), which registers it and lets the
  extension probe the app for readiness, then runs
  `gh codespace ports visibility <port>:public` and loads the real `browseUrl`
  from `gh codespace ports --json` (never guessed). Public ports serve without
  any auth.
- `startCommand` (optional) runs `gh codespace ssh -c <name> -- <command>`
  detached to launch the app before either preview. This needs the `sshd`
  feature; the port previews themselves do not.

The port previews rely on the Codespaces port-forwarding service. The app must be
**listening** on the port inside the codespace — either started by you, or by
`startCommand`.

## Prerequisites

- The GitHub Copilot app with canvas-extension support.
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
- "Run my dev server and preview it" → `startCommand` + `publicPort`/`remotePort` (auth-free, no editor; needs `sshd`).

The canvas id is `codespace-canvas`. Open input:

```jsonc
{
  "codespaceName": "octocat-myrepo-abc123", // open this codespace editor directly
  "repo": "owner/repo",                     // filter picker + target "New codespace"
  "url": "https://...",                     // load an explicit URL
  "publicPort": 3000,                       // expose port publicly + load its GitHub URL (auth-free, shareable)
  "remotePort": 3000,                       // forward port to 127.0.0.1 (auth-free, private)
  "startCommand": "npm run dev"             // start the app in the codespace first (needs sshd)
}
```

`publicPort` and `remotePort` require `codespaceName` and an app listening on
that port — either started by you or by `startCommand`.

## Development

The extension is a single ES module: [`codespace-canvas/extension.mjs`](codespace-canvas/extension.mjs).

```sh
node --check codespace-canvas/extension.mjs   # syntax check
```

After editing, reload extensions in Copilot (`extensions_reload`) to pick up changes.

## License

[MIT](LICENSE)
