import { useState, useRef, useCallback } from "react";

// ---------- helpers ----------
const API = "https://api.github.com";

const b64encode = (str) => {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
};

const bufToB64 = (buf) => {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
};

const b64decode = (b64) => {
  const bin = atob(b64.replace(/\n/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
};

const gh = async (token, path, opts = {}) => {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opts.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `GitHub API error (${res.status})`);
  return data;
};

// One commit (optionally backdated) for one file, via the Git Data API.
// Returns { commitSha, treeSha } so commits can be chained.
const datedCommit = async (token, repoFull, branch, parentSha, parentTreeSha, file, message, author, dateISO) => {
  const blob = await gh(token, `/repos/${repoFull}/git/blobs`, {
    method: "POST",
    body: JSON.stringify({ content: file.base64, encoding: "base64" }),
  });
  const tree = await gh(token, `/repos/${repoFull}/git/trees`, {
    method: "POST",
    body: JSON.stringify({
      base_tree: parentTreeSha,
      tree: [{ path: file.path, mode: "100644", type: "blob", sha: blob.sha }],
    }),
  });
  const person = dateISO ? { ...author, date: dateISO } : author;
  const commit = await gh(token, `/repos/${repoFull}/git/commits`, {
    method: "POST",
    body: JSON.stringify({
      message,
      tree: tree.sha,
      parents: [parentSha],
      author: person,
      committer: person,
    }),
  });
  await gh(token, `/repos/${repoFull}/git/refs/heads/${branch}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: commit.sha }),
  });
  return { commitSha: commit.sha, treeSha: tree.sha };
};

// ---------- design tokens ----------
const C = {
  bg: "#14161A",
  panel: "#1C1F26",
  panel2: "#22262F",
  line: "#2E333D",
  text: "#E8E6E1",
  muted: "#8B9099",
  amber: "#F2A33C",
  green: "#3FB950",
  red: "#F0635A",
};

const STEPS = [
  { id: "auth", label: "auth" },
  { id: "repos", label: "repo" },
  { id: "files", label: "file" },
  { id: "editor", label: "push" },
];

const SKIP_RE = /(^|\/)(\.git|node_modules|__pycache__|\.next|dist|build|\.DS_Store)(\/|$)/;
const MAX_FILE = 5 * 1024 * 1024;

export default function GitPushMobile() {
  const [step, setStep] = useState("auth");
  const [token, setToken] = useState("");
  const [user, setUser] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const [repos, setRepos] = useState([]);
  const [repoFilter, setRepoFilter] = useState("");
  const [repo, setRepo] = useState(null);
  const [branches, setBranches] = useState([]);
  const [branch, setBranch] = useState("");

  const [path, setPath] = useState("");
  const [entries, setEntries] = useState([]);

  // editor state
  const [filePath, setFilePath] = useState("");
  const [fileSha, setFileSha] = useState(null);
  const [content, setContent] = useState("");
  const [message, setMessage] = useState("");
  const [result, setResult] = useState(null);

  // backdate (shared by editor + bulk)
  const [backdate, setBackdate] = useState(false);
  const [startDate, setStartDate] = useState("");
  const [gapMin, setGapMin] = useState("30");
  const [authorName, setAuthorName] = useState("");
  const [authorEmail, setAuthorEmail] = useState("");

  // bulk state
  const [bulkFiles, setBulkFiles] = useState([]);
  const [bulkPrefix, setBulkPrefix] = useState("");
  const [bulkMsg, setBulkMsg] = useState("Add {file}");
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkDone, setBulkDone] = useState(0);
  const cancelRef = useRef(false);
  const dirInputRef = useRef(null);
  const filesInputRef = useRef(null);

  const stepIndex = result ? 4 : step === "bulk" ? 3 : STEPS.findIndex((s) => s.id === step);

  const run = useCallback(async (fn) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e.message || "Something went wrong");
    } finally {
      setBusy(false);
    }
  }, []);

  const author = () => ({
    name: authorName || user?.name || user?.login || "git-push-mobile",
    email:
      authorEmail ||
      user?.email ||
      `${user?.id}+${user?.login}@users.noreply.github.com`,
  });

  // ---------- actions ----------
  const connect = () =>
    run(async () => {
      const u = await gh(token, "/user");
      setUser(u);
      setAuthorName(u.name || u.login);
      setAuthorEmail(u.email || `${u.id}+${u.login}@users.noreply.github.com`);
      const r = await gh(token, "/user/repos?sort=pushed&per_page=50");
      setRepos(r);
      setStep("repos");
    });

  const openRepo = (r) =>
    run(async () => {
      setRepo(r);
      const br = await gh(token, `/repos/${r.full_name}/branches?per_page=50`);
      setBranches(br.map((b) => b.name));
      setBranch(r.default_branch);
      await listDir(r, "", r.default_branch);
      setStep("files");
    });

  const listDir = async (r, dirPath, br) => {
    const data = await gh(
      token,
      `/repos/${r.full_name}/contents/${dirPath ? encodeURI(dirPath) : ""}?ref=${encodeURIComponent(br)}`
    );
    const arr = Array.isArray(data) ? data : [data];
    arr.sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1
    );
    setEntries(arr);
    setPath(dirPath);
  };

  const openEntry = (entry) =>
    run(async () => {
      if (entry.type === "dir") {
        await listDir(repo, entry.path, branch);
      } else {
        const data = await gh(
          token,
          `/repos/${repo.full_name}/contents/${encodeURI(entry.path)}?ref=${encodeURIComponent(branch)}`
        );
        if (data.encoding !== "base64" || data.size > 400000) {
          throw new Error("File too large or binary — edit smaller text files here.");
        }
        setFilePath(data.path);
        setFileSha(data.sha);
        setContent(b64decode(data.content));
        setMessage(`Update ${data.name}`);
        setResult(null);
        setStep("editor");
      }
    });

  const newFile = () => {
    const base = path ? path + "/" : "";
    setFilePath(base + "new-file.md");
    setFileSha(null);
    setContent("");
    setMessage("Add new file");
    setResult(null);
    setStep("editor");
  };

  const changeBranch = (br) =>
    run(async () => {
      setBranch(br);
      await listDir(repo, "", br);
    });

  const upDir = () =>
    run(async () => {
      const parent = path.split("/").slice(0, -1).join("/");
      await listDir(repo, parent, branch);
    });

  const getHead = async () => {
    const ref = await gh(token, `/repos/${repo.full_name}/git/ref/heads/${branch}`);
    const head = await gh(token, `/repos/${repo.full_name}/git/commits/${ref.object.sha}`);
    return { sha: ref.object.sha, treeSha: head.tree.sha };
  };

  const commit = () =>
    run(async () => {
      const msg = message || (fileSha ? `Update ${filePath}` : `Add ${filePath}`);
      if (backdate && startDate) {
        const head = await getHead();
        const out = await datedCommit(
          token,
          repo.full_name,
          branch,
          head.sha,
          head.treeSha,
          { path: filePath, base64: b64encode(content) },
          msg,
          author(),
          new Date(startDate).toISOString()
        );
        setResult({
          sha: out.commitSha,
          url: `https://github.com/${repo.full_name}/commit/${out.commitSha}`,
          path: filePath,
        });
      } else {
        const body = { message: msg, content: b64encode(content), branch };
        if (fileSha) body.sha = fileSha;
        const data = await gh(
          token,
          `/repos/${repo.full_name}/contents/${encodeURI(filePath)}`,
          { method: "PUT", body: JSON.stringify(body) }
        );
        setResult({
          sha: data.commit.sha,
          url: data.commit.html_url,
          path: data.content.path,
        });
        setFileSha(data.content.sha);
      }
    });

  const backToFiles = () =>
    run(async () => {
      setResult(null);
      await listDir(repo, path, branch);
      setStep("files");
    });

  // ---------- bulk ----------
  const openBulk = () => {
    setBulkFiles([]);
    setBulkPrefix(path);
    setBulkDone(0);
    setError("");
    setStep("bulk");
  };

  const pickFiles = (e) => {
    const list = Array.from(e.target.files || []);
    const accepted = [];
    let skipped = 0;
    for (const f of list) {
      const rel = f.webkitRelativePath || f.name;
      if (SKIP_RE.test(rel)) { skipped++; continue; }
      if (f.size > MAX_FILE) { skipped++; continue; }
      accepted.push({ file: f, rel, status: "pending", sha: null, err: null });
    }
    accepted.sort((a, b) => a.rel.localeCompare(b.rel));
    setBulkFiles(accepted);
    setBulkDone(0);
    if (skipped) setError(`${skipped} file(s) skipped (junk dirs like .git/node_modules, or >5MB)`);
    e.target.value = "";
  };

  const runBulk = async () => {
    setBusy(true);
    setBulkRunning(true);
    setError("");
    cancelRef.current = false;
    let done = 0;
    try {
      let { sha: parent, treeSha } = await getHead();
      const baseTime = backdate && startDate ? new Date(startDate).getTime() : null;
      const gap = Math.max(0, parseFloat(gapMin) || 0) * 60000;
      const files = [...bulkFiles];
      for (let i = 0; i < files.length; i++) {
        if (cancelRef.current) break;
        files[i] = { ...files[i], status: "pushing" };
        setBulkFiles([...files]);
        try {
          const buf = await files[i].file.arrayBuffer();
          const targetPath = (bulkPrefix ? bulkPrefix.replace(/\/+$/, "") + "/" : "") + files[i].rel;
          const msg = bulkMsg.replace("{file}", files[i].rel) || `Add ${files[i].rel}`;
          const dateISO = baseTime ? new Date(baseTime + i * gap).toISOString() : null;
          const out = await datedCommit(
            token, repo.full_name, branch, parent, treeSha,
            { path: targetPath, base64: bufToB64(buf) },
            msg, author(), dateISO
          );
          parent = out.commitSha;
          treeSha = out.treeSha;
          files[i] = { ...files[i], status: "done", sha: out.commitSha };
          done++;
          setBulkDone(done);
        } catch (e) {
          files[i] = { ...files[i], status: "failed", err: e.message };
          setBulkFiles([...files]);
          throw new Error(`Stopped at ${files[i].rel}: ${e.message}`);
        }
        setBulkFiles([...files]);
        await new Promise((r) => setTimeout(r, 250)); // be gentle on rate limits
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBulkRunning(false);
      setBusy(false);
    }
  };

  // ---------- UI bits ----------
  const Node = ({ i }) => {
    const done = i < stepIndex;
    const active = i === stepIndex;
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: "0 0 auto" }}>
        <div
          style={{
            width: 14, height: 14, borderRadius: "50%",
            border: `2px solid ${done ? C.green : active ? C.amber : C.line}`,
            background: done ? C.green : active ? C.amber : "transparent",
            boxShadow: active ? `0 0 10px ${C.amber}66` : "none",
            transition: "all .3s",
          }}
        />
      </div>
    );
  };

  const Graph = () => (
    <div style={{ padding: "18px 20px 6px" }}>
      <div style={{ display: "flex", alignItems: "center" }}>
        {STEPS.map((s, i) => (
          <div key={s.id} style={{ display: "flex", alignItems: "center", flex: i ? 1 : "0 0 auto" }}>
            {i > 0 && (
              <div style={{ flex: 1, height: 2, background: i <= stepIndex ? C.green : C.line, transition: "background .3s" }} />
            )}
            <Node i={i} />
          </div>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
        {STEPS.map((s, i) => (
          <span key={s.id} style={{ fontSize: 11, color: i === stepIndex ? C.amber : i < stepIndex ? C.green : C.muted, letterSpacing: "0.08em" }}>
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );

  const inputStyle = {
    width: "100%", boxSizing: "border-box",
    background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 8,
    color: C.text, padding: "13px 14px", fontSize: 15, fontFamily: "inherit", outline: "none",
  };

  const smallLabel = { fontSize: 11, color: C.muted, letterSpacing: "0.06em", display: "block", margin: "10px 0 5px" };

  const btnStyle = (primary = true) => ({
    width: "100%", boxSizing: "border-box", padding: "14px", borderRadius: 8,
    border: primary ? "none" : `1px solid ${C.line}`,
    background: primary ? C.amber : "transparent",
    color: primary ? "#14161A" : C.text,
    fontSize: 15, fontWeight: 700, fontFamily: "inherit", cursor: "pointer",
    opacity: busy && !bulkRunning ? 0.6 : 1,
  });

  const rowStyle = {
    display: "flex", alignItems: "center", gap: 10, width: "100%", boxSizing: "border-box",
    textAlign: "left", background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8,
    color: C.text, padding: "13px 14px", fontSize: 14, fontFamily: "inherit", cursor: "pointer", marginBottom: 8,
  };

  const BackdatePanel = ({ showGap }) => (
    <div style={{ border: `1px solid ${backdate ? C.amber : C.line}`, borderRadius: 8, padding: "12px 14px", marginBottom: 12, background: backdate ? `${C.amber}0D` : "transparent" }}>
      <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 14, cursor: "pointer" }}>
        <input type="checkbox" checked={backdate} onChange={(e) => setBackdate(e.target.checked)} style={{ width: 18, height: 18, accentColor: C.amber }} />
        backdate commit{showGap ? "s" : ""}
      </label>
      {backdate && (
        <div>
          <span style={smallLabel}>{showGap ? "first commit date & time" : "commit date & time"}</span>
          <input style={inputStyle} type="datetime-local" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          {showGap && (
            <div>
              <span style={smallLabel}>minutes between commits</span>
              <input style={inputStyle} type="number" min="0" value={gapMin} onChange={(e) => setGapMin(e.target.value)} />
            </div>
          )}
          <span style={smallLabel}>author name</span>
          <input style={inputStyle} value={authorName} onChange={(e) => setAuthorName(e.target.value)} />
          <span style={smallLabel}>author email</span>
          <input style={inputStyle} value={authorEmail} onChange={(e) => setAuthorEmail(e.target.value)} />
          <p style={{ fontSize: 11, color: C.muted, lineHeight: 1.6, margin: "10px 0 0" }}>
            Sets git author + committer dates. For commits to count on your
            contribution graph, the email must be verified on your GitHub account.
          </p>
        </div>
      )}
    </div>
  );

  // ---------- screens ----------
  let screen;

  if (step === "auth") {
    screen = (
      <div>
        <h1 style={{ fontSize: 22, margin: "10px 0 4px", color: C.text }}>
          git<span style={{ color: C.amber }}>·</span>push
        </h1>
        <p style={{ color: C.muted, fontSize: 13, lineHeight: 1.6, margin: "0 0 20px" }}>
          Commit and push to your GitHub repos from your phone. Paste a personal
          access token with <b style={{ color: C.text }}>repo</b> (or Contents
          read/write) scope.
        </p>
        <input
          style={inputStyle} type="password" placeholder="ghp_… or github_pat_…"
          value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off"
        />
        <div style={{ height: 12 }} />
        <button style={btnStyle()} onClick={connect} disabled={busy || !token.trim()}>
          {busy ? "connecting…" : "connect"}
        </button>
        <p style={{ color: C.muted, fontSize: 11.5, lineHeight: 1.6, marginTop: 16 }}>
          The token lives only in this page's memory — nothing is stored, and it
          is sent only to api.github.com.
        </p>
      </div>
    );
  } else if (step === "repos") {
    const filtered = repos.filter((r) => r.full_name.toLowerCase().includes(repoFilter.toLowerCase()));
    screen = (
      <div>
        <p style={{ color: C.muted, fontSize: 12, margin: "4px 0 12px" }}>
          signed in as <span style={{ color: C.green }}>{user?.login}</span> · pick a repo
        </p>
        <input style={{ ...inputStyle, marginBottom: 12 }} placeholder="filter repos…" value={repoFilter} onChange={(e) => setRepoFilter(e.target.value)} />
        {filtered.map((r) => (
          <button key={r.id} style={rowStyle} onClick={() => openRepo(r)} disabled={busy}>
            <span style={{ color: C.amber }}>▸</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.full_name}</span>
            {r.private && (
              <span style={{ marginLeft: "auto", fontSize: 10, color: C.muted, border: `1px solid ${C.line}`, borderRadius: 4, padding: "2px 6px" }}>private</span>
            )}
          </button>
        ))}
        {filtered.length === 0 && <p style={{ color: C.muted, fontSize: 13 }}>No repos match that filter.</p>}
      </div>
    );
  } else if (step === "files") {
    screen = (
      <div>
        <p style={{ color: C.muted, fontSize: 12, margin: "4px 0 10px", wordBreak: "break-all" }}>
          {repo.full_name} <span style={{ color: C.line }}>/</span>{" "}
          <span style={{ color: C.text }}>{path || "(root)"}</span>
        </p>
        <select style={{ ...inputStyle, marginBottom: 12 }} value={branch} onChange={(e) => changeBranch(e.target.value)}>
          {branches.map((b) => <option key={b} value={b}>⎇ {b}</option>)}
        </select>
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <button style={{ ...btnStyle(false), flex: 1 }} onClick={() => setStep("repos")} disabled={busy}>← repos</button>
          {path && <button style={{ ...btnStyle(false), flex: 1 }} onClick={upDir} disabled={busy}>↑ up</button>}
          <button style={{ ...btnStyle(false), flex: 1 }} onClick={newFile} disabled={busy}>+ new file</button>
        </div>
        <button style={{ ...btnStyle(true), marginBottom: 12 }} onClick={openBulk} disabled={busy}>
          ⇪ push a folder (one commit per file)
        </button>
        {entries.map((e) => (
          <button key={e.sha + e.path} style={rowStyle} onClick={() => openEntry(e)} disabled={busy}>
            <span style={{ color: e.type === "dir" ? C.amber : C.muted }}>{e.type === "dir" ? "▸" : "·"}</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.name}</span>
          </button>
        ))}
      </div>
    );
  } else if (step === "editor") {
    screen = (
      <div>
        {result && (
          <div style={{ border: `1px solid ${C.green}`, borderRadius: 8, padding: 16, marginBottom: 14, background: `${C.green}14` }}>
            <p style={{ color: C.green, fontSize: 14, fontWeight: 700, margin: 0 }}>✓ pushed to {branch}</p>
            <p style={{ color: C.muted, fontSize: 12, margin: "8px 0 0", wordBreak: "break-all" }}>
              {result.path} @ {result.sha.slice(0, 7)}
            </p>
            <a href={result.url} target="_blank" rel="noreferrer" style={{ color: C.amber, fontSize: 13, display: "inline-block", marginTop: 8 }}>
              view commit on GitHub →
            </a>
          </div>
        )}
        <input style={{ ...inputStyle, marginBottom: 10 }} value={filePath} onChange={(e) => setFilePath(e.target.value)} disabled={!!fileSha} placeholder="path/to/file.ext" />
        <textarea
          style={{ ...inputStyle, minHeight: 240, resize: "vertical", fontSize: 13, lineHeight: 1.55, marginBottom: 10 }}
          value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false}
        />
        <input style={{ ...inputStyle, marginBottom: 12 }} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="commit message" />
        <BackdatePanel showGap={false} />
        <div style={{ display: "flex", gap: 8 }}>
          <button style={{ ...btnStyle(false), flex: 1 }} onClick={backToFiles} disabled={busy}>← files</button>
          <button style={{ ...btnStyle(true), flex: 2 }} onClick={commit} disabled={busy || (backdate && !startDate)}>
            {busy ? "pushing…" : fileSha ? "commit & push" : "create & push"}
          </button>
        </div>
      </div>
    );
  } else if (step === "bulk") {
    const total = bulkFiles.length;
    const allDone = total > 0 && bulkDone === total && !bulkRunning;
    screen = (
      <div>
        <p style={{ color: C.muted, fontSize: 12, margin: "4px 0 12px", wordBreak: "break-all" }}>
          {repo.full_name} <span style={{ color: C.line }}>·</span> ⎇ {branch} <span style={{ color: C.line }}>·</span> one commit per file
        </p>

        <input ref={dirInputRef} type="file" webkitdirectory="" directory="" multiple style={{ display: "none" }} onChange={pickFiles} />
        <input ref={filesInputRef} type="file" multiple style={{ display: "none" }} onChange={pickFiles} />

        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <button style={{ ...btnStyle(true), flex: 1 }} onClick={() => dirInputRef.current?.click()} disabled={busy}>
            select folder
          </button>
          <button style={{ ...btnStyle(false), flex: 1 }} onClick={() => filesInputRef.current?.click()} disabled={busy}>
            select files
          </button>
        </div>
        <p style={{ fontSize: 11, color: C.muted, lineHeight: 1.6, margin: "0 0 12px" }}>
          If the folder picker doesn't open on your phone's browser, use
          "select files" and multi-select instead. .git, node_modules and files
          over 5MB are skipped automatically.
        </p>

        <span style={smallLabel}>target folder in repo (blank = root)</span>
        <input style={{ ...inputStyle, marginBottom: 10 }} value={bulkPrefix} onChange={(e) => setBulkPrefix(e.target.value)} placeholder="e.g. src/assets" />

        <span style={smallLabel}>commit message template ({"{file}"} = filename)</span>
        <input style={{ ...inputStyle, marginBottom: 12 }} value={bulkMsg} onChange={(e) => setBulkMsg(e.target.value)} />

        <BackdatePanel showGap={true} />

        {total > 0 && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
              <span style={{ fontSize: 12, color: C.muted }}>{total} file{total > 1 ? "s" : ""} → {total} commit{total > 1 ? "s" : ""}</span>
              <span style={{ fontSize: 12, color: allDone ? C.green : C.amber }}>{bulkDone}/{total}</span>
            </div>
            <div style={{ height: 4, background: C.line, borderRadius: 2, marginBottom: 10 }}>
              <div style={{ height: 4, width: `${total ? (bulkDone / total) * 100 : 0}%`, background: allDone ? C.green : C.amber, borderRadius: 2, transition: "width .3s" }} />
            </div>
            <div style={{ maxHeight: 220, overflowY: "auto", border: `1px solid ${C.line}`, borderRadius: 8 }}>
              {bulkFiles.map((f, i) => (
                <div key={f.rel + i} style={{ display: "flex", gap: 8, alignItems: "center", padding: "9px 12px", borderBottom: i < total - 1 ? `1px solid ${C.line}` : "none", fontSize: 12 }}>
                  <span style={{ color: f.status === "done" ? C.green : f.status === "failed" ? C.red : f.status === "pushing" ? C.amber : C.muted, flex: "0 0 auto" }}>
                    {f.status === "done" ? "✓" : f.status === "failed" ? "✗" : f.status === "pushing" ? "…" : "·"}
                  </span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: C.text }}>{f.rel}</span>
                  {f.sha && <span style={{ marginLeft: "auto", color: C.muted, flex: "0 0 auto" }}>{f.sha.slice(0, 7)}</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        {allDone && (
          <div style={{ border: `1px solid ${C.green}`, borderRadius: 8, padding: 14, marginBottom: 12, background: `${C.green}14` }}>
            <p style={{ color: C.green, fontSize: 14, fontWeight: 700, margin: 0 }}>✓ {total} commits pushed to {branch}</p>
            <a href={`https://github.com/${repo.full_name}/commits/${branch}`} target="_blank" rel="noreferrer" style={{ color: C.amber, fontSize: 13, display: "inline-block", marginTop: 8 }}>
              view commit history →
            </a>
          </div>
        )}

        <div style={{ display: "flex", gap: 8 }}>
          <button style={{ ...btnStyle(false), flex: 1 }} onClick={() => { cancelRef.current = true; setStep("files"); }} disabled={bulkRunning}>
            ← files
          </button>
          {bulkRunning ? (
            <button style={{ ...btnStyle(false), flex: 2, borderColor: C.red, color: C.red }} onClick={() => (cancelRef.current = true)}>
              stop after current file
            </button>
          ) : (
            <button style={{ ...btnStyle(true), flex: 2 }} onClick={runBulk} disabled={busy || total === 0 || allDone || (backdate && !startDate)}>
              push {total || ""} commit{total === 1 ? "" : "s"}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: "'IBM Plex Mono','JetBrains Mono',ui-monospace,Menlo,monospace", color: C.text }}>
      <div style={{ maxWidth: 560, margin: "0 auto" }}>
        <Graph />
        <div style={{ padding: "8px 20px 40px" }}>
          {error && (
            <div style={{ border: `1px solid ${C.red}`, background: `${C.red}14`, color: C.red, borderRadius: 8, padding: "10px 12px", fontSize: 13, marginBottom: 14, wordBreak: "break-word" }}>
              {error}
            </div>
          )}
          {screen}
        </div>
      </div>
    </div>
  );
}
