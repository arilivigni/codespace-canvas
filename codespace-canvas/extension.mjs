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

import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { joinSession, createCanvas } from "@github/copilot-sdk/extension";

const CANVAS_ID = "codespace-canvas";

// Per-instance state: { server?, url, title, mode: "picker" | "direct", repo? }
const instances = new Map();

let sessionRef = null;
function log(message, options) {
    if (sessionRef) sessionRef.log(message, options).catch(() => {});
}

// ---------------------------------------------------------------------------
// gh helpers
// ---------------------------------------------------------------------------

function gh(args) {
    return new Promise((resolve) => {
        execFile(
            "gh",
            args,
            { maxBuffer: 10 * 1024 * 1024, env: process.env },
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
                "Open a GitHub Codespace in a side panel. Pass a codespace name or repo to open directly, or omit input to show a picker of your codespaces.",
            inputSchema: {
                type: "object",
                properties: {
                    codespaceName: {
                        type: "string",
                        description:
                            "Exact codespace name (e.g. 'octocat-myrepo-abc123'). Opens that codespace directly.",
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
                        };
                    },
                },
            ],
            open: async (ctx) => {
                const input = ctx.input || {};
                const codespaceName =
                    typeof input.codespaceName === "string" ? input.codespaceName.trim() : "";
                const repo = typeof input.repo === "string" ? input.repo.trim() : "";
                const explicitUrl = typeof input.url === "string" ? input.url.trim() : "";

                const existing = instances.get(ctx.instanceId);

                // Direct URL (explicit or named codespace) — no local server needed.
                if (explicitUrl || codespaceName) {
                    const url = explicitUrl || editorUrlForName(codespaceName);
                    const title = codespaceName || "Codespace";
                    if (existing?.server) await closeServer(ctx.instanceId);
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
                instances.delete(ctx.instanceId);
            },
        }),
    ],
});

sessionRef = session;
