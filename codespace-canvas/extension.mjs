// Extension: codespace-canvas
// Embed a GitHub Codespace in a canvas panel.
//
// GitHub's web editor (vscode.dev / github.com/codespaces) sends
// `Content-Security-Policy: frame-ancestors 'none'`, so a codespace CANNOT be
// wrapped in an <iframe>. It CAN, however, be loaded as the *top-level*
// document of the canvas webview (frame-ancestors only restricts framing, not
// navigation). So this extension either:
//   • returns the codespace URL directly as the canvas URL, or
//   • serves a small local "picker" page whose links do a top-level
//     navigation (window.location) to the chosen codespace.
//
// Named codespaces open via https://github.com/codespaces/<name>, which
// handles auth and redirects to the correct editor host.

import { createServer, get as httpGet } from "node:http";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { joinSession, createCanvas } from "@github/copilot-sdk/extension";

const CANVAS_ID = "codespace-canvas";

// Codespace-side port used to host the self-served VS Code editor (editorServe).
const CS_EDITOR_PORT = 8200;

// Per-instance state. Shapes by mode:
//   picker:  { server, url, title, mode, repo }
//   direct:  { url, title, mode, repo }
//   forward: { url, title, mode, repo, codespaceName, remotePort, localPort, forwardProc }
//   public:  { url, title, mode, repo, codespaceName, remotePort, localPort, browseUrl, forwardProc }
//   editor:  { url, title, mode, repo, codespaceName, remotePort, localPort, browseUrl, forwardProc }
const instances = new Map();

let sessionRef = null;
function log(message, options) {
    if (sessionRef) sessionRef.log(message, options).catch(() => {});
}

// ---------------------------------------------------------------------------
// gh helpers
// ---------------------------------------------------------------------------

// The Copilot app injects a GH_TOKEN whose scopes it controls (no `codespace`
// scope). Codespace operations need that scope, which lives on the user's
// `gh` keyring login instead. Strip the injected token/host env so the `gh`
// CLI authenticates from its own stored credentials.
function ghEnv() {
    const env = { ...process.env };
    delete env.GH_TOKEN;
    delete env.GITHUB_TOKEN;
    delete env.GH_HOST;
    delete env.GH_ENTERPRISE_TOKEN;
    return env;
}

function gh(args) {
    return new Promise((resolve) => {
        execFile(
            "gh",
            args,
            { maxBuffer: 10 * 1024 * 1024, env: ghEnv() },
            (error, stdout, stderr) => {
                resolve({
                    ok: !error,
                    code: error?.code ?? 0,
                    stdout: (stdout || "").toString(),
                    stderr: (stderr || "").toString(),
                });
            },
        );
    });
}

async function listCodespaces(repo) {
    const fields = "name,displayName,repository,state,gitStatus,lastUsedAt,machineName";
    const args = ["codespace", "list", "--json", fields, "--limit", "50"];
    if (repo) args.push("--repo", repo);
    const res = await gh(args);
    if (!res.ok) {
        const needsScope = /codespace.*scope|Must have admin rights|HTTP 403/i.test(
            res.stderr,
        );
        return {
            ok: false,
            needsScope,
            error: res.stderr.trim() || `gh exited with code ${res.code}`,
        };
    }
    let data = [];
    try {
        data = JSON.parse(res.stdout || "[]");
    } catch {
        data = [];
    }
    return { ok: true, codespaces: data };
}

