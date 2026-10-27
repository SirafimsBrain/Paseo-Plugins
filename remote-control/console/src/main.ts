const params = new URLSearchParams(window.location.search);
let token = params.get("token") ?? "";
// The opener (Paseo panel/screen) passes the workspace it opened the console
// from; terminals created here become tabs of that workspace.
const workspaceId = params.get("workspaceId") ?? "";

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${text}`.trim());
  }
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return res.json();
  return res.text();
}

// ---------- modal ----------
const modalRoot = document.getElementById("modal-root")!;

function openModal(content: (close: () => void) => HTMLElement): void {
  modalRoot.classList.remove("hidden");
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  const close = () => {
    modalRoot.classList.add("hidden");
    modalRoot.replaceChildren();
  };
  const modal = content(close);
  modal.className = "modal";
  backdrop.append(modal);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  modalRoot.append(backdrop);
}

function field(label: string, input: HTMLElement): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "field";
  const l = document.createElement("label");
  l.textContent = label;
  wrap.append(l, input);
  return wrap;
}

function input(value = "", type = "text", placeholder = ""): HTMLInputElement {
  const el = document.createElement("input");
  el.type = type;
  el.value = value;
  el.placeholder = placeholder;
  return el;
}

// ---------- state ----------
const state = {
  view: "terminals" as string,
  terminals: [] as any[],
  connections: [] as any[],
  groups: [] as any[],
  notice: null as string | null,
};

// ---------- nav ----------
const NAV = [
  { id: "terminals", label: "Terminals" },
  { id: "connections", label: "Connections" },
  { id: "secrets", label: "Secrets" },
  { id: "settings", label: "Settings" },
];

function renderNav(): void {
  const nav = document.getElementById("nav")!;
  nav.replaceChildren();
  for (const item of NAV) {
    const btn = document.createElement("button");
    btn.textContent = item.label;
    if (item.id === state.view) btn.classList.add("active");
    btn.addEventListener("click", () => {
      state.view = item.id;
      render();
    });
    nav.append(btn);
  }
}

function render(): void {
  renderNav();
  const main = document.getElementById("main")!;
  main.replaceChildren();
  const h1 = document.createElement("h1");
  h1.textContent = NAV.find((n) => n.id === state.view)?.label ?? "";
  main.append(h1);
  const view = VIEWS[state.view];
  if (view) view(main);
}

// ---------- terminals view ----------
async function refreshTerminals(): Promise<void> {
  try {
    const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
    const body = await api(`/api/terminals${query}`);
    state.terminals = body.terminals ?? [];
    if (state.view === "terminals") render();
  } catch (e) {
    console.error(e);
  }
}

function terminalsView(main: HTMLElement): void {
  const row = document.createElement("div");
  row.className = "row";
  const newBtn = document.createElement("button");
  newBtn.className = "primary";
  newBtn.textContent = "New terminal";
  newBtn.addEventListener("click", async () => {
    try {
      const res = await api("/api/terminals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: workspaceId || null }),
      });
      state.notice = `Terminal ${res.terminal.id} opened as a workspace tab in Paseo.`;
    } catch (e) {
      state.notice = String(e);
    }
    render();
    await refreshTerminals();
  });
  const hint = document.createElement("span");
  hint.className = "muted";
  hint.textContent = workspaceId
    ? `Workspace ${workspaceId} — new terminals open as tabs in Paseo.`
    : "New terminals open as tabs in Paseo.";
  row.append(newBtn, hint);
  main.append(row);

  if (state.notice) {
    const notice = document.createElement("p");
    notice.className = "muted";
    notice.textContent = state.notice;
    main.append(notice);
  }

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  thead.innerHTML = "<tr><th>ID</th><th>Name</th><th>Kind</th><th>CWD</th><th>Started</th><th>Actions</th></tr>";
  table.append(thead);
  const tbody = document.createElement("tbody");
  for (const t of state.terminals) {
    const tr = document.createElement("tr");
    const started = t.startedAt ? new Date(t.startedAt).toLocaleTimeString() : "-";
    tr.innerHTML = `<td class="mono">${t.id}</td><td>${t.name}</td><td>${t.kind}</td><td class="mono">${t.cwd || "-"}</td><td>${started}</td>`;
    const actions = document.createElement("td");
    const killBtn = document.createElement("button");
    killBtn.className = "danger";
    killBtn.textContent = "kill";
    killBtn.addEventListener("click", async () => {
      await api(`/api/terminals/${encodeURIComponent(t.id)}/kill`, { method: "POST" });
      await refreshTerminals();
    });
    actions.append(killBtn);
    tr.append(actions);
    tbody.append(tr);
  }
  table.append(tbody);
  main.append(table);
  if (state.terminals.length === 0) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "No terminals yet.";
    main.append(p);
  }
}

// ---------- connections view ----------
async function refreshConnections(): Promise<void> {
  try {
    const groups = await api("/api/groups");
    const conns = await api("/api/connections");
    state.groups = groups.groups ?? [];
    state.connections = conns.connections ?? [];
    if (state.view === "connections") render();
  } catch (e) { console.error(e); }
}

function connectionsView(main: HTMLElement): void {
  const row = document.createElement("div");
  row.className = "row";
  const newGroupBtn = document.createElement("button");
  newGroupBtn.textContent = "New group";
  newGroupBtn.addEventListener("click", () => {
    const nameInput = input("", "text", "group name");
    openModal((close) => {
      const m = document.createElement("div");
      m.innerHTML = "<h3>New group</h3>";
      m.append(field("Name", nameInput));
      const actions = document.createElement("div");
      actions.className = "actions";
      const cancel = document.createElement("button");
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", close);
      const ok = document.createElement("button");
      ok.className = "primary";
      ok.textContent = "Create";
      ok.addEventListener("click", async () => {
        await api("/api/groups", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: nameInput.value }) });
        close();
        await refreshConnections();
      });
      actions.append(cancel, ok);
      m.append(actions);
      return m;
    });
  });
  const newConnBtn = document.createElement("button");
  newConnBtn.className = "primary";
  newConnBtn.textContent = "New connection";
  newConnBtn.addEventListener("click", () => {
    const nameI = input("", "text", "name");
    const hostI = input("", "text", "host");
    const portI = input("", "text", "port (empty=default)");
    const userI = input("", "text", "username");
    const protoI = document.createElement("select");
    for (const p of ["ssh", "rdp", "vnc"]) {
      const o = document.createElement("option");
      o.value = p; o.textContent = p.toUpperCase();
      protoI.append(o);
    }
    const groupI = document.createElement("select");
    const noneOpt = document.createElement("option");
    noneOpt.value = ""; noneOpt.textContent = "(root)";
    groupI.append(noneOpt);
    for (const g of state.groups) {
      const o = document.createElement("option");
      o.value = g.id; o.textContent = g.name;
      groupI.append(o);
    }
    openModal((close) => {
      const m = document.createElement("div");
      m.innerHTML = "<h3>New connection</h3>";
      m.append(
        field("Group", groupI),
        field("Name", nameI),
        field("Protocol", protoI),
        field("Host", hostI),
        field("Port", portI),
        field("Username", userI),
      );
      const actions = document.createElement("div");
      actions.className = "actions";
      const cancel = document.createElement("button");
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", close);
      const ok = document.createElement("button");
      ok.className = "primary";
      ok.textContent = "Create";
      ok.addEventListener("click", async () => {
        const port = portI.value.trim() === "" ? null : Number(portI.value);
        await api("/api/connections", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            groupId: groupI.value || null,
            name: nameI.value,
            protocol: protoI.value,
            host: hostI.value,
            port,
            username: userI.value,
          }),
        });
        close();
        await refreshConnections();
      });
      actions.append(cancel, ok);
      m.append(actions);
      return m;
    });
  });
  row.append(newGroupBtn, newConnBtn);
  main.append(row);

  // Groups
  if (state.groups.length > 0) {
    const glist = document.createElement("ul");
    glist.style.listStyle = "none";
    glist.style.padding = "0";
    for (const g of state.groups) {
      const li = document.createElement("li");
      li.className = "mono";
      li.textContent = `${g.name} (${g.id})`;
      glist.append(li);
    }
    main.append(glist);
  }

  // Connections table
  const table = document.createElement("table");
  table.innerHTML = "<thead><tr><th>Name</th><th>Protocol</th><th>Target</th><th>Actions</th></tr></thead>";
  const tbody = document.createElement("tbody");
  for (const c of state.connections) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${c.name}</td><td>${c.protocol}</td><td class="mono">${c.username ? c.username + "@" : ""}${c.host}${c.port ? ":" + c.port : ""}</td>`;
    const actions = document.createElement("td");
    if (c.protocol === "ssh") {
      const launchBtn = document.createElement("button");
      launchBtn.className = "primary";
      launchBtn.textContent = "Launch";
      launchBtn.addEventListener("click", async () => {
        try {
          const res = await api("/api/terminals", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ connectionId: c.id, workspaceId: workspaceId || null }),
          });
          state.notice = `SSH session opened as terminal tab ${res.terminal.id} in Paseo.`;
        } catch (e) {
          state.notice = String(e);
        }
        state.view = "terminals";
        await refreshTerminals();
        render();
      });
      actions.append(launchBtn);
    }
    const delBtn = document.createElement("button");
    delBtn.className = "danger";
    delBtn.textContent = "delete";
    delBtn.addEventListener("click", async () => {
      await api(`/api/connections/${encodeURIComponent(c.id)}`, { method: "DELETE" });
      await refreshConnections();
    });
    actions.append(delBtn);
    tr.append(actions);
    tbody.append(tr);
  }
  table.append(tbody);
  main.append(table);
  if (state.connections.length === 0) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "No connections yet.";
    main.append(p);
  }
}

