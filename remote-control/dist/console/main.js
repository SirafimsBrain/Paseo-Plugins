// shared/naming.ts
function copyNameRoot(name) {
  return name.replace(/_copy\d*$/, "");
}
function nextCopyName(name, taken) {
  const used = new Set(taken);
  used.add(name);
  const root = copyNameRoot(name);
  let candidate = `${root}_copy`;
  let n = 1;
  while (used.has(candidate)) {
    candidate = `${root}_copy${n}`;
    n += 1;
  }
  return candidate;
}

// shared/rdp-fields.ts
var RDP_CHOICES = {
  bpp: [
    ["8", "8-bit (256 colors)"],
    ["15", "15-bit (32K)"],
    ["16", "16-bit (65K)"],
    ["24", "24-bit (16M)"],
    ["32", "32-bit (16M+)"]
  ],
  sec: [
    ["", "Automatic"],
    ["rdp", "RDP (Standard RDP Security)"],
    ["tls", "TLS (TLS Encryption)"],
    ["nla", "NLA (Network Level Authentication)"],
    ["ext", "NLA Extended"]
  ],
  gdi: [
    ["", "Default"],
    ["sw", "Software GDI"],
    ["hw", "Hardware GDI"]
  ],
  kbdType: [
    ["", "Automatic"],
    ["4", "IBM PC/XT (83-key)"],
    ["7", "IBM PC/AT (84-key)"],
    ["8", "IBM PC/AT 101/102 (Enhanced)"],
    ["12", "IBM ThinkPad"],
    ["15", "Nokia 9000/9210"],
    ["16", "Windows Mobile/Pocket PC"]
  ],
  network: [
    ["", "Automatic"],
    ["modem", "Modem (56 Kbps)"],
    ["broadband-low", "Broadband-Low (256 Kbps - 2 Mbps)"],
    ["broadband-high", "Broadband-High (2-10 Mbps)"],
    ["wan", "WAN (10+ Mbps)"],
    ["lan", "LAN (100+ Mbps)"]
  ],
  sound: [
    ["0", "Play on this computer"],
    ["1", "Play on remote computer"],
    ["2", "Do not play"]
  ],
  jpegQuality: [
    ["", "Default"],
    ["50", "50 - Low quality / small size"],
    ["60", "60"],
    ["70", "70"],
    ["75", "75 - Normal"],
    ["80", "80"],
    ["85", "85"],
    ["90", "90 - High quality"],
    ["95", "95"],
    ["100", "100 - Maximum quality / large size"]
  ]
};
var RDP_PAYLOAD_DEFAULTS = {
  dynamicResolution: true,
  width: 1280,
  height: 720,
  fullscreen: false,
  bpp: "24",
  fonts: true,
  aero: false,
  windowDrag: false,
  menuAnims: false,
  themes: false,
  wallpaper: false,
  clipboard: true,
  drives: false,
  homeDrive: false,
  printers: false,
  smartcards: false,
  sound: "0",
  microphone: false,
  compression: true,
  rfx: false,
  nsc: false,
  jpeg: false
};

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
function selectEl(options, value) {
  const el = document.createElement("select");
  for (const [v, text] of options) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = text;
    if (v === value) o.selected = true;
    el.append(o);
  }
  return el;
}
function checkField(label, checked) {
  const wrap = document.createElement("label");
  wrap.className = "check";
  const el = document.createElement("input");
  el.type = "checkbox";
  el.checked = checked;
  wrap.append(el, document.createTextNode(label));
  return [wrap, el];
}
function rdpForm(initial) {
  const stored = initial && initial.protocol === "rdp" && initial.payload ? initial.payload : {};
  const base = { ...RDP_PAYLOAD_DEFAULTS, ...stored };
  const has = (k) => base[k] !== void 0 && base[k] !== null;
  const bools = [];
  const strs = [];
  const selects = [];
  const adv = document.createElement("details");
  adv.className = "rdp-advanced";
  const summary = document.createElement("summary");
  summary.textContent = "Advanced (RDP)";
  adv.append(summary);
  const group = (title) => {
    const h = document.createElement("p");
    h.className = "rdp-group";
    h.textContent = title;
    adv.append(h);
  };
  const addCheck = (label, key, fallback = false) => {
    const [row, el] = checkField(label, has(key) ? base[key] === true : fallback);
    bools.push([key, el]);
    adv.append(row);
  };
  const addText = (label, key, placeholder) => {
    const el = input(has(key) ? String(base[key]) : "", "text", placeholder);
    strs.push([key, el]);
    adv.append(field(label, el));
    return el;
  };
  const addSelect = (label, key, choices, fallback = "") => {
    const el = selectEl(choices, has(key) ? String(base[key]) : fallback);
    selects.push([key, el]);
    adv.append(field(label, el));
  };
  const domainI = input(has("domain") ? String(base.domain) : "", "text", "Windows domain (optional)");
  strs.push(["domain", domainI]);
  group("Display");
  const [fullRow, fullI] = checkField("Fullscreen", base.fullscreen === true);
  bools.push(["fullscreen", fullI]);
  const [dynRow, dynI] = checkField("Dynamic resolution", base.dynamicResolution !== false);
  bools.push(["dynamicResolution", dynI]);
  adv.append(fullRow, dynRow);
  const widthI = input(has("width") ? String(base.width) : "", "number", "width");
  const heightI = input(has("height") ? String(base.height) : "", "number", "height");
  const sizeRow = document.createElement("div");
  sizeRow.className = "row";
  sizeRow.append(widthI, heightI);
  adv.append(field("Window size (width \xD7 height)", sizeRow));
  addSelect("Color depth", "bpp", RDP_CHOICES.bpp, "24");
  addCheck("Work area (fit within usable desktop)", "workarea");
  addCheck("Multi-monitor", "multimon");
  group("Performance");
  addCheck("Smooth fonts (ClearType)", "fonts", true);
  addCheck("Desktop composition", "aero");
  addCheck("Full window drag", "windowDrag");
  addCheck("Menu animations", "menuAnims");
  addCheck("Themes", "themes");
  addCheck("Wallpaper", "wallpaper");
  addSelect("GDI rendering", "gdi", RDP_CHOICES.gdi);
  group("Redirection");
  addCheck("Clipboard", "clipboard", true);
  addCheck("Redirect all drives", "drives");
  addCheck("Redirect home directory", "homeDrive");
  addCheck("Redirect printers", "printers");
  addCheck("Redirect smartcards", "smartcards");
  addText("Serial device", "serial", "/dev/ttyUSB0 (optional)");
  addSelect("Audio output", "sound", RDP_CHOICES.sound, "0");
  addCheck("Audio input (microphone)", "microphone");
  group("Security");
  addSelect("Protocol security", "sec", RDP_CHOICES.sec);
  addCheck("Ignore certificate errors", "certIgnore", true);
  addText("Certificate name", "certName", "accept only this name (optional)");
  group("Keyboard");
  addText("Layout", "kbdLayout", "e.g. 0x409 or 'US' (optional)");
  addSelect("Type", "kbdType", RDP_CHOICES.kbdType);
  group("Network");
  addSelect("Connection type", "network", RDP_CHOICES.network);
  addCheck("Compression", "compression", true);
  group("Codecs");
  addCheck("RemoteFX", "rfx");
  addCheck("NSCodec", "nsc");
  addCheck("JPEG codec", "jpeg");
  addSelect("JPEG quality", "jpegQuality", RDP_CHOICES.jpegQuality);
  const root = document.createElement("div");
  root.className = "rdp-fields";
  root.append(field("Domain", domainI), adv);
  const read = () => {
    const out = { ...base };
    const put = (key, value) => {
      if (value === "" || value === void 0 || value === null) delete out[key];
      else out[key] = value;
    };
    for (const [key, el] of strs) put(key, el.value.trim());
    for (const [key, el] of selects) put(key, el.value);
    for (const [key, el] of bools) put(key, el.checked);
    const w = Number(widthI.value);
    const h = Number(heightI.value);
    put("width", Number.isInteger(w) && w > 0 ? w : void 0);
    put("height", Number.isInteger(h) && h > 0 ? h : void 0);
    return out;
  };
  return { element: root, read };
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
function openConnectionForm(initial, opts = {}) {
  const duplicateOf = opts.duplicateOf;
  const isNew = initial === null || duplicateOf !== void 0;
  const nameI = input(
    duplicateOf ? nextCopyName(String(initial?.name ?? ""), state.connections.map((c) => String(c.name))) : initial?.name ?? "",
    "text",
    "name"
  );
  const hostI = input(initial?.host ?? "", "text", "host");
  const portI = input(initial?.port ? String(initial.port) : "", "text", "port (empty=default)");
  const userI = input(initial?.username ?? "", "text", "username");
  const passI = input(
    "",
    "password",
    duplicateOf ? "password (empty = copy the stored password of the source)" : isNew ? "password (stored in the secret storage)" : "new password (empty = keep current)"
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
  const rdp = rdpForm(initial);
  openModal((close) => {
    const m = document.createElement("div");
    m.innerHTML = `<h3>${duplicateOf ? "Duplicate connection" : isNew ? "New connection" : "Edit connection"}</h3>`;
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
      rdp.element,
      err
    );
    const syncRdp = () => {
      rdp.element.style.display = protoI.value === "rdp" ? "" : "none";
    };
    protoI.addEventListener("change", syncRdp);
    syncRdp();
    const actions = document.createElement("div");
    actions.className = "actions";
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", close);
    const ok = document.createElement("button");
    ok.className = "primary";
    ok.textContent = duplicateOf ? "Create copy" : isNew ? "Create" : "Save";
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
        if (protoI.value === "rdp") {
          body.payload = rdp.read();
        }
        if (duplicateOf) {
          body.duplicateOf = duplicateOf;
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
  const sections = connectionSections();
  for (const section of sections) {
    const h = document.createElement("h2");
    h.textContent = section.label;
    h.style.marginLeft = `${section.depth * 1.25}rem`;
    main.append(h);
    if (section.connections.length === 0) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "no connections";
      main.append(empty);
      continue;
    }
    const table = document.createElement("table");
    table.innerHTML = "<thead><tr><th>Name</th><th>Protocol</th><th>Target</th><th>Auth</th><th>Actions</th></tr></thead>";
    const tbody = document.createElement("tbody");
    for (const c of section.connections) {
      tbody.append(connectionRow(c));
    }
    table.append(tbody);
    main.append(table);
  }
  if (sections.length === 0) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "No connections yet.";
    main.append(p);
  }
}
function connectionSections() {
  const sections = [];
  const root = state.connections.filter((c) => !c.groupId);
  if (root.length > 0) {
    sections.push({ label: "(no group)", depth: 0, connections: root });
  }
  const walk = (parentId, depth) => {
    for (const g of state.groups.filter((x) => (x.parentId ?? null) === parentId)) {
      sections.push({
        label: g.name,
        depth,
        connections: state.connections.filter((c) => c.groupId === g.id)
      });
      walk(g.id, depth + 1);
    }
  };
  walk(null, 0);
  return sections;
}
function connectionRow(c) {
  const tr = document.createElement("tr");
  const auth = c.payload?.auth === "key" || c.payload?.auth === "password" ? c.payload.auth : "unknown";
  tr.innerHTML = `<td>${c.name}</td><td>${c.protocol}</td><td class="mono">${c.username ? c.username + "@" : ""}${c.host}${c.port ? ":" + c.port : ""}</td><td class="mono${auth === "unknown" ? " muted" : ""}">${auth}</td>`;
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
    const testBtn = document.createElement("button");
    testBtn.textContent = "test";
    testBtn.addEventListener("click", async () => {
      testBtn.disabled = true;
      testBtn.textContent = "\u2026";
      try {
        const r = await api(`/api/connections/${encodeURIComponent(c.id)}/test`, {
          method: "POST"
        });
        state.notice = r.ok ? `${c.name}: test passed \u2014 authenticated by ${r.auth === "key" ? "public key" : "stored password"} (${r.message}).` : `${c.name}: test failed \u2014 ${r.message}`;
      } catch (e) {
        state.notice = `${c.name}: ${String(e)}`;
      }
      await refreshConnections();
    });
    actions.append(testBtn);
  }
  const dupBtn = document.createElement("button");
  dupBtn.textContent = "duplicate";
  dupBtn.addEventListener("click", () => openConnectionForm(c, { duplicateOf: c.id }));
  actions.append(dupBtn);
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
  return tr;
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
