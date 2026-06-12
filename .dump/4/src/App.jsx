import { useState, useRef, useMemo, useCallback } from "react";

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

// One commit (optionally backdated) holding one OR many files, via the Git Data API.
// When parentSha is null (empty repo), the commit has no parent and the branch
// ref is created instead of updated.
const datedMultiCommit = async (token, repoFull, branch, parentSha, parentTreeSha, files, message, author, dateISO, createRef = false) => {
  const tree = [];
  for (const f of files) {
    const blob = await gh(token, `/repos/${repoFull}/git/blobs`, {
      method: "POST",
      body: JSON.stringify({ content: f.base64, encoding: "base64" }),
    });
    tree.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
  }
  const treeBody = { tree };
  if (parentTreeSha) treeBody.base_tree = parentTreeSha;
  const treeObj = await gh(token, `/repos/${repoFull}/git/trees`, {
    method: "POST",
    body: JSON.stringify(treeBody),
  });
  const person = dateISO ? { ...author, date: dateISO } : author;
  const commit = await gh(token, `/repos/${repoFull}/git/commits`, {
    method: "POST",
    body: JSON.stringify({
      message,
      tree: treeObj.sha,
      parents: parentSha ? [parentSha] : [],
      author: person,
      committer: person,
    }),
  });
  if (createRef) {
    await gh(token, `/repos/${repoFull}/git/refs`, {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }),
    });
  } else {
    await gh(token, `/repos/${repoFull}/git/refs/heads/${branch}`, {
      method: "PATCH",
      body: JSON.stringify({ sha: commit.sha }),
    });
  }
  return { commitSha: commit.sha, treeSha: treeObj.sha };
};

// ---------- planning (pure) ----------
// Rule-based conventional-commit message generator. No API, runs instantly.
const stripExt = (n) => n.replace(/\.[^.]+$/, "");
const titleize = (s) => s.replace(/[-_]/g, " ").trim();
const COMPONENT_EXT = /\.(jsx|tsx|vue|svelte)$/i;
const GENERIC_DIR = /^(src|app|lib|public|root|dist|out|tests?|docs?|styles?|assets|static|config)$/i;

const classify = (name) => {
  const n = name.toLowerCase();
  if (/(\.test\.|\.spec\.|(^|\/)__tests__\/|(^|\/)tests?\/)/.test(n)) return "test";
  if (/(^|\/)readme|\.md$|\.mdx$|\.rst$|(^|\/)docs?\//.test(n)) return "docs";
  if (/\.(css|scss|sass|less|styl)$/.test(n)) return "style";
  if (/(package(-lock)?\.json|tsconfig|jsconfig|\.ya?ml$|\.toml$|\.ini$|dockerfile|\.config\.|\.env|\.gitignore|vite\.|webpack|rollup|babel|eslint|prettier)/.test(n)) return "chore";
  if (/\.(png|jpe?g|gif|svg|webp|ico|avif|woff2?|ttf|otf|eot|mp4|mp3|wav)$/.test(n)) return "chore";
  if (/\.(sql|prisma)$|migration/.test(n)) return "feat";
  return "feat";
};

const heuristicMsg = (paths) => {
  const names = paths.map((p) => p.split("/").pop());
  const dirs = paths.map((p) => p.split("/").slice(0, -1).join("/"));
  const commonDir = dirs.every((d) => d === dirs[0]) ? dirs[0] : "";
  const scope = commonDir ? commonDir.split("/").filter(Boolean).pop() : "";
  const scoped = scope && !GENERIC_DIR.test(scope);
  const scopePart = scoped ? `(${scope})` : "";

  const counts = {};
  paths.forEach((p) => { const t = classify(p); counts[t] = (counts[t] || 0) + 1; });
  const type = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];

  if (paths.length === 1) {
    const t = classify(paths[0]);
    const base = titleize(stripExt(names[0]).replace(/\.(test|spec)$/i, ""));
    if (t === "docs") return `docs${scopePart}: update ${base}`;
    if (t === "test") return `test${scopePart}: add ${base} tests`;
    if (t === "chore") return `chore${scopePart}: add ${names[0]}`;
    if (t === "style") return `style${scopePart}: add ${base} styles`;
    if (COMPONENT_EXT.test(names[0])) return `feat${scopePart}: add ${base} component`;
    return `feat${scopePart}: add ${base}`;
  }
  if (scoped) {
    const verb = type === "docs" ? "update" : "add";
    return `${type}(${scope}): ${verb} ${titleize(scope)} (${paths.length} files)`;
  }
  const shown = names.slice(0, 2).map((n) => titleize(stripExt(n))).join(", ");
  const more = names.length > 2 ? ` +${names.length - 2}` : "";
  return `${type}: add ${shown}${more}`;
};