// ---------- secrets view ----------
async function refreshSecrets(): Promise<void> {
  // no-op placeholder; secrets view fetches on render
}

function secretsView(main: HTMLElement): void {
  const statusRow = document.createElement("div");
  statusRow.className = "row";
  const statusBtn = document.createElement("button");
  statusBtn.textContent = "Refresh status";
  const lockBtn = document.createElement("button");
  lockBtn.textContent = "Lock";
  lockBtn.addEventListener("click", async () => {
    await api("/api/vault/lock", { method: "POST" });
    render();
  });
  statusRow.append(statusBtn, lockBtn);
  main.append(statusRow);

  const result = document.createElement("pre");
  result.id = "secret-result";
  main.append(result);

  void (async () => {
    try {
      const vs = await api("/api/vault/status");
      result.textContent = JSON.stringify(vs, null, 2);
    } catch (e) {
      result.textContent = String(e);
    }
  })();

  const newBtn = document.createElement("button");
  newBtn.className = "primary";
  newBtn.textContent = "New secret";
  newBtn.addEventListener("click", () => {
    const nameI = input("", "text", "secret name");
    const valueI = input("", "text", "secret value");
    const pwI = input("", "password", "master password (if locked)");
    openModal((close) => {
      const m = document.createElement("div");
      m.innerHTML = "<h3>New secret</h3>";
      m.append(field("Name", nameI), field("Value", valueI), field("Master password (setup/unlock if needed)", pwI));
      const actions = document.createElement("div");
      actions.className = "actions";
      const cancel = document.createElement("button");
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", close);
      const ok = document.createElement("button");
      ok.className = "primary";
      ok.textContent = "Save";
      ok.addEventListener("click", async () => {
        // ensure unlocked
        let vs = await api("/api/vault/status");
        if (!vs.initialized) {
          await api("/api/vault/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pwI.value }) });
          await api("/api/vault/unlock", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pwI.value }) });
        } else if (!vs.unlocked) {
          await api("/api/vault/unlock", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pwI.value }) });
        }
        await api("/api/secrets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: nameI.value, value: valueI.value }) });
        close();
        render();
      });
      actions.append(cancel, ok);
      m.append(actions);
      return m;
    });
  });
  main.append(newBtn);

  // list
  void (async () => {
    try {
      const vs = await api("/api/vault/status");
      if (!vs.unlocked) return;
      const body = await api("/api/secrets");
      const list = document.createElement("ul");
      list.style.listStyle = "none";
      list.style.padding = "0";
      for (const name of body.names ?? []) {
        const li = document.createElement("li");
        li.className = "row";
        const span = document.createElement("span");
        span.className = "mono";
        span.textContent = name;
        const viewBtn = document.createElement("button");
        viewBtn.textContent = "view";
        viewBtn.addEventListener("click", async () => {
          const r = await api(`/api/secrets/${encodeURIComponent(name)}`);
          result.textContent = `${name} = ${r.value}`;
        });
        const delBtn = document.createElement("button");
        delBtn.className = "danger";
        delBtn.textContent = "delete";
        delBtn.addEventListener("click", async () => {
          await api(`/api/secrets/${encodeURIComponent(name)}`, { method: "DELETE" });
          render();
        });
        li.append(span, viewBtn, delBtn);
        list.append(li);
      }
      main.append(list);
    } catch (e) {
      console.error(e);
    }
  })();
}

