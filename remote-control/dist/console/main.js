// console/src/main.ts
var params = new URLSearchParams(window.location.search);
var token = params.get("token") ?? "";
var workspaceId = params.get("workspaceId") ?? "";
async function api(path, init) {
  const res = await fetch(`${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${text}`.trim());
  }
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return res.json();
  return res.text();
}
var modalRoot = document.getElementById("modal-root");
function openModal(content) {
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
function field(label, input2) {
  const wrap = document.createElement("div");
  wrap.className = "field";
  const l = document.createElement("label");
  l.textContent = label;
  wrap.append(l, input2);
  return wrap;
}
function input(value = "", type = "text", placeholder = "") {
  const el = document.createElement("input");
  el.type = type;
  el.value = value;
  el.placeholder = placeholder;
  return el;
}
var state = {
  view: "terminals",
  terminals: [],
  connections: [],
  groups: [],
  notice: null
};
var NAV = [
  { id: "terminals", label: "Terminals" },
  { id: "connections", label: "Connections" },
  { id: "settings", label: "Settings" }
];
function renderNav() {
  const nav = document.getElementById("nav");
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
function render() {
  renderNav();
  const main = document.getElementById("main");
  main.replaceChildren();
  const h1 = document.createElement("h1");
  h1.textContent = NAV.find((n) => n.id === state.view)?.label ?? "";
  main.append(h1);
  const view = VIEWS[state.view];
  if (view) view(main);
}
async function refreshTerminals() {
  try {
    const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
    const body = await api(`/api/terminals${query}`);
    state.terminals = body.terminals ?? [];
    if (state.view === "terminals") render();
  } catch (e) {
    console.error(e);
  }
}
function terminalsView(main) {
  const row = document.createElement("div");
  row.className = "row";
  const hint = document.createElement("span");
  hint.className = "muted";
  hint.textContent = workspaceId ? `Workspace ${workspaceId} \u2014 terminals are Paseo workspace tabs; open an SSH session from Connections.` : "Terminals are Paseo workspace tabs; open an SSH session from Connections.";
  row.append(hint);
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
function openConnectionForm(initial) {
  const isNew = initial === null;
  const nameI = input(initial?.name ?? "", "text", "name");
  const hostI = input(initial?.host ?? "", "text", "host");
  const portI = input(initial?.port ? String(initial.port) : "", "text", "port (empty=default)");
  const userI = input(initial?.username ?? "", "text", "username");
  const passI = input(
    "",
    "password",
    isNew ? "password (stored in the secret storage)" : "new password (empty = keep current)"
  );
  const protoI = document.createElement("select");
  for (const p of ["ssh", "rdp", "vnc"]) {
    const o = document.createElement("option");
    o.value = p;
    o.textContent = p.toUpperCase();
    if (initial && initial.protocol === p) o.selected = true;
    protoI.append(o);
  }
  const groupI = document.createElement("select");
  const noneOpt = document.createElement("option");
  noneOpt.value = "";
  noneOpt.textContent = "(root)";
  groupI.append(noneOpt);
  for (const g of state.groups) {
    const o = document.createElement("option");
    o.value = g.id;
    o.textContent = g.name;
    if (initial && initial.groupId === g.id) o.selected = true;
    groupI.append(o);
  }
  openModal((close) => {
    const m = document.createElement("div");
    m.innerHTML = `<h3>${isNew ? "New connection" : "Edit connection"}</h3>`;
    const err = document.createElement("p");
    err.style.color = "#ef4444";
    err.style.fontSize = "0.85rem";
    err.style.display = "none";
    m.append(
      field("Group", groupI),
      field("Name", nameI),
      field("Protocol", protoI),
      field("Host", hostI),
      field("Port", portI),
      field("Username", userI),
      field(isNew ? "Password" : "New password", passI),
      err
    );
    const actions = document.createElement("div");
    actions.className = "actions";
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", close);
    const ok = document.createElement("button");
    ok.className = "primary";
    ok.textContent = isNew ? "Create" : "Save";
    ok.addEventListener("click", async () => {
      try {
        const port = portI.value.trim() === "" ? null : Number(portI.value);
        const body = {
          groupId: groupI.value || null,
          name: nameI.value,
          protocol: protoI.value,
          host: hostI.value,
          port,
          username: userI.value
        };
        if (passI.value !== "") {
          body.password = passI.value;
        }
        if (isNew) {
          await api("/api/connections", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
          });
        } else {
          await api(`/api/connections/${encodeURIComponent(initial.id)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
          });
        }
        close();
        await refreshConnections();
      } catch (e) {
        err.textContent = String(e);
        err.style.display = "";
      }
    });
    actions.append(cancel, ok);
    m.append(actions);
    return m;
  });
}
async function refreshConnections() {
  try {
    const groups = await api("/api/groups");
    const conns = await api("/api/connections");
    state.groups = groups.groups ?? [];
    state.connections = conns.connections ?? [];
    if (state.view === "connections") render();
  } catch (e) {
    console.error(e);
  }
}
function connectionsView(main) {
  const row = document.createElement("div");
  row.className = "row";
  if (state.notice) {
    const notice = document.createElement("p");
    notice.className = "muted";
    notice.textContent = state.notice;
    main.append(notice);
  }
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
  newConnBtn.addEventListener("click", () => openConnectionForm(null));
  row.append(newGroupBtn, newConnBtn);
  row.append(openExportButton(), openImportButton());
  main.append(row);
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
            body: JSON.stringify({ connectionId: c.id, workspaceId: workspaceId || null })
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
    const editBtn = document.createElement("button");
    editBtn.textContent = "edit";
    editBtn.addEventListener("click", () => openConnectionForm(c));
    actions.append(editBtn);
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
function openExportButton() {
  const btn = document.createElement("button");
  btn.textContent = "Export";
  btn.addEventListener("click", () => {
    const passI = input("", "password", "passphrase to seal the file (optional)");
    openModal((close) => {
      const m = document.createElement("div");
      m.innerHTML = "<h3>Export connections</h3>";
      const note = document.createElement("p");
      note.className = "muted";
      note.textContent = "Downloads every group, connection and stored password. With a passphrase the file is encrypted; without one the passwords are readable by anyone holding the file.";
      const err = document.createElement("p");
      err.style.color = "#ef4444";
      err.style.fontSize = "0.85rem";
      err.style.display = "none";
      m.append(note, field("Passphrase", passI), err);
      const actions = document.createElement("div");
      actions.className = "actions";
      const cancel = document.createElement("button");
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", close);
      const ok = document.createElement("button");
      ok.className = "primary";
      ok.textContent = "Download";
      ok.addEventListener("click", async () => {
        try {
          const res = await fetch(`/api/export?token=${encodeURIComponent(token)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ passphrase: passI.value })
          });
          if (!res.ok) throw new Error(`${res.status} ${await res.text()}`.trim());
          const disposition = res.headers.get("content-disposition") ?? "";
          const match = /filename="([^"]+)"/.exec(disposition);
          const filename = match?.[1] ?? "remote-control-export.json";
          const text = await res.text();
          const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
          const a = document.createElement("a");
          a.href = url;
          a.download = filename;
          a.click();
          URL.revokeObjectURL(url);
          close();
        } catch (e) {
          err.textContent = String(e);
          err.style.display = "";
        }
      });
      actions.append(cancel, ok);
      m.append(actions);
      return m;
    });
  });
  return btn;
}
function openImportButton() {
  const btn = document.createElement("button");
  btn.textContent = "Import";
  const picker = document.createElement("input");
  picker.type = "file";
  picker.accept = ".json,application/json";
  picker.style.display = "none";
  picker.addEventListener("change", () => {
    const file = picker.files?.[0];
    picker.value = "";
    if (!file) return;
    void file.text().then((text) => importModal(file.name, text));
  });
  btn.addEventListener("click", () => picker.click());
  btn.after(picker);
  return btn;
}
function importModal(filename, fileText) {
  const modeI = document.createElement("select");
  for (const [value, label] of [
    ["merge", "Merge \u2014 keep existing, update matches"],
    ["replace", "Replace \u2014 wipe connections and groups first"]
  ]) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    modeI.append(o);
  }
  const passI = input("", "password", "passphrase (only if the file is sealed)");
  openModal((close) => {
    const m = document.createElement("div");
    m.innerHTML = "<h3>Import connections</h3>";
    const note = document.createElement("p");
    note.className = "muted";
    note.textContent = `File: ${filename}. Stored passwords come back with the connections; the secret storage must be open.`;
    const err = document.createElement("p");
    err.style.color = "#ef4444";
    err.style.fontSize = "0.85rem";
    err.style.display = "none";
    m.append(note, field("Mode", modeI), field("Passphrase", passI), err);
    const actions = document.createElement("div");
    actions.className = "actions";
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", close);
    const ok = document.createElement("button");
    ok.className = "primary";
    ok.textContent = "Import";
    ok.addEventListener("click", async () => {
      try {
        const body = JSON.stringify({ file: fileText, mode: modeI.value, passphrase: passI.value });
        const report = await api("/api/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body
        });
        state.notice = `Import (${report.mode}): ${report.connections.created} created, ${report.connections.updated} updated, ${report.groups.created} groups created, ${report.groups.reused} reused, ${report.passwords} passwords restored.`;
        close();
        await refreshConnections();
      } catch (e) {
        err.textContent = String(e);
        err.style.display = "";
      }
    });
    actions.append(cancel, ok);
    m.append(actions);
    return m;
  });
}
function settingsView(main) {
  const card = document.createElement("div");
  card.className = "card";
  const status = document.createElement("pre");
  status.textContent = "loading\u2026";
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
  let lastSettings = {};
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
var VIEWS = {
  terminals: terminalsView,
  connections: connectionsView,
  settings: settingsView
};
function startLiveUpdates() {
  try {
    new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  } catch {
  }
  setInterval(() => {
    if (state.view === "terminals") void refreshTerminals();
  }, 3e3);
}
render();
void refreshTerminals();
void refreshConnections();
startLiveUpdates();