// Single-quote a string for a POSIX shell.
function shQuote(s) {
    return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// Run a command inside a codespace over the app's `gh` login — auth-free, no
// web editor. Requires an SSH server in the container (devcontainer `sshd`
// feature). With background:true the command is detached (nohup + disown) so a
// dev server keeps running after the ssh session closes.
function runInCodespace(codespaceName, command, { background = false, timeoutMs = 90000 } = {}) {
    const remote = background
        ? `nohup bash -lc ${shQuote(command)} >/tmp/codespace-canvas.log 2>&1 & disown; echo started`
        : command;
    return new Promise((resolve) => {
        execFile(
            "gh",
            ["codespace", "ssh", "-c", codespaceName, "--", remote],
            { maxBuffer: 10 * 1024 * 1024, env: ghEnv(), timeout: timeoutMs },
            (error, stdout, stderr) => {
                const err = (stderr || "").toString();
                const noSshd =
                    /SSH server is installed in the container|failed to start SSH server/i.test(
                        err,
                    );
                resolve({
                    ok: !error,
                    noSshd,
                    stdout: (stdout || "").toString(),
                    stderr: err,
                });
            },
        );
    });
}

const NO_SSHD_MESSAGE =
    "This codespace has no SSH server, so commands can't be run over gh. Add " +
    '`ghcr.io/devcontainers/features/sshd:1` to the repo\'s ' +
    ".devcontainer/devcontainer.json `features`, rebuild the codespace, then " +
    "retry. (Or start the app manually via the editor.)";

// ---------------------------------------------------------------------------
// URL builders
// ---------------------------------------------------------------------------

function editorUrlForName(name) {
    return `https://github.com/codespaces/${encodeURIComponent(name)}`;
}

function createUrlForRepo(repo) {
    return repo
        ? `https://github.com/codespaces/new?repo=${encodeURIComponent(repo)}`
        : "https://github.com/codespaces/new";
}

// ---------------------------------------------------------------------------
// Auth-free app preview
//
// Reuses the app's `gh` login (needs the one-time `codespace` scope:
// `gh auth refresh -h github.com -s codespace`) to surface an app running
// inside a codespace, with NO github.com login in the webview. Two flavours:
//   • remotePort → forward the port to loopback and load http://127.0.0.1:…
//                  Stays PRIVATE to this machine. Needs a long-lived `gh`
//                  forward process.
//   • publicPort → set the codespace port's visibility to `public`, then load
//                  its real GitHub browse URL (read from `gh`, never guessed).
//                  Shareable and process-free, but PUBLIC to anyone with the
//                  URL.
// The editor itself is opened via the browser (direct mode) — GitHub's hosted
// editor always requires a one-time github.com sign-in that then persists.
// ---------------------------------------------------------------------------

function getFreePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.on("error", reject);
        srv.listen(0, "127.0.0.1", () => {
            const port = srv.address().port;
            srv.close(() => resolve(port));
        });
    });
}

function probeHttp(port) {
    return new Promise((resolve) => {
        const req = httpGet(
            { host: "127.0.0.1", port, path: "/", timeout: 1500 },
            (res) => {
                res.resume();
                resolve(true);
            },
        );
        req.on("timeout", () => {
            req.destroy();
            resolve(false);
        });
        req.on("error", () => resolve(false));
    });
}

// Spawn a long-lived `gh codespace ports forward` process. Returns the child.
// gh's argument order is <remote-port>:<local-port> (remote = codespace port).
function startForward(codespaceName, remotePort, localPort) {
    return spawn(
        "gh",
        [
            "codespace",
            "ports",
            "forward",
            `${remotePort}:${localPort}`,
            "-c",
            codespaceName,
        ],
        { env: ghEnv(), stdio: "ignore" },
    );
}

// PRIVATE, auth-free: forward a codespace port to loopback.
async function openLocalForward(instanceId, codespaceName, remotePort, repo) {
    if (!Number.isInteger(remotePort)) {
        throw new Error("remotePort must be an integer");
    }
    await cleanupTunnel(instanceId);

    const localPort = await getFreePort();
    log(
        `Forwarding ${codespaceName}:${remotePort} → 127.0.0.1:${localPort}…`,
        { ephemeral: true },
    );
    const forwardProc = startForward(codespaceName, remotePort, localPort);

    let forwardExited = false;
    forwardProc.on("exit", () => {
        forwardExited = true;
    });

    const deadline = Date.now() + 20000;
    let ready = false;
    while (Date.now() < deadline) {
        if (forwardExited) break;
        if (await probeHttp(localPort)) {
            ready = true;
            break;
        }
        await new Promise((r) => setTimeout(r, 750));
    }

    if (!ready) {
        try {
            forwardProc.kill();
        } catch {}
        if (forwardExited) {
            throw new Error(
                "`gh codespace ports forward` exited immediately. Make sure the token gh uses has the `codespace` scope (`gh auth refresh -h github.com -s codespace`) and that the codespace is running.",
            );
        }
        throw new Error(
            `Timed out forwarding port ${remotePort}. Is an app listening on that port in the codespace?`,
        );
    }

    const url = `http://127.0.0.1:${localPort}/`;
    const title = `${codespaceName} :${remotePort} (private)`;
    instances.set(instanceId, {
        url,
        title,
        mode: "forward",
        repo: repo || "",
        codespaceName,
        remotePort,
        localPort,
        forwardProc,
    });
    return { url, title, status: `Port ${remotePort} · private forward` };
}