// ---------- settings view ----------
function settingsView(main: HTMLElement): void {
  const card = document.createElement("div");
  card.className = "card";
  const status = document.createElement("pre");
  status.textContent = "loading…";
  card.append(status);
  main.append(card);

  void (async () => {
    try {
      const vs = await api("/api/vault/status");
      status.textContent = JSON.stringify({ vault: vs, terminals: state.terminals.length }, null, 2);
    } catch (e) {
      status.textContent = String(e);
    }
  })();

  // Ghostty import
  const gcard = document.createElement("div");
  gcard.className = "card";
  gcard.innerHTML = "<h2>Ghostty settings import</h2>";
  const previewBtn = document.createElement("button");
  previewBtn.textContent = "Preview import";
  const applyBtn = document.createElement("button");
  applyBtn.className = "primary";
  applyBtn.textContent = "Apply";
  applyBtn.disabled = true;
  const gresult = document.createElement("pre");
  gcard.append(previewBtn, applyBtn, gresult);
  main.append(gcard);

  let lastSettings: unknown = {};
  previewBtn.addEventListener("click", async () => {
    const preview = await api("/api/ghostty/import");
    gresult.textContent = JSON.stringify(preview, null, 2);
    lastSettings = preview.settings;
    applyBtn.disabled = !preview.found;
  });
  applyBtn.addEventListener("click", async () => {
    const r = await api("/api/ghostty/import/apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ settings: lastSettings }) });
    gresult.textContent = JSON.stringify(r, null, 2);
  });
}

const VIEWS: Record<string, (m: HTMLElement) => void> = {
  terminals: terminalsView,
  connections: connectionsView,
  secrets: secretsView,
  settings: settingsView,
};

// ---------- SSE + polling ----------
function startLiveUpdates(): void {
  try {
    new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  } catch {
    // ignore
  }
  // Terminal state lives in the Paseo daemon, so this view polls it.
  setInterval(() => {
    if (state.view === "terminals") void refreshTerminals();
  }, 3000);
}

// ---------- init ----------
render();
void refreshTerminals();
void refreshConnections();
startLiveUpdates();