// Partition files into commit groups + assign dates + messages.
const buildPlan = (files, opts) => {
  const { distMode, target, backdate, startDate, endDate, gapMin, perFileTpl, aiMsgs } = opts;
  const F = files.length;
  if (!F) return [];

  let groups;
  if (distMode === "perfile") {
    groups = files.map((f) => [f]);
  } else {
    const M = Math.max(1, Math.min(parseInt(target) || 1, F));
    const base = Math.floor(F / M);
    const rem = F % M;
    groups = [];
    let idx = 0;
    for (let i = 0; i < M; i++) {
      const size = base + (i < rem ? 1 : 0);
      groups.push(files.slice(idx, idx + size));
      idx += size;
    }
  }

  const M = groups.length;
  let dates = new Array(M).fill(null);
  if (backdate && startDate) {
    if (distMode === "perfile") {
      const gap = Math.max(0, parseFloat(gapMin) || 0) * 60000;
      const base = new Date(startDate).getTime();
      dates = groups.map((_, i) => new Date(base + i * gap).toISOString());
    } else {
      const s = new Date(startDate).getTime();
      const e = endDate ? new Date(endDate).getTime() : s;
      dates = groups.map((_, i) =>
        new Date(M === 1 ? s : s + ((e - s) * i) / (M - 1)).toISOString()
      );
    }
  }

  return groups.map((g, i) => {
    let message;
    if (aiMsgs && aiMsgs[i]) message = aiMsgs[i];
    else if (distMode === "perfile") message = perFileTpl.replace("{file}", g[0].rel) || `Add ${g[0].rel}`;
    else message = heuristicMsg(g.map((x) => x.rel));
    return { files: g, dateISO: dates[i], message };
  });
};

