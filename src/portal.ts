/** Self-contained key-generation page served at "/". No external assets. */
export function portalHtml(opts: { publicSignup: boolean; adminEnabled: boolean; version: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Indian Kanoon MCP</title>
<style>
:root{--bg:#f7f6f2;--card:#fff;--ink:#1d1d1b;--muted:#6b6a65;--line:#e3e1da;--accent:#7a2e1d;--accent-ink:#fff;--code:#f1efe8;--ok:#1f6b3a;--bad:#a12a1a}
@media (prefers-color-scheme:dark){:root{--bg:#151514;--card:#1e1e1c;--ink:#eceae4;--muted:#a3a19a;--line:#33322f;--accent:#d9825f;--accent-ink:#151514;--code:#262624;--ok:#6fcf97;--bad:#ff8a75}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:860px;margin:0 auto;padding:40px 16px 80px}
h1{font:600 30px/1.2 ui-serif,Georgia,serif;margin:0 0 6px}
h2{font-size:18px;margin:32px 0 10px}
p.lead{color:var(--muted);margin:0 0 28px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:22px}
label{display:block;font-weight:600;font-size:14px;margin:14px 0 6px}
.hint{font-weight:400;color:var(--muted);font-size:13px}
input{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);font:inherit}
button{margin-top:18px;padding:11px 18px;border:0;border-radius:8px;background:var(--accent);color:var(--accent-ink);font:600 15px/1 inherit;cursor:pointer}
button[disabled]{opacity:.6;cursor:wait}
.msg{margin-top:14px;font-size:14px}.msg.bad{color:var(--bad)}.msg.ok{color:var(--ok)}
pre{background:var(--code);border:1px solid var(--line);border-radius:8px;padding:12px;overflow-x:auto;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-all;margin:6px 0 0;position:relative}
.copy{position:absolute;top:6px;right:6px;margin:0;padding:4px 8px;font-size:12px}
.tabs{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 10px}
.tabs button{margin:0;background:transparent;color:var(--ink);border:1px solid var(--line);font-weight:500;padding:7px 11px}
.tabs button.on{background:var(--ink);color:var(--bg)}
.key{font:600 15px ui-monospace,monospace;word-break:break-all}
table{border-collapse:collapse;width:100%;font-size:14px}td,th{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line)}
.hidden{display:none}
small{color:var(--muted)}
</style>
</head>
<body>
<main>
<h1>Indian Kanoon MCP</h1>
<p class="lead">Search and read Indian judgments and statutes from Claude, Codex, Cursor, ChatGPT or any MCP client. Two ways to use it: <a href="#create">hosted</a> (create a key here and connect by URL) or <a href="#local">local</a> (runs on your computer with your own Indian Kanoon token).</p>

<h2 style="margin-top:0">Hosted</h2>
<div class="card" id="create">
  <strong>Create a connection key</strong>
  <form id="f">
    <label>Name <span class="hint">e.g. your name or team</span></label>
    <input name="label" required maxlength="80" placeholder="Rajat — legal team">
    ${opts.publicSignup ? `<label>Indian Kanoon API token <span class="hint">from api.indiankanoon.org. Your calls are billed to this token. Stored encrypted.</span></label>
    <input name="ik_token" autocomplete="off" spellcheck="false" placeholder="40-character token"${opts.adminEnabled ? "" : " required"}>` : ""}
    <label>Daily spend cap (Rs) <span class="hint">calls stop for the day at this amount</span></label>
    <input name="daily_budget_inr" type="number" min="1" max="10000" step="1" value="50">
    ${opts.adminEnabled ? `<label>Admin token <span class="hint">owner only: leave the Indian Kanoon token empty to use the server's own token</span></label>
    <input name="admin_token" type="password" autocomplete="off">` : ""}
    <button id="go" type="submit">Create key</button>
    <div class="msg" id="msg"></div>
  </form>
  ${!opts.publicSignup && !opts.adminEnabled ? "<p class=msg>Key creation is disabled on this server.</p>" : ""}
</div>

<div id="result" class="hidden">
  <h2>Your key</h2>
  <div class="card">
    <div class="key" id="keyText"></div>
    <p><small>Shown once. Store it like a password. Anyone with this key, or with the connector URL below, can spend from your cap.</small></p>
  </div>
  <h2>Connect your client</h2>
  <div class="tabs" id="tabs"></div>
  <div class="card" id="snippet"></div>
</div>

<h2 id="local">Use it locally</h2>
<div class="card">
  <p style="margin-top:0">Only need your Indian Kanoon API token. The server runs on your computer and calls Indian Kanoon directly with your token; nothing goes through this site. Needs <a href="https://nodejs.org/">Node.js</a> 22.13 or later.</p>
  <div class="tabs" id="ltabs"></div>
  <div id="lsnippet"></div>
</div>

<h2>Check a key</h2>
<div class="card">
  <label>Connection key</label>
  <input id="checkKey" autocomplete="off" spellcheck="false" placeholder="ikm_…">
  <button id="checkBtn" type="button">Show usage</button>
  <button id="revokeBtn" type="button" style="background:transparent;color:var(--bad);border:1px solid var(--line)">Revoke key</button>
  <div class="msg" id="checkMsg"></div>
</div>

<h2>Tools</h2>
<div class="card"><table>
<tr><th>Tool</th><th>Use</th><th>Price</th></tr>
<tr><td>ik_search</td><td>Find judgments, acts, tribunal orders with court, date, judge and citation filters</td><td>Rs 0.50 / page</td></tr>
<tr><td>ik_fragments</td><td>Only the passages of a document that match a query</td><td>Rs 0.05</td></tr>
<tr><td>ik_metadata</td><td>Court, date, case number, cites and cited-by lists</td><td>Rs 0.02</td></tr>
<tr><td>ik_document</td><td>Clean text in chunks; filter to facts, issues, arguments, reasoning or conclusion</td><td>Rs 0.20 once</td></tr>
<tr><td>ik_court_copy</td><td>Download link for the original court PDF</td><td>Rs 0.50</td></tr>
<tr><td>ik_usage</td><td>Today's spend and remaining cap</td><td>Free</td></tr>
</table><p><small>Repeat calls are served from cache at no cost. Prices are Indian Kanoon's published per-request rates.</small></p></div>
</main>
<script>
const origin = location.origin;
const pkg = origin + "/local/indiankanoon-mcp-${opts.version}.tgz";
const $ = (id) => document.getElementById(id);
const esc = (s) => s.replace(/[&<>]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
function block(title, code, note) {
  return '<p><strong>' + title + '</strong>' + (note ? '<br><small>' + note + '</small>' : '') + '</p><pre><button class="copy" type="button">Copy</button>' + esc(code) + '</pre>';
}
function snippets(key) {
  const url = origin + "/mcp";
  const pathUrl = origin + "/mcp/" + key;
  return {
    "Claude Code": block("Run in a terminal", 'claude mcp add --transport http --scope user indiankanoon ' + url + ' --header "Authorization: Bearer ' + key + '"'),
    "Claude.ai / Desktop": block("Settings → Connectors → Add custom connector", "Name: Indian Kanoon\\nURL:  " + pathUrl, "Paste the URL as is and leave OAuth fields empty. The key is inside the URL, so keep the URL private."),
    "Codex": block("Run in a terminal", 'export IKMCP_KEY=' + key + '\\ncodex mcp add indiankanoon --url ' + url + ' --bearer-token-env-var IKMCP_KEY')
      + block("Or add to ~/.codex/config.toml", '[mcp_servers.indiankanoon]\\nurl = "' + url + '"\\nbearer_token_env_var = "IKMCP_KEY"', "Keep IKMCP_KEY exported in your shell profile."),
    "Cursor": block("~/.cursor/mcp.json", JSON.stringify({ mcpServers: { indiankanoon: { url, headers: { Authorization: "Bearer " + key } } } }, null, 2)),
    "VS Code": block(".vscode/mcp.json", JSON.stringify({ servers: { indiankanoon: { type: "http", url, headers: { Authorization: "Bearer " + key } } } }, null, 2)),
    "Gemini CLI": block("~/.gemini/settings.json", JSON.stringify({ mcpServers: { indiankanoon: { httpUrl: url, headers: { Authorization: "Bearer " + key } } } }, null, 2)),
    "ChatGPT": block("Settings → Connectors → Create (developer mode)", "MCP server URL: " + pathUrl + "\\nAuthentication: No authentication", "For a custom GPT instead, import Actions from " + origin + "/openapi.json and set API key auth, Bearer, with your key."),
    "REST API": block("Any language", 'curl -s ' + origin + '/api/v1/tools/ik_search \\\\\\n  -H "Authorization: Bearer ' + key + '" \\\\\\n  -H "Content-Type: application/json" \\\\\\n  -d \\'{"query":"right to privacy","doctypes":["supremecourt"]}\\'', "Tool list: GET " + origin + "/api/v1/tools · OpenAPI: " + origin + "/openapi.json"),
  };
}
function showKey(key) {
  $("keyText").textContent = key;
  renderTabs("tabs", "snippet", snippets(key));
  $("result").classList.remove("hidden");
  $("result").scrollIntoView({ behavior: "smooth" });
}
function localSnippets() {
  const env = { IK_API_TOKEN: "YOUR_INDIAN_KANOON_TOKEN", IK_DAILY_BUDGET_INR: "50" };
  const npxServer = { command: "npx", args: ["-y", pkg], env };
  return {
    "Quick setup": block("1. Run this in a terminal", "npx -y " + pkg + " setup", "2. Paste your Indian Kanoon API token when asked. 3. Open a new chat in Claude Code, Claude Desktop, Codex or Cursor and ask a legal question. The setup finds these apps and connects them for you."),
    "Claude Code": block("Run in a terminal", "claude mcp add indiankanoon --scope user -e IK_API_TOKEN=YOUR_INDIAN_KANOON_TOKEN -e IK_DAILY_BUDGET_INR=50 -- npx -y " + pkg),
    "Claude Desktop": block("Settings → Developer → Edit config, then restart", JSON.stringify({ mcpServers: { indiankanoon: npxServer } }, null, 2), "If Claude Desktop cannot find npx, use Quick setup instead."),
    "Codex": block("~/.codex/config.toml", '[mcp_servers.indiankanoon]\\ncommand = "npx"\\nargs = ["-y", "' + pkg + '"]\\nenv = { IK_API_TOKEN = "YOUR_INDIAN_KANOON_TOKEN", IK_DAILY_BUDGET_INR = "50" }'),
    "Cursor": block("~/.cursor/mcp.json", JSON.stringify({ mcpServers: { indiankanoon: npxServer } }, null, 2)),
  };
}
function renderTabs(tabsId, targetId, s) {
  const tabs = $(tabsId);
  tabs.innerHTML = "";
  Object.keys(s).forEach((name, i) => {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = name;
    b.onclick = () => { [...tabs.children].forEach((x) => x.classList.remove("on")); b.classList.add("on"); $(targetId).innerHTML = s[name]; };
    tabs.appendChild(b);
    if (i === 0) b.click();
  });
}
renderTabs("ltabs", "lsnippet", localSnippets());
document.addEventListener("click", (e) => {
  if (e.target.classList.contains("copy")) {
    const text = e.target.parentElement.textContent.replace(/^Copy/, "");
    navigator.clipboard.writeText(text).then(() => { e.target.textContent = "Copied"; setTimeout(() => (e.target.textContent = "Copy"), 1500); });
  }
});
const f = $("f");
if (f) f.addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(f).entries());
  data.daily_budget_inr = Number(data.daily_budget_inr);
  for (const k of Object.keys(data)) if (data[k] === "") delete data[k];
  $("go").disabled = true; $("msg").className = "msg"; $("msg").textContent = "Checking token…";
  try {
    const r = await fetch("/api/keys", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "Request failed");
    $("msg").className = "msg ok"; $("msg").textContent = "Key created.";
    f.reset();
    showKey(j.key);
  } catch (err) { $("msg").className = "msg bad"; $("msg").textContent = err.message; }
  finally { $("go").disabled = false; }
});
async function me(method, path) {
  const key = $("checkKey").value.trim();
  const r = await fetch(path, { method, headers: { Authorization: "Bearer " + key } });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || "Request failed");
  return j;
}
$("checkBtn").onclick = async () => {
  try {
    const j = await me("GET", "/api/me");
    $("checkMsg").className = "msg ok";
    $("checkMsg").textContent = j.label + " · today Rs " + j.usage.today.spentInr.toFixed(2) + " of Rs " + j.daily_budget_inr + " · " + (j.uses_server_token ? "server token" : "own token") + (j.disabled ? " · REVOKED" : "");
  } catch (err) { $("checkMsg").className = "msg bad"; $("checkMsg").textContent = err.message; }
};
$("revokeBtn").onclick = async () => {
  if (!confirm("Revoke this key? Clients using it stop working immediately.")) return;
  try { await me("POST", "/api/me/revoke"); $("checkMsg").className = "msg ok"; $("checkMsg").textContent = "Key revoked."; }
  catch (err) { $("checkMsg").className = "msg bad"; $("checkMsg").textContent = err.message; }
};
</script>
</body>
</html>`;
}
