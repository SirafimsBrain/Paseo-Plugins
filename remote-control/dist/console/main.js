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
  gatewayUsageMethod: [
    ["", "Automatic"],
    ["direct", "Direct (always use the gateway)"],
    ["detect", "Detect (let the server decide)"]
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

// shared/vnc-fields.ts
var VNC_CLIENT_LABELS = {
  tigervnc: "TigerVNC",
  turbovnc: "TurboVNC",
  tightvnc: "TightVNC",
  realvnc: "RealVNC",
  remmina: "Remmina",
  krdc: "KRDC (KDE)",
  vinagre: "Vinagre (GNOME)",
  gvncviewer: "gvncviewer (gtk-vnc)",
  custom: "Custom (binary path below)"
};
function levelChoices(first, middle, last) {
  return [
    ["", "Auto"],
    ["0", `0 - ${first}`],
    ["1", "1"],
    ["2", "2"],
    ["3", "3"],
    ["4", "4"],
    ["5", `5 - ${middle}`],
    ["6", "6"],
    ["7", "7"],
    ["8", "8"],
    ["9", `9 - ${last}`]
  ];
}
var VNC_CHOICES = {
  quality: levelChoices("Lowest / smallest", "Medium", "Highest / largest"),
  compress: levelChoices("No compression", "Medium", "Maximum"),
  encoding: [
    ["", "Auto"],
    ["Tight", "Tight"],
    ["ZRLE", "ZRLE"],
    ["Hextile", "Hextile"],
    ["Raw", "Raw"]
  ],
  colorDepth: [
    ["", "Auto"],
    ["8", "8-bit (256 colors)"],
    ["16", "16-bit (65K colors)"],
    ["24", "24-bit (16M colors)"],
    ["32", "32-bit (16M+ colors)"]
  ]
};
var VNC_PAYLOAD_DEFAULTS = {
  shared: true,
  colorDepth: "24",
  acceptClipboard: true,
  sendClipboard: true,
  turbovncLocal: true
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
function colorInput(value) {
  const wrap = document.createElement("div");
  wrap.className = "color-field";
  wrap.style.display = "flex";
  wrap.style.alignItems = "center";
  wrap.style.gap = "0.5rem";
  const swatch = document.createElement("div");
  swatch.className = "color-swatch";
  swatch.style.width = "1.5rem";
  swatch.style.height = "1.5rem";
  swatch.style.border = "1px solid #8886";
  swatch.style.borderRadius = "4px";
  swatch.style.backgroundColor = value ?? "transparent";
  swatch.style.backgroundImage = value ? "" : "repeating-linear-gradient(45deg,#8888 25%,transparent 25%,transparent 75%,#8888 75%),repeating-linear-gradient(45deg,#8888 25%,transparent 25%,transparent 75%,#8888 75%)";
  swatch.style.backgroundSize = "10px 10px";
  swatch.style.backgroundPosition = "0 0,5px 5px";
  const colorI = document.createElement("input");
  colorI.type = "color";
  colorI.value = value ?? "#ffffff";
  colorI.style.border = "none";
  colorI.style.background = "none";
  colorI.style.width = "1.5rem";
  colorI.style.height = "1.5rem";
  colorI.style.cursor = "pointer";
  colorI.style.padding = "0";
  colorI.addEventListener("input", () => {
    swatch.style.backgroundColor = colorI.value;
  });
  colorI.addEventListener("change", () => {
    swatch.style.backgroundColor = colorI.value;
  });
  const clearBtn = document.createElement("button");
  clearBtn.textContent = "\u041E\u0447\u0438\u0441\u0442\u0438\u0442\u044C";
  clearBtn.style.fontSize = "0.8rem";
  clearBtn.addEventListener("click", () => {
    colorI.value = "#ffffff";
    swatch.style.backgroundColor = "transparent";
  });
  wrap.append(swatch, colorI, clearBtn);
  wrap.value = () => colorI.value === "#ffffff" && !value ? null : colorI.value;
  return wrap;
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
  group("RD Gateway");
  addText("Gateway host", "gatewayHost", "gateway host, e.g. rdp.example.com (optional)");
  const gwPortI = input(has("gatewayPort") ? String(base.gatewayPort) : "", "number", "gateway port (empty = default)");
  adv.append(field("Gateway port", gwPortI));
  addText("Gateway user", "gatewayUser", "gateway login (empty = reuse the connection login)");
  addText("Gateway domain", "gatewayDomain", "gateway domain (optional)");
  addSelect("Gateway usage", "gatewayUsageMethod", RDP_CHOICES.gatewayUsageMethod);
  const gwPassI = input("", "password", "gateway password (stored in the secret storage)");
  adv.append(field("Gateway password", gwPassI));
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
    const gatewayPort = Number(gwPortI.value);
    put(
      "gatewayPort",
      gwPortI.value.trim() !== "" && Number.isInteger(gatewayPort) && gatewayPort >= 1 && gatewayPort <= 65535 ? gatewayPort : void 0
    );
    return out;
  };
  return { element: root, read, gatewayPassword: () => gwPassI.value };
}
function vncForm(initial) {
  const stored = initial && initial.protocol === "vnc" && initial.payload ? initial.payload : {};
  const base = { ...VNC_PAYLOAD_DEFAULTS, ...stored };
  const has = (k) => base[k] !== void 0 && base[k] !== null;
  const bools = [];
  const strs = [];
  const selects = [];
  const adv = document.createElement("details");
  adv.className = "rdp-advanced";
  const summary = document.createElement("summary");
  summary.textContent = "Advanced (VNC)";
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
  const storedClient = has("vncClient") ? String(base.vncClient) : "";
  const clientOptions = [["", "Automatic (first installed client)"]];
  if (storedClient !== "" && storedClient !== "custom") {
    clientOptions.push([storedClient, `${storedClient} (checking\u2026)`]);
  }
  clientOptions.push(["custom", VNC_CLIENT_LABELS.custom]);
  const clientI = selectEl(clientOptions, storedClient);
  const displayI = input(has("display") ? String(base.display) : "", "number", "e.g. 1 \u2192 port 5901");
  const customI = input(has("customBinary") ? String(base.customBinary) : "", "text", "/path/to/vncviewer or a name on PATH");
  group("Display");
  addCheck("View only", "viewOnly");
  addCheck("Fullscreen", "fullscreen");
  addCheck("Shared session", "shared", true);
  addSelect("Quality / JPEG level", "quality", VNC_CHOICES.quality);
  addSelect("Compression level", "compress", VNC_CHOICES.compress);
  addSelect("Preferred encoding", "encoding", VNC_CHOICES.encoding);
  addSelect("Color depth", "colorDepth", VNC_CHOICES.colorDepth, "24");
  addCheck("Accept clipboard", "acceptClipboard", true);
  addCheck("Send clipboard", "sendClipboard", true);
  group("TigerVNC");
  addText("Geometry", "tigervncGeometry", "e.g. 1280x720 (optional)");
  addText("SSH tunnel via", "tigervncVia", "e.g. user@gateway (optional)");
  group("TurboVNC");
  addText("Geometry (DesktopSize)", "turbovncGeometry", "e.g. 1280x720 (optional)");
  addText("SSH tunnel via", "turbovncVia", "e.g. user@gateway (optional)");
  addCheck("Force JPEG compression", "turbovncJpeg");
  addCheck("Local cursor", "turbovncLocal", true);
  group("Extra");
  const extraI = addText("Extra CLI arguments", "extraArgs", "-via user@gateway (quotes supported)");
  if (Array.isArray(base.extraArgs)) extraI.value = base.extraArgs.join(" ");
  const root = document.createElement("div");
  root.className = "rdp-fields";
  root.append(
    field("VNC client", clientI),
    field("Display number (optional)", displayI),
    field("Custom binary (only for Custom)", customI),
    adv
  );
  void (async () => {
    try {
      const body = await api("/api/vnc/clients");
      const installed = Array.isArray(body.clients) ? body.clients : [];
      const current = clientI.value;
      const options = [
        ["", "Automatic (first installed client)"],
        ...installed.map((c) => [String(c.clientId), String(c.displayName)]),
        ["custom", VNC_CLIENT_LABELS.custom]
      ];
      if (current !== "" && current !== "custom" && !installed.some((c) => c.clientId === current)) {
        options.splice(options.length - 1, 0, [current, `${current} (not installed)`]);
      }
      const next = selectEl(options, current);
      clientI.replaceWith(next);
      const entry = selects.find(([key]) => key === "vncClient");
      if (entry) entry[1] = next;
      else selects.push(["vncClient", next]);
    } catch {
    }
  })();
  selects.push(["vncClient", clientI]);
  const read = () => {
    const out = { ...base };
    const put = (key, value) => {
      if (value === "" || value === void 0 || value === null) delete out[key];
      else out[key] = value;
    };
    for (const [key, el] of strs) put(key, el.value.trim());
    for (const [key, el] of selects) put(key, el.value);
    for (const [key, el] of bools) put(key, el.checked);
    const display = Number(displayI.value);
    put("display", displayI.value.trim() !== "" && Number.isInteger(display) && display >= 0 ? display : void 0);
    return out;
  };
  return { element: root, read };
}
function sshForm(initial) {
  const stored = initial && initial.protocol === "ssh" && initial.payload ? initial.payload : {};
  const base = { ...stored };
  const str = (key) => typeof base[key] === "string" ? base[key] : "";
  const aliasI = input(str("sshAlias"), "text", "alias in ~/.ssh/config (empty = name slug)");
  const identityI = input(str("identityFile"), "text", "IdentityFile, e.g. ~/.ssh/id_ed25519 (optional)");
  const jumpI = input(str("proxyJump"), "text", "ProxyJump, e.g. user@gateway (optional)");
  const publicI = input(str("publicKeyPath"), "text", "public key to deploy, e.g. ~/.ssh/id_ed25519.pub (optional)");
  const adv = document.createElement("details");
  adv.className = "rdp-advanced";
  const summary = document.createElement("summary");
  summary.textContent = "Advanced (SSH)";
  adv.append(
    summary,
    field("Host alias", aliasI),
    field("Identity file", identityI),
    field("Jump host", jumpI),
    field("Public key", publicI)
  );
  const note = document.createElement("p");
  note.className = "muted";
  note.textContent = 'The alias is the Host token of the managed ~/.ssh/config block; the plugin never rewrites blocks it did not create. "Copy key" deploys the public key into the remote authorized_keys.';
  adv.append(note);
  const root = document.createElement("div");
  root.className = "rdp-fields";
  root.append(adv);
  const read = () => {
    const out = { ...base };
    const put = (key, value) => {
      if (value.length === 0) delete out[key];
      else out[key] = value;
    };
    put("sshAlias", aliasI.value.trim());
    put("identityFile", identityI.value.trim());
    put("proxyJump", jumpI.value.trim());
    put("publicKeyPath", publicI.value.trim());
    return out;
  };
  return { element: root, read };
}
var state = {
  view: "sessions",
  sessions: [],
  connections: [],
  groups: [],
  notice: null,
  terminalError: null,
  selected: /* @__PURE__ */ new Set(),
  live: false,
  sessionFilters: { kind: "all", connectionId: "", query: "", group: false }
};
var NAV = [
  { id: "sessions", label: "Sessions" },
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
async function refreshSessions() {
  try {
    const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
    const body = await api(`/api/sessions${query}`);
    state.sessions = body.sessions ?? [];
    state.terminalError = typeof body.terminalError === "string" ? body.terminalError : null;
    for (const id of [...state.selected]) {
      if (!state.sessions.some((session) => session.id === id)) state.selected.delete(id);
    }
    if (state.view === "sessions") render();
  } catch (e) {
    console.error(e);
  }
}
function connectionLabel(connectionId) {
  if (!connectionId) return null;
  return state.connections.find((connection) => connection.id === connectionId)?.name ?? connectionId;
}
function visibleSessions() {
  const filters = state.sessionFilters;
  const query = filters.query.trim().toLowerCase();
  return state.sessions.filter((session) => {
    if (filters.kind !== "all" && session.kind !== filters.kind) return false;
    if (filters.connectionId !== "" && (session.connectionId ?? "") !== filters.connectionId) return false;
    if (query.length === 0) return true;
    const haystack = `${session.name} ${session.id} ${session.target ?? ""} ${session.kind} ${connectionLabel(session.connectionId) ?? ""}`.toLowerCase();
    return haystack.includes(query);
  });
}
function sessionSurface(session) {
  return session.kind === "rdp" || session.kind === "vnc" ? "desktop window" : "Paseo tab";
}
function sessionStateLabel(session) {
  if (session.state === "exited") {
    if (typeof session.exitCode === "number") return `exited (${session.exitCode})`;
    if (typeof session.signal === "string" && session.signal.length > 0) return `exited (${session.signal})`;
    return "exited";
  }
  return "running";
}
function sessionHint(session) {
  if (session.kind === "rdp" || session.kind === "vnc") {
    return `${session.name}: ${session.binary ?? "viewer"} window on the desktop (pid ${session.pid ?? "?"}) \u2014 bring it forward with your window manager.`;
  }
  return `${session.name}: terminal tab${session.workspaceId ? ` in workspace ${session.workspaceId}` : ""} in Paseo \u2014 open it in the app; the daemon owns the tab.`;
}
function openTerminalPeek(session) {
  openModal((close) => {
    const wrap = document.createElement("div");
    const title = document.createElement("h2");
    title.textContent = `${session.name} \u2014 scrollback`;
    const meta = document.createElement("p");
    meta.className = "muted";
    meta.textContent = "Last 200 lines, read-only (ANSI stripped).";
    const pre = document.createElement("pre");
    pre.className = "mono";
    pre.style.maxHeight = "50vh";
    pre.style.overflow = "auto";
    pre.style.whiteSpace = "pre-wrap";
    pre.textContent = "Loading\u2026";
    const load = async () => {
      try {
        const body = await api(`/api/terminals/${encodeURIComponent(session.id)}/capture?lines=200`);
        pre.textContent = typeof body.text === "string" && body.text.length > 0 ? body.text : "(no output captured yet)";
        const total = typeof body.totalLines === "number" ? body.totalLines : 0;
        meta.textContent = total > 200 ? `Last 200 of ${total} lines, read-only (ANSI stripped).` : `Last ${total} lines, read-only (ANSI stripped).`;
      } catch (e) {
        pre.textContent = `Could not read the terminal: ${String(e)}`;
      }
    };
    const refresh = document.createElement("button");
    refresh.textContent = "Refresh";
    refresh.addEventListener("click", () => void load());
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", close);
    const actions = document.createElement("div");
    actions.className = "row";
    actions.append(refresh, closeBtn);
    wrap.append(title, meta, pre, actions);
    void load();
    return wrap;
  });
}
async function killSession(session) {
  try {
    await api(`/api/sessions/${encodeURIComponent(session.id)}/kill`, { method: "POST" });
    state.notice = null;
  } catch (e) {
    state.notice = `${session.name}: ${String(e)}`;
  }
}
async function killSelectedSessions() {
  const ids = [...state.selected];
  if (ids.length === 0) return;
  for (const id of ids) {
    const session = state.sessions.find((entry) => entry.id === id);
    if (session) await killSession(session);
  }
  state.selected.clear();
  state.notice = `${ids.length} session${ids.length === 1 ? "" : "s"} stopped.`;
  await refreshSessions();
}
function sessionsView(main) {
  const header = document.createElement("div");
  header.className = "row";
  const hint = document.createElement("span");
  hint.className = "muted";
  hint.textContent = workspaceId ? `Workspace ${workspaceId} \u2014 Paseo terminal tabs and the RDP/VNC windows opened from this plugin.` : "Paseo terminal tabs and the RDP/VNC windows opened from this plugin.";
  const live = document.createElement("span");
  live.className = "muted";
  live.textContent = state.live ? "live (SSE)" : "polling";
  header.append(hint, live);
  main.append(header);
  if (state.terminalError) {
    const warning = document.createElement("p");
    warning.className = "muted";
    warning.textContent = `Paseo terminals are unavailable right now: ${state.terminalError}`;
    main.append(warning);
  }
  if (state.notice) {
    const notice = document.createElement("p");
    notice.className = "muted";
    notice.textContent = state.notice;
    main.append(notice);
  }
  const filters = document.createElement("div");
  filters.className = "row";
  const kindSel = selectEl(
    [
      ["all", "All kinds"],
      ["local", "local"],
      ["ssh", "ssh"],
      ["rdp", "rdp"],
      ["vnc", "vnc"]
    ],
    state.sessionFilters.kind
  );
  kindSel.addEventListener("change", () => {
    state.sessionFilters.kind = kindSel.value;
    render();
  });
  const connectionOptions = [["", "Any connection"]];
  for (const c of state.connections) connectionOptions.push([String(c.id), String(c.name)]);
  const connectionSel = selectEl(connectionOptions, state.sessionFilters.connectionId);
  connectionSel.addEventListener("change", () => {
    state.sessionFilters.connectionId = connectionSel.value;
    render();
  });
  const queryI = input(state.sessionFilters.query, "text", "filter by name, target or id (Enter)");
  queryI.addEventListener("change", () => {
    state.sessionFilters.query = queryI.value;
    render();
  });
  queryI.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    state.sessionFilters.query = queryI.value;
    render();
  });
  const [groupRow, groupI] = checkField("Group by connection", state.sessionFilters.group);
  groupI.addEventListener("change", () => {
    state.sessionFilters.group = groupI.checked;
    render();
  });
  filters.append(kindSel, connectionSel, queryI, groupRow);
  main.append(filters);
  const rows = visibleSessions();
  const selectAllRow = document.createElement("div");
  selectAllRow.className = "row";
  const counter = document.createElement("span");
  counter.className = "muted";
  counter.textContent = `${rows.length} of ${state.sessions.length} session${state.sessions.length === 1 ? "" : "s"}`;
  const selectAll = document.createElement("button");
  selectAll.textContent = state.selected.size === rows.length && rows.length > 0 ? "Deselect all" : "Select all visible";
  selectAll.disabled = rows.length === 0;
  selectAll.addEventListener("click", () => {
    if (state.selected.size === rows.length) state.selected.clear();
    else for (const s of rows) state.selected.add(s.id);
    render();
  });
  const killSelected = document.createElement("button");
  killSelected.className = "danger";
  killSelected.textContent = `Kill selected (${state.selected.size})`;
  killSelected.disabled = state.selected.size === 0;
  killSelected.addEventListener("click", () => void killSelectedSessions());
  selectAllRow.append(counter, selectAll, killSelected);
  main.append(selectAllRow);
  const buildTable = (entries) => {
    const table = document.createElement("table");
    const thead = document.createElement("thead");
    thead.innerHTML = "<tr><th></th><th>ID</th><th>Name</th><th>Kind</th><th>State</th><th>Connection</th><th>Target</th><th>Surface</th><th>Started</th><th>Actions</th></tr>";
    table.append(thead);
    const tbody = document.createElement("tbody");
    for (const session of entries) {
      tbody.append(sessionRow(session));
    }
    table.append(tbody);
    return table;
  };
  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = state.sessions.length === 0 ? "No sessions yet." : "No session matches these filters.";
    main.append(empty);
    return;
  }
  if (state.sessionFilters.group) {
    const groups = /* @__PURE__ */ new Map();
    for (const session of rows) {
      const key = session.connectionId ?? "";
      const bucket = groups.get(key);
      if (bucket) bucket.push(session);
      else groups.set(key, [session]);
    }
    for (const [key, entries] of groups) {
      const heading = document.createElement("h2");
      heading.textContent = `${key === "" ? "(no connection)" : connectionLabel(key) ?? key} \u2014 ${entries.length}`;
      main.append(heading, buildTable(entries));
    }
    return;
  }
  main.append(buildTable(rows));
}
function sessionRow(session) {
  const tr = document.createElement("tr");
  const started = session.startedAt ? new Date(session.startedAt).toLocaleTimeString() : "-";
  const connection = connectionLabel(session.connectionId) ?? "-";
  const stateLabel = sessionStateLabel(session);
  tr.innerHTML = `<td></td><td class="mono">${session.id}</td><td>${session.name}</td><td>${session.kind}</td><td${session.state === "exited" ? ' class="muted"' : ""}>${stateLabel}</td><td>${connection === "-" ? '<span class="muted">-</span>' : connection}</td><td class="mono">${session.target || "-"}</td><td>${sessionSurface(session)}</td><td>${started}</td>`;
  const checkCell = tr.firstElementChild;
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = state.selected.has(session.id);
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) state.selected.add(session.id);
    else state.selected.delete(session.id);
    render();
  });
  checkCell.append(checkbox);
  const actions = document.createElement("td");
  const exited = session.state === "exited";
  if (!exited) {
    const hintBtn = document.createElement("button");
    hintBtn.textContent = session.kind === "rdp" || session.kind === "vnc" ? "focus window" : "open";
    hintBtn.addEventListener("click", () => {
      state.notice = sessionHint(session);
      render();
    });
    if (session.kind !== "rdp" && session.kind !== "vnc") {
      const peekBtn = document.createElement("button");
      peekBtn.textContent = "peek";
      peekBtn.title = "Read the last 200 lines of this terminal (read-only)";
      peekBtn.addEventListener("click", () => openTerminalPeek(session));
      actions.append(peekBtn);
    }
    actions.append(hintBtn);
  }
  const killBtn = document.createElement("button");
  killBtn.className = exited ? "" : "danger";
  killBtn.textContent = exited ? "remove" : "kill";
  killBtn.title = exited ? "Remove this finished window from the list" : "Stop the window";
  killBtn.addEventListener("click", async () => {
    await killSession(session);
    await refreshSessions();
  });
  actions.append(killBtn);
  tr.append(actions);
  return tr;
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
  const vnc = vncForm(initial);
  const ssh = sshForm(initial);
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
      ssh.element,
      rdp.element,
      vnc.element,
      err
    );
    const syncProtocol = () => {
      ssh.element.style.display = protoI.value === "ssh" ? "" : "none";
      rdp.element.style.display = protoI.value === "rdp" ? "" : "none";
      vnc.element.style.display = protoI.value === "vnc" ? "" : "none";
    };
    protoI.addEventListener("change", syncProtocol);
    syncProtocol();
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
          const gatewayPassword = rdp.gatewayPassword();
          if (gatewayPassword !== "") body.gatewayPassword = gatewayPassword;
        } else if (protoI.value === "vnc") {
          body.payload = vnc.read();
        } else {
          body.payload = ssh.read();
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
    const colorEl = colorInput(null);
    openModal((close) => {
      const m = document.createElement("div");
      m.innerHTML = "<h3>New group</h3>";
      m.append(field("Name", nameInput), field("\u0426\u0432\u0435\u0442 \u0433\u0440\u0443\u043F\u043F\u044B", colorEl));
      const actions = document.createElement("div");
      actions.className = "actions";
      const cancel = document.createElement("button");
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", close);
      const ok = document.createElement("button");
      ok.className = "primary";
      ok.textContent = "Create";
      ok.addEventListener("click", async () => {
        const name = nameInput.value.trim();
        if (!name) return;
        const color = colorEl.value?.();
        await api("/api/groups", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, color }) });
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
    const groupBar = document.createElement("div");
    groupBar.style.display = "flex";
    groupBar.style.alignItems = "center";
    groupBar.style.gap = "0.5rem";
    groupBar.style.marginLeft = `${section.depth * 1.25}rem`;
    groupBar.style.marginBottom = "0.25rem";
    const h = document.createElement("h2");
    h.textContent = section.label;
    h.style.margin = "0";
    if (section.color) {
      h.style.backgroundColor = section.color;
      const isLight = section.color === "#ffffff" || section.color === "#fff";
      h.style.color = isLight ? "#000000" : "#ffffff";
      h.style.padding = "0.15rem 0.5rem";
      h.style.borderRadius = "4px";
    }
    groupBar.append(h);
    if (section.id !== null) {
      const groupId = section.id;
      const editBtn = document.createElement("button");
      editBtn.textContent = "edit";
      editBtn.addEventListener("click", () => openEditGroupModal(groupId, section.label, section.color));
      groupBar.append(editBtn);
      const delBtn = document.createElement("button");
      delBtn.className = "danger";
      delBtn.textContent = "delete";
      delBtn.addEventListener("click", () => deleteGroup(groupId, section.label));
      groupBar.append(delBtn);
    }
    main.append(groupBar);
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
    sections.push({ label: "(no group)", id: null, color: null, depth: 0, connections: root });
  }
  const walk = (parentId, depth) => {
    for (const g of state.groups.filter((x) => (x.parentId ?? null) === parentId)) {
      sections.push({
        label: g.name,
        id: g.id,
        color: g.color ?? null,
        depth,
        connections: state.connections.filter((c) => c.groupId === g.id)
      });
      walk(g.id, depth + 1);
    }
  };
  walk(null, 0);
  return sections;
}
function openEditGroupModal(groupId, currentName, currentColor) {
  const nameI = input(currentName, "text", "group name");
  const colorEl = colorInput(currentColor);
  openModal((close) => {
    const m = document.createElement("div");
    m.innerHTML = "<h3>Edit group</h3>";
    const err = document.createElement("p");
    err.style.color = "#ef4444";
    err.style.fontSize = "0.85rem";
    err.style.display = "none";
    m.append(field("Name", nameI), field("\u0426\u0432\u0435\u0442 \u0433\u0440\u0443\u043F\u043F\u044B", colorEl), err);
    const actions = document.createElement("div");
    actions.className = "actions";
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", close);
    const ok = document.createElement("button");
    ok.className = "primary";
    ok.textContent = "Save";
    ok.addEventListener("click", async () => {
      const name = nameI.value.trim();
      if (!name) {
        err.textContent = "group name is required";
        err.style.display = "";
        return;
      }
      const color = colorEl.value?.();
      try {
        await api(`/api/groups/${encodeURIComponent(groupId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, color })
        });
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
async function deleteGroup(groupId, groupName) {
  if (!confirm(`Delete group \u201C${groupName}\u201D? Its connections become root-level (no group).`)) return;
  try {
    await api(`/api/groups/${encodeURIComponent(groupId)}`, { method: "DELETE" });
    await refreshConnections();
  } catch (e) {
    state.notice = String(e);
  }
}
function authLabel(c) {
  if (c.payload?.auth === "key" || c.payload?.auth === "password") return c.payload.auth;
  if (c.protocol === "rdp" || c.protocol === "vnc") return "password";
  return "unknown";
}
function connectionRow(c) {
  const tr = document.createElement("tr");
  const auth = authLabel(c);
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
      state.view = "sessions";
      await refreshSessions();
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
    const configBtn = document.createElement("button");
    configBtn.textContent = "ssh-config";
    configBtn.title = "Write or update this connection's Host block in ~/.ssh/config";
    configBtn.addEventListener("click", async () => {
      configBtn.disabled = true;
      try {
        const r = await api("/api/ssh-config/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ connectionId: c.id })
        });
        state.notice = `${c.name}: Host ${r.alias} ${r.action} in ${r.path} (backup: ${r.backup ?? "none"}).`;
      } catch (e) {
        state.notice = `${c.name}: ${String(e)}`;
      }
      configBtn.disabled = false;
      render();
    });
    actions.append(configBtn);
    const keyBtn = document.createElement("button");
    keyBtn.textContent = "copy key";
    keyBtn.title = "Deploy this connection's public key into the remote authorized_keys";
    keyBtn.addEventListener("click", async () => {
      keyBtn.disabled = true;
      try {
        const r = await api(`/api/connections/${encodeURIComponent(c.id)}/copy-key`, { method: "POST" });
        state.notice = r.ok ? `${c.name}: ${r.message}${r.fingerprint ? ` (${r.fingerprint})` : ""}${r.source ? ` \u2014 ${r.source}` : ""}.` : `${c.name}: copy key failed \u2014 ${r.message}`;
      } catch (e) {
        state.notice = `${c.name}: ${String(e)}`;
      }
      keyBtn.disabled = false;
      render();
    });
    actions.append(keyBtn);
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
function cardEl(title) {
  const card = document.createElement("div");
  card.className = "card";
  const body = document.createElement("div");
  if (title) {
    const h = document.createElement("h2");
    h.textContent = title;
    card.append(h);
  }
  card.append(body);
  return { card, body };
}
function preEl(text = "") {
  const pre = document.createElement("pre");
  pre.textContent = text;
  return pre;
}
function settingsView(main) {
  const { card, body } = cardEl("Server and storage");
  const status = preEl("loading\u2026");
  const portI = input("0", "number", "0 = ephemeral port");
  const autoLockI = input("0", "number", "0 = never lock automatically");
  const storeDirI = input("", "text", "/path/to/pass-store");
  const rdpI = input("", "text", "xfreerdp3 (empty = PATH discovery)");
  const vncI = input("", "text", "vncviewer (empty = per-connection / discovery)");
  const message = document.createElement("p");
  message.className = "muted";
  const saveBtn = document.createElement("button");
  saveBtn.className = "primary";
  saveBtn.textContent = "Save settings";
  const lockBtn = document.createElement("button");
  lockBtn.textContent = "Lock now";
  const actions = document.createElement("div");
  actions.className = "actions";
  actions.append(saveBtn, lockBtn);
  body.append(
    status,
    field("Console port", portI),
    field("Vault auto-lock (minutes)", autoLockI),
    field("Secret storage directory (PASSWORD_STORE_DIR)", storeDirI),
    field("RDP client override", rdpI),
    field("VNC viewer override", vncI),
    actions,
    message
  );
  main.append(card);
  const refreshStatus = async () => {
    try {
      const [stateBody, settingsBody] = await Promise.all([api("/api/state"), api("/api/settings")]);
      status.textContent = JSON.stringify(
        {
          version: stateBody.version,
          console: stateBody.console,
          vault: stateBody.vault,
          settings: stateBody.settings,
          sshConfigPath: stateBody.sshConfigPath
        },
        null,
        2
      );
      const settings = settingsBody.settings ?? {};
      portI.value = String(settings.consolePort ?? 0);
      autoLockI.value = String(settings.autoLockMinutes ?? 0);
      storeDirI.value = String(settings.storeDir ?? "");
      rdpI.value = String(settings.rdpBinary ?? "");
      vncI.value = String(settings.vncBinary ?? "");
    } catch (e) {
      status.textContent = String(e);
    }
  };
  void refreshStatus();
  saveBtn.addEventListener("click", async () => {
    message.textContent = "";
    try {
      const patch = {
        consolePort: Number(portI.value || 0),
        autoLockMinutes: Number(autoLockI.value || 0),
        storeDir: storeDirI.value.trim(),
        rdpBinary: rdpI.value.trim(),
        vncBinary: vncI.value.trim()
      };
      const result = await api("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch)
      });
      if (result.restart) {
        message.textContent = "Saved. The console port changed: this tab's origin is about to stop serving \u2014 reopen the console from the Remote Control panel.";
      } else {
        message.textContent = "Saved.";
      }
      await refreshStatus();
    } catch (e) {
      message.textContent = String(e);
    }
  });
  lockBtn.addEventListener("click", async () => {
    try {
      await api("/api/vault/lock", { method: "POST" });
      message.textContent = "Secret storage locked.";
    } catch (e) {
      message.textContent = String(e);
    }
    await refreshStatus();
  });
  const { card: gcard, body: gbody } = cardEl("Ghostty settings import");
  const previewBtn = document.createElement("button");
  previewBtn.textContent = "Preview import";
  const applyBtn = document.createElement("button");
  applyBtn.className = "primary";
  applyBtn.textContent = "Apply";
  applyBtn.disabled = true;
  const gresult = preEl("");
  gbody.append(previewBtn, applyBtn, gresult);
  main.append(gcard);
  let lastSettings = {};
  previewBtn.addEventListener("click", async () => {
    try {
      const preview = await api("/api/ghostty/import");
      gresult.textContent = JSON.stringify(preview, null, 2);
      lastSettings = preview.settings;
      applyBtn.disabled = !preview.found;
    } catch (e) {
      gresult.textContent = String(e);
    }
  });
  applyBtn.addEventListener("click", async () => {
    try {
      const r = await api("/api/ghostty/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: lastSettings })
      });
      gresult.textContent = JSON.stringify(r, null, 2);
    } catch (e) {
      gresult.textContent = String(e);
    }
  });
  const { card: scard, body: sbody } = cardEl("~/.ssh/config");
  const sresult = preEl("loading\u2026");
  const reloadBtn = document.createElement("button");
  reloadBtn.textContent = "Reload";
  const syncAllBtn = document.createElement("button");
  syncAllBtn.textContent = "Sync all SSH connections";
  sbody.append(reloadBtn, syncAllBtn, sresult);
  main.append(scard);
  const loadSshConfig = async () => {
    try {
      const body2 = await api("/api/ssh-config");
      const config = body2.config ?? {};
      const hosts = Array.isArray(config.hosts) ? config.hosts : [];
      const managed = hosts.filter((host) => host.managedConnectionId);
      sresult.textContent = JSON.stringify(
        {
          path: config.path,
          exists: config.exists,
          revision: String(config.revision ?? "").slice(0, 12),
          hosts: hosts.length,
          managed: managed.map((host) => `${host.alias} \u2192 ${host.managedConnectionId}`),
          includes: config.includes,
          warnings: config.warnings
        },
        null,
        2
      );
    } catch (e) {
      sresult.textContent = String(e);
    }
  };
  void loadSshConfig();
  reloadBtn.addEventListener("click", () => void loadSshConfig());
  syncAllBtn.addEventListener("click", async () => {
    syncAllBtn.disabled = true;
    const sshConnections = state.connections.filter((c) => c.protocol === "ssh");
    const lines = [];
    for (const connection of sshConnections) {
      try {
        const r = await api("/api/ssh-config/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ connectionId: connection.id })
        });
        lines.push(`${connection.name}: ${r.alias} ${r.action}`);
      } catch (e) {
        lines.push(`${connection.name}: ${String(e)}`);
      }
    }
    sresult.textContent = lines.length > 0 ? lines.join("\n") : "No SSH connections yet.";
    syncAllBtn.disabled = false;
  });
}
var VIEWS = {
  sessions: sessionsView,
  connections: connectionsView,
  settings: settingsView
};
function startLiveUpdates() {
  try {
    const events = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
    events.onopen = () => {
      state.live = true;
      if (state.view === "sessions") render();
    };
    events.onerror = () => {
      state.live = false;
    };
    events.addEventListener("sessions", () => {
      if (state.view === "sessions") void refreshSessions();
    });
  } catch {
  }
  setInterval(() => {
    if (state.view === "sessions") void refreshSessions();
  }, 5e3);
}
var initialAction = params.get("action") ?? "";
render();
void refreshSessions();
void refreshConnections().then(() => {
  if (initialAction === "new") {
    state.view = "connections";
    render();
    openConnectionForm(null);
  }
});
startLiveUpdates();