// Read a forwarded port's real browse URL from gh (never guess the format).
async function browseUrlFor(codespaceName, port) {
    const res = await gh([
        "codespace",
        "ports",
        "-c",
        codespaceName,
        "--json",
        "sourcePort,browseUrl,visibility",
    ]);
    if (!res.ok) return null;
    try {
        const ports = JSON.parse(res.stdout || "[]");
        const match = ports.find((p) => Number(p.sourcePort) === Number(port));
        return match || null;
    } catch {
        return null;
    }
}

// PUBLIC, auth-free: expose a codespace port and load its GitHub URL.
//
// Headless (no web editor), a listening port is NOT auto-forwarded, so we must
// register it ourselves by forwarding <port>:<localPort> — that both registers
// the port with the tunnel service and lets us probe the app for readiness.
// Once the port is public the tunnel serves it independently, but we keep the
// forward process alive for the instance (cleaned up on close / mode switch).
async function openPublicPort(instanceId, codespaceName, publicPort, repo) {
    if (!Number.isInteger(publicPort)) {
        throw new Error("publicPort must be an integer");
    }
    await cleanupTunnel(instanceId);

    const localPort = await getFreePort();
    log(`Exposing ${codespaceName}:${publicPort}…`, { ephemeral: true });
    const forwardProc = startForward(codespaceName, publicPort, localPort);
    let forwardExited = false;
    forwardProc.on("exit", () => {
        forwardExited = true;
    });

    // Wait for the forward to register AND the app to respond.
    const deadline = Date.now() + 25000;
    let ready = false;
    while (Date.now() < deadline) {
        if (forwardExited) break;
        if (await probeHttp(localPort)) {
            ready = true;
            break;
        }
        await new Promise((r) => setTimeout(r, 750));
    }
    if (!ready) {
        try {
            forwardProc.kill();
        } catch {}
        if (forwardExited) {
            throw new Error(
                "`gh codespace ports forward` exited immediately. Make sure the token gh uses has the `codespace` scope (`gh auth refresh -h github.com -s codespace`) and that the codespace is running.",
            );
        }
        throw new Error(
            `Timed out preparing port ${publicPort}. Is an app listening on that port in the codespace?`,
        );
    }

    log(`Making ${codespaceName}:${publicPort} public…`, { ephemeral: true });
    const vis = await gh([
        "codespace",
        "ports",
        "visibility",
        `${publicPort}:public`,
        "-c",
        codespaceName,
    ]);
    if (!vis.ok) {
        try {
            forwardProc.kill();
        } catch {}
        throw new Error(
            `Could not make port ${publicPort} public. Your org may forbid public ports. gh said: ${vis.stderr.trim()}`,
        );
    }

    // Read the real browse URL (may lag a moment behind the visibility change).
    let info = await browseUrlFor(codespaceName, publicPort);
    if (!info?.browseUrl) {
        await new Promise((r) => setTimeout(r, 1500));
        info = await browseUrlFor(codespaceName, publicPort);
    }
    const url = info?.browseUrl;
    if (!url) {
        try {
            forwardProc.kill();
        } catch {}
        throw new Error(
            `Port ${publicPort} was set public but gh returned no browse URL for it yet. Retry in a moment.`,
        );
    }

    const title = `${codespaceName} :${publicPort} (public)`;
    instances.set(instanceId, {
        url,
        title,
        mode: "public",
        repo: repo || "",
        codespaceName,
        remotePort: publicPort,
        localPort,
        browseUrl: url,
        forwardProc,
    });
    return { url, title, status: `Port ${publicPort} · PUBLIC` };
}