// ---------- design tokens ----------
const C = {
  bg: "#14161A", panel: "#1C1F26", panel2: "#22262F", line: "#2E333D",
  text: "#E8E6E1", muted: "#8B9099", amber: "#F2A33C", green: "#3FB950", red: "#F0635A",
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
  const [repoEmpty, setRepoEmpty] = useState(false);

  const [path, setPath] = useState("");
  const [entries, setEntries] = useState([]);

  // editor state
  const [filePath, setFilePath] = useState("");
  const [fileSha, setFileSha] = useState(null);
  const [content, setContent] = useState("");
  const [message, setMessage] = useState("");
  const [result, setResult] = useState(null);

  // backdate + author (shared)
  const [backdate, setBackdate] = useState(false);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [gapMin, setGapMin] = useState("30");
  const [authorName, setAuthorName] = useState("");
  const [authorEmail, setAuthorEmail] = useState("");

  // bulk state
  const [bulkFiles, setBulkFiles] = useState([]);
  const [bulkPrefix, setBulkPrefix] = useState("");
  const [distMode, setDistMode] = useState("perfile"); // perfile | target
  const [target, setTarget] = useState("20");
  const [perFileTpl, setPerFileTpl] = useState("Add {file}");
  const [aiMsgs, setAiMsgs] = useState(null);
  const [genning, setGenning] = useState(false);

  const [bulkRunning, setBulkRunning] = useState(false);
  const [commitStatus, setCommitStatus] = useState([]); // per-commit: {status, sha}
  const cancelRef = useRef(false);
  const dirInputRef = useRef(null);
  const filesInputRef = useRef(null);

  const stepIndex = result ? 4 : step === "bulk" ? 3 : STEPS.findIndex((s) => s.id === step);

  const run = useCallback(async (fn) => {
    setBusy(true);
    setError("");
    try { await fn(); }
    catch (e) { setError(e.message || "Something went wrong"); }
    finally { setBusy(false); }
  }, []);

  const author = () => ({
    name: authorName || user?.name || user?.login || "git-push-mobile",
    email: authorEmail || user?.email || `${user?.id}+${user?.login}@users.noreply.github.com`,
  });

  // live plan preview
  const plan = useMemo(
    () => buildPlan(bulkFiles, { distMode, target, backdate, startDate, endDate, gapMin, perFileTpl, aiMsgs }),
    [bulkFiles, distMode, target, backdate, startDate, endDate, gapMin, perFileTpl, aiMsgs]
  );

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
      let br = [];
      try { br = await gh(token, `/repos/${r.full_name}/branches?per_page=50`); } catch { br = []; }
      const names = br.map((b) => b.name);
      setBranch(r.default_branch);
      if (names.length === 0) {
        // Brand-new repo with no commits yet.
        setRepoEmpty(true);
        setBranches([r.default_branch]);
        setEntries([]);
        setPath("");
      } else {
        setRepoEmpty(false);
        setBranches(names);
        await listDir(r, "", r.default_branch);
      }
      setStep("files");
    });

  const listDir = async (r, dirPath, br) => {
    const data = await gh(token, `/repos/${r.full_name}/contents/${dirPath ? encodeURI(dirPath) : ""}?ref=${encodeURIComponent(br)}`);
    const arr = Array.isArray(data) ? data : [data];
    arr.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
    setEntries(arr);
    setPath(dirPath);
  };

  const openEntry = (entry) =>
    run(async () => {
      if (entry.type === "dir") {
        await listDir(repo, entry.path, branch);
      } else {
        const data = await gh(token, `/repos/${repo.full_name}/contents/${encodeURI(entry.path)}?ref=${encodeURIComponent(branch)}`);
        if (data.encoding !== "base64" || data.size > 400000) throw new Error("File too large or binary — edit smaller text files here.");
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

  const changeBranch = (br) => run(async () => { setBranch(br); await listDir(repo, "", br); });
  const upDir = () => run(async () => { await listDir(repo, path.split("/").slice(0, -1).join("/"), branch); });

  const getHead = async () => {
    if (repoEmpty) return { sha: null, treeSha: null, empty: true };
    const ref = await gh(token, `/repos/${repo.full_name}/git/ref/heads/${branch}`);
    const head = await gh(token, `/repos/${repo.full_name}/git/commits/${ref.object.sha}`);
    return { sha: ref.object.sha, treeSha: head.tree.sha, empty: false };
  };

  const commit = () =>
    run(async () => {
      const msg = message || (fileSha ? `Update ${filePath}` : `Add ${filePath}`);
      // Backdated, OR first commit into an empty repo, must go through the Git Data API.
      if ((backdate && startDate) || repoEmpty) {
        const head = await getHead();
        const out = await datedMultiCommit(token, repo.full_name, branch, head.sha, head.treeSha,
          [{ path: filePath, base64: b64encode(content) }], msg, author(),
          backdate && startDate ? new Date(startDate).toISOString() : null, head.empty);
        setResult({ sha: out.commitSha, url: `https://github.com/${repo.full_name}/commit/${out.commitSha}`, path: filePath });
        setFileSha(out.commitSha ? null : fileSha);
        setRepoEmpty(false);
      } else {
        const body = { message: msg, content: b64encode(content), branch };
        if (fileSha) body.sha = fileSha;
        const data = await gh(token, `/repos/${repo.full_name}/contents/${encodeURI(filePath)}`, { method: "PUT", body: JSON.stringify(body) });
        setResult({ sha: data.commit.sha, url: data.commit.html_url, path: data.content.path });
        setFileSha(data.content.sha);
      }
    });

  const backToFiles = () => run(async () => { setResult(null); if (!repoEmpty) await listDir(repo, path, branch); setStep("files"); });

  // ---------- bulk ----------
  const openBulk = () => {
    setBulkFiles([]);
    setBulkPrefix(path);
    setCommitStatus([]);
    setAiMsgs(null);
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
      accepted.push({ file: f, rel });
    }
    accepted.sort((a, b) => a.rel.localeCompare(b.rel));
    setBulkFiles(accepted);
    setCommitStatus([]);
    setAiMsgs(null);
    if (skipped) setError(`${skipped} file(s) skipped (.git/node_modules/build dirs, or >5MB)`);
    else setError("");
    e.target.value = "";
  };

  // Optional AI polish — calls the serverless function at /api/messages.
  // The built-in messages are already good; this just refines them.
  // Retries on transient overload (429/503) with backoff.
  const genMessages = async () => {
    if (!plan.length) return;
    setGenning(true);
    setError("");
    const groups = plan.map((c) => c.files.map((f) => f.rel));
    const attempt = async () => {
      const res = await fetch("/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groups }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(data.error || `server error (${res.status})`);
        err.retryable = res.status === 429 || res.status === 503;
        throw err;
      }
      return data.messages;
    };
    try {
      let arr, lastErr;
      for (let i = 0; i < 3; i++) {
        try { arr = await attempt(); break; }
        catch (e) {
          lastErr = e;
          if (!e.retryable || i === 2) throw e;
          await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
        }
      }
      if (!Array.isArray(arr) || arr.length !== groups.length) throw lastErr || new Error("unexpected response shape");
      setAiMsgs(arr.map(String));
    } catch (e) {
      setError("AI refine unavailable right now — using the built-in messages, which are ready to push. " + (e.message || ""));
    } finally {
      setGenning(false);
    }
  };

  const runBulk = async () => {
    const execPlan = buildPlan(bulkFiles, { distMode, target, backdate, startDate, endDate, gapMin, perFileTpl, aiMsgs });
    if (!execPlan.length) return;
    setBusy(true);
    setBulkRunning(true);
    setError("");
    cancelRef.current = false;
    const status = execPlan.map(() => ({ status: "pending", sha: null }));
    setCommitStatus([...status]);
    try {
      let { sha: parent, treeSha, empty } = await getHead();
      let createRef = empty;
      for (let i = 0; i < execPlan.length; i++) {
        if (cancelRef.current) break;
        status[i] = { status: "pushing", sha: null };
        setCommitStatus([...status]);
        try {
          const filesB64 = [];
          for (const item of execPlan[i].files) {
            const buf = await item.file.arrayBuffer();
            const targetPath = (bulkPrefix ? bulkPrefix.replace(/\/+$/, "") + "/" : "") + item.rel;
            filesB64.push({ path: targetPath, base64: bufToB64(buf) });
          }
          const out = await datedMultiCommit(token, repo.full_name, branch, parent, treeSha,
            filesB64, execPlan[i].message, author(), execPlan[i].dateISO, createRef);
          parent = out.commitSha;
          treeSha = out.treeSha;
          createRef = false;
          status[i] = { status: "done", sha: out.commitSha };
          setCommitStatus([...status]);
        } catch (e) {
          status[i] = { status: "failed", sha: null };
          setCommitStatus([...status]);
          throw new Error(`Stopped at commit ${i + 1}: ${e.message}`);
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      setRepoEmpty(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setBulkRunning(false);
      setBusy(false);
    }
  };

  // ---------- UI bits ----------
  const Node = ({ i }) => {
    const done = i < stepIndex, active = i === stepIndex;
    return (
      <div style={{ display: "flex", alignItems: "center", flex: "0 0 auto" }}>
        <div style={{ width: 14, height: 14, borderRadius: "50%",
          border: `2px solid ${done ? C.green : active ? C.amber : C.line}`,
          background: done ? C.green : active ? C.amber : "transparent",
          boxShadow: active ? `0 0 10px ${C.amber}66` : "none", transition: "all .3s" }} />
      </div>
    );
  };

  const Graph = () => (
    <div style={{ padding: "18px 20px 6px" }}>
      <div style={{ display: "flex", alignItems: "center" }}>
        {STEPS.map((s, i) => (
          <div key={s.id} style={{ display: "flex", alignItems: "center", flex: i ? 1 : "0 0 auto" }}>
            {i > 0 && <div style={{ flex: 1, height: 2, background: i <= stepIndex ? C.green : C.line, transition: "background .3s" }} />}
            <Node i={i} />
          </div>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
        {STEPS.map((s, i) => (
          <span key={s.id} style={{ fontSize: 11, color: i === stepIndex ? C.amber : i < stepIndex ? C.green : C.muted, letterSpacing: "0.08em" }}>{s.label}</span>
        ))}
      </div>
    </div>
  );

  const inputStyle = { width: "100%", boxSizing: "border-box", background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 8, color: C.text, padding: "13px 14px", fontSize: 15, fontFamily: "inherit", outline: "none" };
  const smallLabel = { fontSize: 11, color: C.muted, letterSpacing: "0.06em", display: "block", margin: "10px 0 5px" };
  const btnStyle = (primary = true) => ({ width: "100%", boxSizing: "border-box", padding: "14px", borderRadius: 8, border: primary ? "none" : `1px solid ${C.line}`, background: primary ? C.amber : "transparent", color: primary ? "#14161A" : C.text, fontSize: 15, fontWeight: 700, fontFamily: "inherit", cursor: "pointer", opacity: busy && !bulkRunning ? 0.6 : 1 });
  const rowStyle = { display: "flex", alignItems: "center", gap: 10, width: "100%", boxSizing: "border-box", textAlign: "left", background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, color: C.text, padding: "13px 14px", fontSize: 14, fontFamily: "inherit", cursor: "pointer", marginBottom: 8 };
  const segBtn = (active) => ({ flex: 1, padding: "11px", borderRadius: 8, border: `1px solid ${active ? C.amber : C.line}`, background: active ? `${C.amber}1A` : "transparent", color: active ? C.amber : C.muted, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" });

  // ---------- screens ----------
  let screen;

  if (step === "auth") {
    screen = (
      <div>
        <h1 style={{ fontSize: 22, margin: "10px 0 4px", color: C.text }}>git<span style={{ color: C.amber }}>·</span>push</h1>
        <p style={{ color: C.muted, fontSize: 13, lineHeight: 1.6, margin: "0 0 20px" }}>
          Commit and push to your GitHub repos from your phone. Paste a personal access token with <b style={{ color: C.text }}>repo</b> (or Contents read/write) scope.
        </p>
        <input style={inputStyle} type="password" placeholder="ghp_… or github_pat_…" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
        <div style={{ height: 12 }} />
        <button style={btnStyle()} onClick={connect} disabled={busy || !token.trim()}>{busy ? "connecting…" : "connect"}</button>
        <p style={{ color: C.muted, fontSize: 11.5, lineHeight: 1.6, marginTop: 16 }}>The token lives only in this page's memory — nothing is stored, and it is sent only to api.github.com.</p>
      </div>
    );
  } else if (step === "repos") {
    const filtered = repos.filter((r) => r.full_name.toLowerCase().includes(repoFilter.toLowerCase()));
    screen = (
      <div>
        <p style={{ color: C.muted, fontSize: 12, margin: "4px 0 12px" }}>signed in as <span style={{ color: C.green }}>{user?.login}</span> · pick a repo</p>
        <input style={{ ...inputStyle, marginBottom: 12 }} placeholder="filter repos…" value={repoFilter} onChange={(e) => setRepoFilter(e.target.value)} />
        {filtered.map((r) => (
          <button key={r.id} style={rowStyle} onClick={() => openRepo(r)} disabled={busy}>
            <span style={{ color: C.amber }}>▸</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.full_name}</span>
            {r.private && <span style={{ marginLeft: "auto", fontSize: 10, color: C.muted, border: `1px solid ${C.line}`, borderRadius: 4, padding: "2px 6px" }}>private</span>}
          </button>
        ))}
        {filtered.length === 0 && <p style={{ color: C.muted, fontSize: 13 }}>No repos match that filter.</p>}
      </div>
    );
  } else if (step === "files") {
    screen = (
      <div>
        <p style={{ color: C.muted, fontSize: 12, margin: "4px 0 10px", wordBreak: "break-all" }}>{repo.full_name} <span style={{ color: C.line }}>/</span> <span style={{ color: C.text }}>{path || "(root)"}</span></p>
        {repoEmpty && (
          <div style={{ border: `1px solid ${C.amber}`, background: `${C.amber}14`, color: C.amber, borderRadius: 8, padding: "10px 12px", fontSize: 12.5, lineHeight: 1.6, marginBottom: 12 }}>
            This repo is empty. Your first push — a new file or a folder — will create the <b>{branch}</b> branch and the initial commit.
          </div>
        )}
        {!repoEmpty && (
          <select style={{ ...inputStyle, marginBottom: 12 }} value={branch} onChange={(e) => changeBranch(e.target.value)}>
            {branches.map((b) => <option key={b} value={b}>⎇ {b}</option>)}
          </select>
        )}
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <button style={{ ...btnStyle(false), flex: 1 }} onClick={() => setStep("repos")} disabled={busy}>← repos</button>
          {path && <button style={{ ...btnStyle(false), flex: 1 }} onClick={upDir} disabled={busy}>↑ up</button>}
          <button style={{ ...btnStyle(false), flex: 1 }} onClick={newFile} disabled={busy}>+ new file</button>
        </div>
        <button style={{ ...btnStyle(true), marginBottom: 12 }} onClick={openBulk} disabled={busy}>⇪ push a folder (multi-commit)</button>
        {entries.map((e) => (
          <button key={e.sha + e.path} style={rowStyle} onClick={() => openEntry(e)} disabled={busy}>
            <span style={{ color: e.type === "dir" ? C.amber : C.muted }}>{e.type === "dir" ? "▸" : "·"}</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.name}</span>
          </button>
        ))}
        {repoEmpty && <p style={{ color: C.muted, fontSize: 12, marginTop: 4 }}>No files yet — add one above.</p>}
      </div>
    );
  } else if (step === "editor") {
    screen = (
      <div>
        {result && (
          <div style={{ border: `1px solid ${C.green}`, borderRadius: 8, padding: 16, marginBottom: 14, background: `${C.green}14` }}>
            <p style={{ color: C.green, fontSize: 14, fontWeight: 700, margin: 0 }}>✓ pushed to {branch}</p>
            <p style={{ color: C.muted, fontSize: 12, margin: "8px 0 0", wordBreak: "break-all" }}>{result.path} @ {result.sha.slice(0, 7)}</p>
            <a href={result.url} target="_blank" rel="noreferrer" style={{ color: C.amber, fontSize: 13, display: "inline-block", marginTop: 8 }}>view commit on GitHub →</a>
          </div>
        )}
        <input style={{ ...inputStyle, marginBottom: 10 }} value={filePath} onChange={(e) => setFilePath(e.target.value)} disabled={!!fileSha} placeholder="path/to/file.ext" />
        <textarea style={{ ...inputStyle, minHeight: 240, resize: "vertical", fontSize: 13, lineHeight: 1.55, marginBottom: 10 }} value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false} />
        <input style={{ ...inputStyle, marginBottom: 12 }} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="commit message" />
        <div style={{ border: `1px solid ${backdate ? C.amber : C.line}`, borderRadius: 8, padding: "12px 14px", marginBottom: 12, background: backdate ? `${C.amber}0D` : "transparent" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 14, cursor: "pointer" }}>
            <input type="checkbox" checked={backdate} onChange={(e) => setBackdate(e.target.checked)} style={{ width: 18, height: 18, accentColor: C.amber }} />
            backdate commit
          </label>
          {backdate && (
            <div>
              <span style={smallLabel}>commit date & time</span>
              <input style={inputStyle} type="datetime-local" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              <span style={smallLabel}>author name</span>
              <input style={inputStyle} value={authorName} onChange={(e) => setAuthorName(e.target.value)} />
              <span style={smallLabel}>author email</span>
              <input style={inputStyle} value={authorEmail} onChange={(e) => setAuthorEmail(e.target.value)} />
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button style={{ ...btnStyle(false), flex: 1 }} onClick={backToFiles} disabled={busy}>← files</button>
          <button style={{ ...btnStyle(true), flex: 2 }} onClick={commit} disabled={busy || (backdate && !startDate)}>{busy ? "pushing…" : fileSha ? "commit & push" : "create & push"}</button>
        </div>
      </div>
    );
  } else if (step === "bulk") {
    const F = bulkFiles.length;
    const M = plan.length;
    const done = commitStatus.filter((c) => c.status === "done").length;
    const allDone = M > 0 && done === M && !bulkRunning;
    const targetCapped = distMode === "target" && (parseInt(target) || 1) > F && F > 0;

    screen = (
      <div>
        <p style={{ color: C.muted, fontSize: 12, margin: "4px 0 12px", wordBreak: "break-all" }}>{repo.full_name} <span style={{ color: C.line }}>·</span> ⎇ {branch}</p>

        <input ref={dirInputRef} type="file" webkitdirectory="" directory="" multiple style={{ display: "none" }} onChange={pickFiles} />
        <input ref={filesInputRef} type="file" multiple style={{ display: "none" }} onChange={pickFiles} />
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          <button style={{ ...btnStyle(true), flex: 1 }} onClick={() => dirInputRef.current?.click()} disabled={busy}>select folder</button>
          <button style={{ ...btnStyle(false), flex: 1 }} onClick={() => filesInputRef.current?.click()} disabled={busy}>select files</button>
        </div>

        {F > 0 && (
          <div>
            <span style={smallLabel}>distribution</span>
            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
              <button style={segBtn(distMode === "perfile")} onClick={() => { setDistMode("perfile"); setAiMsgs(null); }}>one commit / file</button>
              <button style={segBtn(distMode === "target")} onClick={() => { setDistMode("target"); setAiMsgs(null); }}>target count</button>
            </div>

            {distMode === "target" && (
              <div>
                <span style={smallLabel}>number of commits</span>
                <input style={inputStyle} type="number" min="1" value={target} onChange={(e) => { setTarget(e.target.value); setAiMsgs(null); }} />
                <p style={{ fontSize: 11, color: targetCapped ? C.amber : C.muted, lineHeight: 1.6, margin: "6px 0 0" }}>
                  {F} files → {M} commit{M > 1 ? "s" : ""} · ~{(F / M).toFixed(1)} files each
                  {targetCapped ? ` (capped to ${F}; can't exceed file count)` : ""}
                </p>
              </div>
            )}

            <span style={smallLabel}>target folder in repo (blank = root)</span>
            <input style={{ ...inputStyle, marginBottom: 10 }} value={bulkPrefix} onChange={(e) => setBulkPrefix(e.target.value)} placeholder="e.g. src/assets" />

            {distMode === "perfile" && (
              <div>
                <span style={smallLabel}>message template ({"{file}"} = filename)</span>
                <input style={{ ...inputStyle, marginBottom: 6 }} value={perFileTpl} onChange={(e) => setPerFileTpl(e.target.value)} />
              </div>
            )}

            <button style={{ ...btnStyle(false), borderColor: C.amber, color: C.amber, marginBottom: 4 }} onClick={genMessages} disabled={genning || busy || M === 0}>
              {genning ? "refining…" : aiMsgs ? "✨ refine again with AI" : "✨ refine with AI (optional)"}
            </button>
            <p style={{ fontSize: 11, color: C.muted, lineHeight: 1.6, margin: "0 0 12px" }}>
              Messages below are ready to push as-is. AI refine is optional and needs a key configured.
            </p>

            <div style={{ border: `1px solid ${backdate ? C.amber : C.line}`, borderRadius: 8, padding: "12px 14px", marginBottom: 12, background: backdate ? `${C.amber}0D` : "transparent" }}>
              <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 14, cursor: "pointer" }}>
                <input type="checkbox" checked={backdate} onChange={(e) => setBackdate(e.target.checked)} style={{ width: 18, height: 18, accentColor: C.amber }} />
                backdate commits
              </label>
              {backdate && (
                <div>
                  {distMode === "target" ? (
                    <div>
                      <span style={smallLabel}>start date & time</span>
                      <input style={inputStyle} type="datetime-local" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
                      <span style={smallLabel}>end date & time</span>
                      <input style={inputStyle} type="datetime-local" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
                      <p style={{ fontSize: 11, color: C.muted, lineHeight: 1.6, margin: "8px 0 0" }}>Commits are spread evenly across this range.</p>
                    </div>
                  ) : (
                    <div>
                      <span style={smallLabel}>first commit date & time</span>
                      <input style={inputStyle} type="datetime-local" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
                      <span style={smallLabel}>minutes between commits</span>
                      <input style={inputStyle} type="number" min="0" value={gapMin} onChange={(e) => setGapMin(e.target.value)} />
                    </div>
                  )}
                  <span style={smallLabel}>author name</span>
                  <input style={inputStyle} value={authorName} onChange={(e) => setAuthorName(e.target.value)} />
                  <span style={smallLabel}>author email</span>
                  <input style={inputStyle} value={authorEmail} onChange={(e) => setAuthorEmail(e.target.value)} />
                  <p style={{ fontSize: 11, color: C.muted, lineHeight: 1.6, margin: "10px 0 0" }}>Email must be verified on your GitHub account to count on the contribution graph.</p>
                </div>
              )}
            </div>

            {/* plan preview / progress */}
            {M > 0 && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                  <span style={{ fontSize: 12, color: C.muted }}>{M} commit{M > 1 ? "s" : ""} planned</span>
                  {commitStatus.length > 0 && <span style={{ fontSize: 12, color: allDone ? C.green : C.amber }}>{done}/{M}</span>}
                </div>
                {commitStatus.length > 0 && (
                  <div style={{ height: 4, background: C.line, borderRadius: 2, marginBottom: 10 }}>
                    <div style={{ height: 4, width: `${(done / M) * 100}%`, background: allDone ? C.green : C.amber, borderRadius: 2, transition: "width .3s" }} />
                  </div>
                )}
                <div style={{ maxHeight: 240, overflowY: "auto", border: `1px solid ${C.line}`, borderRadius: 8 }}>
                  {plan.map((c, i) => {
                    const st = commitStatus[i]?.status;
                    const mark = st === "done" ? "✓" : st === "failed" ? "✗" : st === "pushing" ? "…" : "·";
                    const col = st === "done" ? C.green : st === "failed" ? C.red : st === "pushing" ? C.amber : C.muted;
                    return (
                      <div key={i} style={{ padding: "9px 12px", borderBottom: i < M - 1 ? `1px solid ${C.line}` : "none", fontSize: 12 }}>
                        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                          <span style={{ color: col, flex: "0 0 auto" }}>{mark}</span>
                          <span style={{ color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.message}</span>
                          {commitStatus[i]?.sha && <span style={{ marginLeft: "auto", color: C.muted, flex: "0 0 auto" }}>{commitStatus[i].sha.slice(0, 7)}</span>}
                        </div>
                        <div style={{ color: C.muted, fontSize: 10.5, marginTop: 3, paddingLeft: 18 }}>
                          {c.files.length} file{c.files.length > 1 ? "s" : ""}{c.dateISO ? ` · ${new Date(c.dateISO).toLocaleString()}` : ""}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {allDone && (
              <div style={{ border: `1px solid ${C.green}`, borderRadius: 8, padding: 14, marginBottom: 12, background: `${C.green}14` }}>
                <p style={{ color: C.green, fontSize: 14, fontWeight: 700, margin: 0 }}>✓ {M} commits pushed to {branch}</p>
                <a href={`https://github.com/${repo.full_name}/commits/${branch}`} target="_blank" rel="noreferrer" style={{ color: C.amber, fontSize: 13, display: "inline-block", marginTop: 8 }}>view commit history →</a>
              </div>
            )}
          </div>
        )}

        {F === 0 && <p style={{ fontSize: 12, color: C.muted, lineHeight: 1.6 }}>Pick a folder or files to begin. .git, node_modules, build dirs and files over 5MB are skipped automatically.</p>}

        <div style={{ display: "flex", gap: 8 }}>
          <button style={{ ...btnStyle(false), flex: 1 }} onClick={() => { cancelRef.current = true; setStep("files"); }} disabled={bulkRunning}>← files</button>
          {bulkRunning ? (
            <button style={{ ...btnStyle(false), flex: 2, borderColor: C.red, color: C.red }} onClick={() => (cancelRef.current = true)}>stop after current</button>
          ) : (
            <button style={{ ...btnStyle(true), flex: 2 }} onClick={runBulk} disabled={busy || M === 0 || allDone || (backdate && !startDate) || (backdate && distMode === "target" && !endDate)}>
              push {M || ""} commit{M === 1 ? "" : "s"}
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
          {error && <div style={{ border: `1px solid ${C.red}`, background: `${C.red}14`, color: C.red, borderRadius: 8, padding: "10px 12px", fontSize: 13, marginBottom: 14, wordBreak: "break-word" }}>{error}</div>}
          {screen}
        </div>
      </div>
    </div>
  );
}