// Remote script that ensures the standalone VS Code CLI is present, then execs
// `code serve-web` bound to loopback with a connection token. Run via
// runInCodespace(background:true) so the whole thing is nohup-detached and the
// exec'd server survives the ssh session. The editor's auth is that token (in
// the URL) — NOT a github.com login — so it opens sign-in free. serve-web
// downloads its web assets on first connection, so the first load can take a
// little longer.
function serveWebScript(port, token) {
    return [
        "mkdir -p /tmp/vscode-cli && cd /tmp/vscode-cli",
        "if [ ! -x ./code ]; then " +
            'curl -sLk "https://code.visualstudio.com/sha/download?build=stable&os=cli-alpine-x64" -o cli.tgz && ' +
            "tar -xzf cli.tgz; fi",
        `exec ./code serve-web --port ${port} --host 127.0.0.1 ` +
            `--connection-token ${token} --accept-server-license-terms ` +
            "--server-data-dir /tmp/serve-web-data",
    ].join("\n");
}

// Sign-in-free editor: run `code serve-web` inside the codespace (auth = a
// connection token, no github.com login), then expose its port publicly and
// load the tokenized URL. Requires the devcontainer `sshd` feature.
async function openEditorServe(instanceId, codespaceName, repo) {
    await cleanupTunnel(instanceId);

    const token = randomUUID().replace(/-/g, "");
    log(`Starting sign-in-free editor in ${codespaceName}…`, { ephemeral: true });

    // Stop any editor server we started before (fresh token each open).
    const kill = await runInCodespace(
        codespaceName,
        `pkill -f "serve-web --port ${CS_EDITOR_PORT}" 2>/dev/null; sleep 1; true`,
        { background: false, timeoutMs: 60000 },
    );
    if (!kill.ok && kill.noSshd) throw new Error(NO_SSHD_MESSAGE);

    // Launch serve-web detached (downloads the CLI on first use).
    const run = await runInCodespace(
        codespaceName,
        serveWebScript(CS_EDITOR_PORT, token),
        { background: true, timeoutMs: 60000 },
    );
    if (!run.ok && run.noSshd) throw new Error(NO_SSHD_MESSAGE);
    if (!run.ok) {
        throw new Error(
            `Could not start the editor server in ${codespaceName}: ${
                run.stderr.trim() || "gh codespace ssh failed"
            }`,
        );
    }

    const localPort = await getFreePort();
    const forwardProc = startForward(codespaceName, CS_EDITOR_PORT, localPort);
    let forwardExited = false;
    forwardProc.on("exit", () => {
        forwardExited = true;
    });

    // serve-web downloads assets on first hit — allow generous readiness time.
    const deadline = Date.now() + 90000;
    let ready = false;
    while (Date.now() < deadline) {
        if (forwardExited) break;
        if (await probeHttp(localPort)) {
            ready = true;
            break;
        }
        await new Promise((r) => setTimeout(r, 1000));
    }
    if (!ready) {
        try {
            forwardProc.kill();
        } catch {}
        throw new Error(
            forwardExited
                ? "`gh codespace ports forward` exited immediately. Ensure gh has the `codespace` scope and the codespace is running."
                : "Timed out waiting for the editor server to come up. Check /tmp/codespace-canvas.log in the codespace.",
        );
    }

    log("Publishing editor port…", { ephemeral: true });
    const vis = await gh([
        "codespace",
        "ports",
        "visibility",
        `${CS_EDITOR_PORT}:public`,
        "-c",
        codespaceName,
    ]);
    if (!vis.ok) {
        try {
            forwardProc.kill();
        } catch {}
        throw new Error(
            `Could not expose the editor port. Your org may forbid public ports. gh said: ${vis.stderr.trim()}`,
        );
    }

    let info = await browseUrlFor(codespaceName, CS_EDITOR_PORT);
    if (!info?.browseUrl) {
        await new Promise((r) => setTimeout(r, 1500));
        info = await browseUrlFor(codespaceName, CS_EDITOR_PORT);
    }
    if (!info?.browseUrl) {
        try {
            forwardProc.kill();
        } catch {}
        throw new Error(
            "Editor port was exposed but gh returned no browse URL yet. Retry in a moment.",
        );
    }

    const url = `${info.browseUrl}/?tkn=${token}`;
    const title = `${codespaceName} · editor`;
    instances.set(instanceId, {
        url,
        title,
        mode: "editor",
        repo: repo || "",
        codespaceName,
        remotePort: CS_EDITOR_PORT,
        localPort,
        browseUrl: info.browseUrl,
        forwardProc,
    });
    return { url, title, status: "Editor (sign-in free)" };
}

async function cleanupTunnel(instanceId) {
    const state = instances.get(instanceId);
    if (!state) return;
    const proc = state.forwardProc;
    if (proc && !proc.killed) {
        try {
            proc.kill();
        } catch {}
    }
    state.forwardProc = undefined;
}

// ---------------------------------------------------------------------------
// Picker page
// ---------------------------------------------------------------------------

function escapeHtml(s) {
    return String(s == null ? "" : s).replace(
        /[&<>"]/g,
        (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
    );
}

function pickerHtml(repo) {
    const repoLabel = repo ? escapeHtml(repo) : "all repositories";
    const createUrl = createUrlForRepo(repo);
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Codespaces</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    background: #0d1117; color: #e6edf3;
  }
  @media (prefers-color-scheme: light) { body { background: #ffffff; color: #1f2328; } }
  header {
    display: flex; align-items: center; gap: 10px; justify-content: space-between;
    padding: 16px 20px; border-bottom: 1px solid #30363d55; position: sticky; top: 0;
    background: inherit;
  }
  h1 { font-size: 15px; margin: 0; font-weight: 600; }
  .sub { opacity: .65; font-size: 12px; }
  main { padding: 12px 20px 24px; max-width: 900px; margin: 0 auto; }
  .btn {
    display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
    border: 1px solid #30363d; background: #21262d; color: #e6edf3;
    padding: 6px 12px; border-radius: 6px; font-size: 13px; text-decoration: none;
  }
  .btn:hover { border-color: #8b949e; }
  .btn.primary { background: #238636; border-color: #238636; color: #fff; }
  .btn.primary:hover { background: #2ea043; }
  ul { list-style: none; margin: 12px 0 0; padding: 0; }
  li {
    display: flex; align-items: center; justify-content: space-between; gap: 16px;
    padding: 12px 14px; border: 1px solid #30363d55; border-radius: 8px; margin-bottom: 10px;
  }
  li:hover { border-color: #8b949e88; }
  .meta { min-width: 0; }
  .name { font-weight: 600; }
  .repo { opacity: .8; }
  .tags { display: flex; gap: 8px; margin-top: 4px; font-size: 12px; opacity: .7; }
  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 5px; vertical-align: middle; }
  .Available, .Running { background: #3fb950; }
  .Shutdown, .Unknown { background: #8b949e; }
  .Starting, .Provisioning, .Queued, .Awaiting { background: #d29922; }
  .empty, .error { padding: 24px; text-align: center; opacity: .75; }
  .error { color: #f85149; white-space: pre-wrap; text-align: left; }
  code { background: #6e768166; padding: 1px 5px; border-radius: 4px; }
  .spinner { opacity: .6; }
</style>
</head>
<body>
<header>
  <div>
    <h1>GitHub Codespaces</h1>
    <div class="sub">Showing ${repoLabel}</div>
  </div>
  <div style="display:flex; gap:8px;">
    <button class="btn" id="refresh">Refresh</button>
    <a class="btn primary" href="${createUrl}" onclick="return nav(this.href)">New codespace</a>
  </div>
</header>
<main>
  <div id="list" class="spinner">Loading codespaces…</div>
</main>
<script>
  // Top-level navigation so the codespace loads as the webview's top document
  // (avoids frame-ancestors 'none' iframe restrictions).
  function nav(url) { window.location.href = url; return false; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]; }); }

  async function load() {
    var el = document.getElementById("list");
    el.className = "spinner"; el.textContent = "Loading codespaces…";
    try {
      var r = await fetch("/api/codespaces");
      var data = await r.json();
      if (!data.ok) {
        el.className = "error";
        if (data.needsScope) {
          el.innerHTML = "The GitHub CLI token is missing the <code>codespace</code> scope.\\n\\nRun this in a terminal, then click Refresh:\\n\\n<code>gh auth refresh -h github.com -s codespace</code>";
        } else {
          el.textContent = "Could not list codespaces:\\n\\n" + (data.error || "unknown error");
        }
        return;
      }
      var items = data.codespaces || [];
      if (!items.length) {
        el.className = "empty";
        el.innerHTML = "No codespaces found. Use <b>New codespace</b> above to create one.";
        return;
      }
      el.className = "";
      el.innerHTML = "<ul>" + items.map(function(c) {
        var url = "https://github.com/codespaces/" + encodeURIComponent(c.name);
        var repo = c.repository || "";
        var state = c.state || "Unknown";
        var branch = (c.gitStatus && c.gitStatus.ref) ? c.gitStatus.ref : "";
        var last = c.lastUsedAt ? new Date(c.lastUsedAt).toLocaleString() : "";
        return "<li><div class='meta'>"
          + "<div class='name'>" + esc(c.displayName || c.name) + "</div>"
          + "<div class='repo'>" + esc(repo) + (branch ? " &middot; " + esc(branch) : "") + "</div>"
          + "<div class='tags'><span><span class='dot " + esc(state) + "'></span>" + esc(state) + "</span>"
          + (last ? "<span>last used " + esc(last) + "</span>" : "")
          + "</div></div>"
          + "<a class='btn primary' href='" + url + "' onclick='return nav(this.href)'>Open</a>"
          + "</li>";
      }).join("") + "</ul>";
    } catch (e) {
      el.className = "error";
      el.textContent = "Failed to load: " + (e && e.message ? e.message : e);
    }
  }
  document.getElementById("refresh").addEventListener("click", load);
  load();
</script>
</body>
</html>`;
}

async function startPickerServer(instanceId, repo) {
    const server = createServer(async (req, res) => {
        try {
            const url = new URL(req.url, "http://127.0.0.1");
            if (url.pathname === "/api/codespaces") {
                const result = await listCodespaces(repo);
                res.setHeader("Content-Type", "application/json; charset=utf-8");
                res.end(JSON.stringify(result));
                return;
            }
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.end(pickerHtml(repo));
        } catch (e) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
        }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { server, url: `http://127.0.0.1:${port}/` };
}

async function closeServer(instanceId) {
    const state = instances.get(instanceId);
    if (state?.server) {
        await new Promise((resolve) => state.server.close(() => resolve()));
        state.server = undefined;
    }
}

// ---------------------------------------------------------------------------
// Canvas
// ---------------------------------------------------------------------------

const session = await joinSession({
    canvases: [
        createCanvas({
            id: CANVAS_ID,
            displayName: "GitHub Codespace",
            description:
                "Open a GitHub Codespace in a side panel. Show a picker, open a codespace's hosted editor (browser), or preview an app running inside a codespace auth-free via the app's gh login: publicPort sets a port public and loads its GitHub URL (shareable), or remotePort forwards a port to loopback (private to this machine). With startCommand (needs the devcontainer sshd feature) it can also start the app for you first — no editor sign-in. With editorServe (needs sshd) it opens a full VS Code editor with NO github.com sign-in via a token-authed code serve-web.",
            inputSchema: {
                type: "object",
                properties: {
                    codespaceName: {
                        type: "string",
                        description:
                            "Exact codespace name (e.g. 'octocat-myrepo-abc123'). Opens that codespace's editor directly (browser; one-time github.com sign-in).",
                    },
                    repo: {
                        type: "string",
                        description:
                            "Repository in 'owner/repo' form. Filters the picker to this repo and targets 'New codespace'.",
                    },
                    url: {
                        type: "string",
                        description:
                            "Explicit URL to load (advanced escape hatch, e.g. a forwarded port URL).",
                    },
                    publicPort: {
                        type: "integer",
                        description:
                            "Requires codespaceName. Set this codespace port's visibility to public and load its real GitHub browse URL — auth-free and shareable. WARNING: anyone with the URL can reach it. The app must already be listening on the port.",
                    },
                    remotePort: {
                        type: "integer",
                        description:
                            "Requires codespaceName. Forward this codespace port to loopback and load http://127.0.0.1 — auth-free and PRIVATE to this machine. The app must already be listening on the port.",
                    },
                    startCommand: {
                        type: "string",
                        description:
                            "Requires codespaceName and publicPort or remotePort. Command to start the app inside the codespace over the app's gh login (auth-free, no editor) before previewing — e.g. 'python3 -m http.server 8000'. Runs detached. Requires the devcontainer `sshd` feature.",
                    },
                    editorServe: {
                        type: "boolean",
                        description:
                            "Requires codespaceName. Open a full VS Code editor with NO github.com sign-in: runs `code serve-web` inside the codespace (auth is a connection token in the URL) and exposes it. Requires the devcontainer `sshd` feature.",
                    },
                },
            },
            actions: [
                {
                    name: "list_codespaces",
                    description:
                        "Return the caller's GitHub Codespaces as JSON (name, repository, state, branch, last used). Optionally filter by repo.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            repo: {
                                type: "string",
                                description: "Filter by 'owner/repo'.",
                            },
                        },
                    },
                    handler: async (ctx) => {
                        const repo = ctx.input?.repo;
                        return await listCodespaces(repo);
                    },
                },
                {
                    name: "get_current",
                    description:
                        "Report what this codespace canvas instance is currently showing (mode and target URL).",
                    handler: async (ctx) => {
                        const state = instances.get(ctx.instanceId);
                        if (!state) return { open: false };
                        return {
                            open: true,
                            mode: state.mode,
                            url: state.url,
                            title: state.title,
                            repo: state.repo ?? null,
                            codespaceName: state.codespaceName ?? null,
                            localPort: state.localPort ?? null,
                            remotePort: state.remotePort ?? null,
                            browseUrl: state.browseUrl ?? null,
                        };
                    },
                },
                {
                    name: "exec_in_codespace",
                    description:
                        "Run a shell command inside a codespace over the app's gh login (auth-free, no web editor). Requires the devcontainer `sshd` feature. Set background:true to start a long-running server that keeps running after the command returns.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            codespaceName: {
                                type: "string",
                                description:
                                    "Codespace name. Defaults to the one this canvas is showing.",
                            },
                            command: {
                                type: "string",
                                description:
                                    "Shell command to run inside the codespace.",
                            },
                            background: {
                                type: "boolean",
                                description:
                                    "Run detached (nohup) so a dev server keeps running. Default false.",
                            },
                        },
                        required: ["command"],
                    },
                    handler: async (ctx) => {
                        const state = instances.get(ctx.instanceId);
                        const codespaceName =
                            ctx.input?.codespaceName || state?.codespaceName;
                        const command = ctx.input?.command;
                        if (!codespaceName || !command) {
                            return {
                                ok: false,
                                error: "codespaceName and command are required",
                            };
                        }
                        const res = await runInCodespace(codespaceName, command, {
                            background: ctx.input?.background === true,
                        });
                        if (!res.ok && res.noSshd) {
                            return { ok: false, error: NO_SSHD_MESSAGE };
                        }
                        return {
                            ok: res.ok,
                            stdout: res.stdout.trim(),
                            stderr: res.stderr.trim(),
                        };
                    },
                },
                {
                    name: "make_port_private",
                    description:
                        "Revert a codespace port's visibility back to private. Use to undo a publicPort exposure.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            codespaceName: {
                                type: "string",
                                description: "Codespace name. Defaults to the one this canvas is showing.",
                            },
                            port: {
                                type: "integer",
                                description: "Port to set private. Defaults to this canvas's current port.",
                            },
                        },
                    },
                    handler: async (ctx) => {
                        const state = instances.get(ctx.instanceId);
                        const codespaceName =
                            ctx.input?.codespaceName || state?.codespaceName;
                        const port = ctx.input?.port ?? state?.remotePort;
                        if (!codespaceName || port == null) {
                            return { ok: false, error: "codespaceName and port are required" };
                        }
                        const res = await gh([
                            "codespace",
                            "ports",
                            "visibility",
                            `${port}:private`,
                            "-c",
                            codespaceName,
                        ]);
                        return res.ok
                            ? { ok: true, codespaceName, port, visibility: "private" }
                            : { ok: false, error: res.stderr.trim() };
                    },
                },
                {
                    name: "stop_forward",
                    description:
                        "Stop the port-forward for this canvas instance (kills the gh forward process). Applies to forward, public, and editor modes. No-op otherwise.",
                    handler: async (ctx) => {
                        const state = instances.get(ctx.instanceId);
                        if (!state || !state.forwardProc) {
                            return { stopped: false, reason: "no active forward" };
                        }
                        await cleanupTunnel(ctx.instanceId);
                        return { stopped: true, codespaceName: state.codespaceName };
                    },
                },
            ],
            open: async (ctx) => {
                const input = ctx.input || {};
                const codespaceName =
                    typeof input.codespaceName === "string" ? input.codespaceName.trim() : "";
                const repo = typeof input.repo === "string" ? input.repo.trim() : "";
                const explicitUrl = typeof input.url === "string" ? input.url.trim() : "";
                const hasPublicPort =
                    input.publicPort != null && input.publicPort !== "";
                const hasRemotePort =
                    input.remotePort != null && input.remotePort !== "";
                const startCommand =
                    typeof input.startCommand === "string" ? input.startCommand.trim() : "";
                const editorServe = input.editorServe === true;

                const existing = instances.get(ctx.instanceId);

                // Sign-in-free editor (code serve-web over the app's gh login).
                if (codespaceName && editorServe) {
                    if (existing?.server) await closeServer(ctx.instanceId);
                    return await openEditorServe(ctx.instanceId, codespaceName, repo);
                }

                // Auth-free app preview (via the app's gh login).
                if (codespaceName && (hasPublicPort || hasRemotePort)) {
                    if (existing?.server) await closeServer(ctx.instanceId);

                    // Optionally start the app in the codespace first (no editor).
                    if (startCommand) {
                        log(
                            `Starting in ${codespaceName}: ${startCommand}`,
                            { ephemeral: true },
                        );
                        const run = await runInCodespace(codespaceName, startCommand, {
                            background: true,
                        });
                        if (!run.ok && run.noSshd) {
                            throw new Error(NO_SSHD_MESSAGE);
                        }
                        if (!run.ok) {
                            throw new Error(
                                `Failed to start the app in ${codespaceName}: ${
                                    run.stderr.trim() || "gh codespace ssh failed"
                                }`,
                            );
                        }
                        // Give the server a moment to bind before we forward/probe.
                        await new Promise((r) => setTimeout(r, 2000));
                    }

                    if (hasPublicPort) {
                        return await openPublicPort(
                            ctx.instanceId,
                            codespaceName,
                            Number(input.publicPort),
                            repo,
                        );
                    }
                    return await openLocalForward(
                        ctx.instanceId,
                        codespaceName,
                        Number(input.remotePort),
                        repo,
                    );
                }

                // Direct URL (explicit or named codespace editor) — browser mode.
                if (explicitUrl || codespaceName) {
                    const url = explicitUrl || editorUrlForName(codespaceName);
                    const title = codespaceName || "Codespace";
                    if (existing?.server) await closeServer(ctx.instanceId);
                    await cleanupTunnel(ctx.instanceId);
                    instances.set(ctx.instanceId, { url, title, mode: "direct", repo });
                    log(`Opening codespace canvas → ${title}`, { ephemeral: true });
                    return {
                        url,
                        title,
                        status: codespaceName ? `Codespace: ${title}` : "Codespace",
                    };
                }

                // Picker mode — reuse existing server if present.
                if (existing?.server) {
                    return { url: existing.url, title: existing.title, status: "Codespaces" };
                }
                const { server, url } = await startPickerServer(ctx.instanceId, repo);
                const title = repo ? `Codespaces · ${repo}` : "Codespaces";
                instances.set(ctx.instanceId, { server, url, title, mode: "picker", repo });
                log("Opening codespaces picker", { ephemeral: true });
                return { url, title, status: "Pick a codespace" };
            },
            onClose: async (ctx) => {
                await closeServer(ctx.instanceId);
                await cleanupTunnel(ctx.instanceId);
                instances.delete(ctx.instanceId);
            },
        }),
    ],
});

sessionRef = session;
