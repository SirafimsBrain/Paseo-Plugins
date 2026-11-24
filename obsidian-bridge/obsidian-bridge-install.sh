#!/usr/bin/env bash
# obsidian-bridge-install.sh — install the Obsidian Bridge MCP server without Paseo.
#
# The script is the only installation path: `curl … | bash` and a `git clone`
# both end up here, so a standalone installation and the Paseo plugin are built
# from the same source and the same bundler. Everything is documented in
# AGENT-SETUP.md, which is copied into the installation directory.
#
# Linux is the primary target; macOS is expected to work; Windows is not
# supported by this script (use WSL).
set -euo pipefail

REPO="${OBSIDIAN_BRIDGE_REPO:-SirafimsBrain/Paseo-Plugins}"
PLUGIN_SUBDIR="obsidian-bridge"

# The release this script belongs to (0.26.23).
#
# `curl … | bash` from a tag URL fetches this file at that tag, so the version
# here is the tag the caller asked for. The default source is therefore that
# tag, not `main`: the build, `install.json`'s `version` and `ref` all describe
# the release whose installer was run, however much `main` has moved since.
# The release workflow refuses to publish a tag that disagrees with this value.
SCRIPT_VERSION="0.26.23"

DEFAULT_HOME="${HOME}/.agents/obsidian-bridge-mcp"
SKILL_CORE="obsidian-bridge"
SKILL_PLANNING="obsidian-planning-create obsidian-planning-execute obsidian-planning-review"
SKILL_MARKER="installed-by: obsidian-bridge"
# These were installed by 0.23.x–0.24.x. They are not deleted by a normal
# uninstall because another plugin or the user may own a directory with the
# same generic name; --force removes them explicitly.
LEGACY_SKILL_NAMES="planning-create planning-execute planning-review"

ref=""
ref_explicit=0
ref_defaulted=0
expected_version=""
build_ref=""
install_dir="${OBSIDIAN_BRIDGE_HOME:-$DEFAULT_HOME}"
vault=""
with_skills=1
with_planning_skills=0
planning_explicit=0
skills_dir="${HOME}/.agents/skills"
source_arg=""
uninstall=0
dry_run=0
force=0

usage() {
  cat <<'EOF'
Install the Obsidian Bridge MCP server as a standalone stdio server.

Usage:
  obsidian-bridge-install.sh [options]

Options:
  --version <x.y.z>     Install the release tagged obsidian-bridge@<x.y.z>.
  --ref <git-ref>       Install an arbitrary branch, tag or commit (default: the
                        release this script belongs to, not main).
  --dir <path>          Install directory (default $OBSIDIAN_BRIDGE_HOME,
                        else ~/.agents/obsidian-bridge-mcp).
  --vault <path>        Vault root to write into settings.json. A relative path
                        is resolved against the home directory by the server.
  --no-skills           Do not install the `obsidian-bridge` Agent Skill.
  --with-planning-skills
                        Also install the three `obsidian-planning-*` skills.
  --no-planning-skills  Install only `obsidian-bridge`; planning skills already
                        on disk are left alone and are no longer recorded.
  --skills-dir <path>   Skills root (default ~/.agents/skills).
  --source <path>       Build from a local checkout instead of downloading.
                        Cannot be combined with --ref or --version.
  --uninstall           Remove the installation and the skills it recorded.
  --force               Install into a non-empty foreign directory, uninstall
                        without install.json, or remove legacy `planning-*` skills.
  --dry-run             Print the plan and exit. It may fetch the source to read
                        its package.json, but changes nothing.
  -h, --help            This text.

Environment:
  OBSIDIAN_BRIDGE_HOME  Install directory, same as --dir. `~` is accepted.
  OBSIDIAN_BRIDGE_REPO  owner/repo on GitHub (default SirafimsBrain/Paseo-Plugins).

The standalone server is lexical + graph: it does not build embeddings, so
semantic search is a Paseo-plugin feature. After installing, point your MCP
client at <dir>/dist/mcp-server.js; the script prints the exact block.
Requirements: Node.js >= 22.13 (or >= 23.4; node:sqlite with FTS5).
EOF
}

info() { printf '%s\n' "$*"; }
die() { printf 'obsidian-bridge-install: %s\n' "$*" >&2; exit 1; }

# Resolves a path without requiring it to exist. `~` is expanded, and a
# relative path is resolved against the current directory.
absolute_path() {
  local p="$1"
  case "$p" in
    "~") p="$HOME" ;;
    "~/"*) p="$HOME/${p#\~/}" ;;
  esac
  if [ -d "$p" ]; then
    (cd "$p" && pwd -P)
    return 0
  fi
  if command -v realpath >/dev/null 2>&1; then
    realpath -m -- "$p" 2>/dev/null && return 0
  fi
  if command -v readlink >/dev/null 2>&1 && readlink -f -- "$p" >/dev/null 2>&1; then
    readlink -f -- "$p"
    return 0
  fi
  local parent
  if parent="$(cd "$(dirname "$p")" 2>/dev/null && pwd -P)"; then
    printf '%s/%s\n' "$parent" "$(basename "$p")"
    return 0
  fi
  case "$p" in
    /*) printf '%s\n' "$p" ;;
    *) printf '%s/%s\n' "$PWD" "$p" ;;
  esac
}

# `--vault` uses the server's semantics: a relative path is home-relative,
# not cwd-relative. The containment guard must compare the same path.
vault_path() {
  case "$1" in
    "~") absolute_path "$HOME" ;;
    "~/"*) absolute_path "$HOME/${1#\~/}" ;;
    /*) absolute_path "$1" ;;
    *) absolute_path "$HOME/$1" ;;
  esac
}

# True when $1 is $2 or an ancestor of $2.
contains_path() {
  [ "$1" = "$2" ] && return 0
  case "$2" in "$1"/*) return 0 ;; esac
  return 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || die "--version needs a value"
      ref="obsidian-bridge@$2"
      expected_version="$2"
      ref_explicit=1
      shift 2
      ;;
    --ref)
      [ "$#" -ge 2 ] || die "--ref needs a value"
      ref="$2"
      ref_explicit=1
      shift 2
      ;;
    --dir)
      [ "$#" -ge 2 ] || die "--dir needs a value"
      install_dir="$2"
      shift 2
      ;;
    --vault)
      [ "$#" -ge 2 ] || die "--vault needs a value"
      vault="$2"
      shift 2
      ;;
    --with-semantic)
      # 0.25.22: the standalone server has no vector builder. Keep the message
      # explicit instead of installing 380 MB that search cannot use.
      die "--with-semantic is not supported standalone: semantic search is built by the Paseo plugin"
      ;;
    --no-semantic)
      # Accepted for scripts written for 0.23.x–0.24.x; lexical is the only mode.
      shift
      ;;
    --no-skills)
      with_skills=0
      shift
      ;;
    --with-planning-skills)
      with_planning_skills=1
      planning_explicit=1
      shift
      ;;
    --no-planning-skills)
      with_planning_skills=0
      planning_explicit=1
      shift
      ;;
    --skills-dir)
      [ "$#" -ge 2 ] || die "--skills-dir needs a value"
      skills_dir="$2"
      shift 2
      ;;
    --source)
      [ "$#" -ge 2 ] || die "--source needs a value"
      source_arg="$2"
      shift 2
      ;;
    --uninstall)
      uninstall=1
      shift
      ;;
    --force)
      force=1
      shift
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1 (see --help)"
      ;;
  esac
done

if [ -n "$source_arg" ] && [ "$ref_explicit" = 1 ]; then
  die "--source cannot be combined with --ref or --version"
fi

install_dir="$(absolute_path "${install_dir%/}")"
skills_dir="$(absolute_path "${skills_dir%/}")"

if [ "$install_dir" = "/" ] || [ -z "$install_dir" ] || contains_path "$install_dir" "$HOME"; then
  die "refusing to use '$install_dir' as the installation directory"
fi
if contains_path "$install_dir" "$skills_dir"; then
  die "the installation directory '$install_dir' must not contain the skills directory '$skills_dir'"
fi
if [ -n "$vault" ]; then
  vault_abs="$(vault_path "$vault")"
  if contains_path "$install_dir" "$vault_abs" || contains_path "$vault_abs" "$install_dir"; then
    die "the installation directory '$install_dir' and the vault '$vault_abs' must not contain each other"
  fi
fi

check_node() {
  command -v node >/dev/null 2>&1 || die "node is not on PATH; install Node.js 22.13 or newer."
  local major minor
  major="$(node -p 'process.versions.node.split(".")[0]')"
  minor="$(node -p 'process.versions.node.split(".")[1]')"
  if [ "$major" -lt 22 ] ||
    { [ "$major" -eq 22 ] && [ "$minor" -lt 13 ]; } ||
    { [ "$major" -eq 23 ] && [ "$minor" -lt 4 ]; }; then
    die "Node.js $(node -v) is too old: the index uses node:sqlite (22.13+ or 23.4+)."
  fi
  node -e 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(":memory:"); db.exec("CREATE VIRTUAL TABLE t USING fts5(x)"); db.close();' \
    >/dev/null 2>&1 ||
    die "this Node build has no node:sqlite with FTS5; install Node.js 22.13+ (or 23.4+) from nodejs.org."
}

# Removes only the skill directories this installer recorded, and only when
# their SKILL.md still carries the installer marker. Old generic planning-*
# directories need --force because another plugin or the user may own them.
remove_skills() {
  [ "$with_skills" = 1 ] || return 0
  local manifest="$install_dir/installed-skills.txt"
  local names name target removed=0
  if [ -f "$manifest" ]; then
    names="$(cat "$manifest")"
  else
    # An installation that was made with --no-skills (or by 0.23.x–0.24.x,
    # which recorded nothing) must not lose a skill directory that another
    # installation may own. --force is the explicit escape hatch.
    names=""
  fi
  for name in $names; do
    case "$name" in *[!A-Za-z0-9._-]* | "") continue ;; esac
    target="$skills_dir/$name"
    [ -d "$target" ] || continue
    if ! grep -qF "$SKILL_MARKER" "$target/SKILL.md" 2>/dev/null; then
      info "skipping $target: not marked as installed by obsidian-bridge"
      continue
    fi
    if [ "$dry_run" = 1 ]; then
      info "would remove $target"
    else
      rm -rf -- "$target"
      info "removed $target"
    fi
    removed=1
  done
  if [ "$force" = 1 ]; then
    for name in $LEGACY_SKILL_NAMES; do
      target="$skills_dir/$name"
      [ -d "$target" ] || continue
      if [ "$dry_run" = 1 ]; then
        info "would remove legacy $target"
      else
        rm -rf -- "$target"
        info "removed legacy $target"
      fi
      removed=1
    done
  fi
  [ "$removed" = 1 ] || info "no skill directories installed by obsidian-bridge in $skills_dir"
}

do_uninstall() {
  info "Removing the standalone installation in $install_dir"
  if [ ! -f "$install_dir/install.json" ] && [ "$force" != 1 ]; then
    die "'$install_dir' has no install.json; refusing to delete it (use --force if it is a partial install)"
  fi
  remove_skills
  if [ -d "$install_dir" ]; then
    if [ "$dry_run" = 1 ]; then
      info "would remove $install_dir"
    else
      rm -rf -- "$install_dir"
      info "removed $install_dir"
    fi
  else
    info "no installation at $install_dir"
  fi
  info "Remove the server from your MCP client configuration if it is still listed."
}

script_path=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  script_path="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

work=""
cleanup() {
  if [ -n "${work:-}" ]; then
    rm -rf -- "$work"
  fi
  return 0
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM

prepare_source() {
  if [ -n "$source_arg" ]; then
    [ -f "$source_arg/package.json" ] && [ -d "$source_arg/server" ] ||
      die "--source $source_arg is not an obsidian-bridge checkout"
    source_dir="$(cd "$source_arg" && pwd)"
    build_ref="local"
    info "Using the local checkout: $source_dir"
    return
  fi
  # Explicit --ref/--version wins over the checkout autodetection: asking for
  # another release while standing in a checkout must not install the working
  # tree. Without an explicit ref, running the script from a checkout builds
  # what is there, so an uncommitted fix can be installed.
  if [ "$ref_explicit" = 0 ] &&
    [ -n "$script_path" ] &&
    [ -f "$script_path/package.json" ] &&
    [ -f "$script_path/server/mcp-server.ts" ]; then
    source_dir="$script_path"
    build_ref="local"
    info "Using the checkout this script was run from: $source_dir"
    return
  fi

  # Nothing local (or an explicit ref): build the release this script ships
  # with unless the caller pinned another ref (0.24.21).
  if [ "$ref_explicit" = 0 ]; then
    ref="obsidian-bridge@$SCRIPT_VERSION"
    ref_defaulted=1
  fi
  build_ref="$ref"
  info "Release: $build_ref"
  local target_ref="$build_ref"
  work="$(mktemp -d)"
  if command -v git >/dev/null 2>&1; then
    info "Cloning $REPO at $target_ref"
    if git clone --depth 1 --branch "$target_ref" "https://github.com/$REPO.git" "$work/clone" >/dev/null 2>&1; then
      source_dir="$work/clone/$PLUGIN_SUBDIR"
    fi
  fi
  if [ -z "${source_dir:-}" ]; then
    local url="https://codeload.github.com/$REPO/tar.gz/$target_ref"
    info "Downloading $url"
    mkdir -p "$work/archive"
    curl -fsSL "$url" -o "$work/src.tar.gz" ||
      die "could not download $url — if this version has no tag yet, pass --ref main"
    tar -xzf "$work/src.tar.gz" -C "$work/archive" || die "could not extract $url"
    source_dir="$(find "$work/archive" -maxdepth 2 -type d -name "$PLUGIN_SUBDIR" | head -n 1)"
  fi
  [ -n "${source_dir:-}" ] && [ -f "$source_dir/package.json" ] ||
    die "the source does not contain $PLUGIN_SUBDIR/package.json"
}

read_version() {
  node -e 'process.stdout.write(require(require("node:path").resolve(process.argv[1])).version)' \
    "$source_dir/package.json"
}

# A tag whose package.json disagrees with the script that carries it would
# install something other than what the caller asked for. Do not suggest
# --ref with the same tag: --ref bypasses this check by design.
check_version() {
  if [ -n "$expected_version" ] && [ "$version" != "$expected_version" ]; then
    die "--version $expected_version downloaded a tag whose package.json says $version"
  fi
  [ "$ref_defaulted" = 1 ] || return 0
  [ "$version" = "$SCRIPT_VERSION" ] ||
    die "$build_ref contains version $version, but this installer ships $SCRIPT_VERSION; the tag is not this release. Use a matching --version or a different --ref."
}

build_stage() {
  # A local checkout is built in a scratch directory too, so the working tree
  # never gains a node_modules or a dist it did not have.
  [ -n "$work" ] || work="$(mktemp -d)"
  local stage="$work/stage"
  mkdir -p "$stage"
  cp -R "$source_dir/server" "$source_dir/shared" "$source_dir/scripts" "$stage/"
  if [ -d "$source_dir/skills" ]; then cp -R "$source_dir/skills" "$stage/"; fi

  # The bundler reads only `version` from package.json; a minimal manifest keeps
  # `npm install` from pulling the plugin's dev dependencies (655 MB) instead of
  # the three packages the bundle needs (20 MB). Exact versions keep the
  # installer's output stable for the tag that carries it.
  printf '{"name":"obsidian-bridge","private":true,"version":"%s"}\n' "$version" >"$stage/package.json"

  info "Installing the build tools (esbuild, zod, yaml)"
  (cd "$stage" &&
    npm install --no-save --no-audit --no-fund --ignore-scripts \
      esbuild@0.25.12 zod@4.4.3 yaml@2.9.1 >/dev/null) ||
    die "npm install of the build tools failed"
  info "Bundling dist/mcp-server.js"
  (cd "$stage" && node scripts/bundle-mcp-server.mjs >/dev/null) || die "the bundle failed"
  [ -f "$stage/dist/mcp-server.js" ] || die "the bundle produced no dist/mcp-server.js"
}

old_skills=""
capture_old_skills() {
  local manifest="$install_dir/installed-skills.txt"
  if [ -f "$manifest" ]; then
    old_skills="$(cat "$manifest")"
  fi
}

install_files() {
  capture_old_skills
  if [ -d "$install_dir" ] && [ ! -f "$install_dir/install.json" ] && [ "$force" != 1 ]; then
    if [ -n "$(ls -A -- "$install_dir" 2>/dev/null)" ]; then
      die "'$install_dir' is not empty and is not an obsidian-bridge installation; use --force to install there"
    fi
  fi
  mkdir -p "$install_dir"
  rm -rf -- "$install_dir/dist" "$install_dir/skills"
  rm -f -- "$install_dir/installed-skills.txt" "$install_dir/install.json"
  cp -R "$work/stage/dist" "$install_dir/dist"
  if [ -d "$source_dir/skills" ]; then cp -R "$source_dir/skills" "$install_dir/skills"; fi
  if [ -f "$source_dir/README.md" ]; then cp "$source_dir/README.md" "$install_dir/README.md"; fi
  if [ -f "$source_dir/AGENT-SETUP.md" ]; then
    cp "$source_dir/AGENT-SETUP.md" "$install_dir/AGENT-SETUP.md"
  fi
  if [ -f "$source_dir/settings.example.json" ]; then
    cp "$source_dir/settings.example.json" "$install_dir/settings.example.json"
  fi
  printf '{"name":"obsidian-bridge","private":true,"version":"%s"}\n' "$version" >"$install_dir/package.json"
  if [ "$with_skills" = 0 ] && [ -n "$old_skills" ]; then
    printf '%s\n' "$old_skills" >"$install_dir/installed-skills.txt"
  fi
}

# Writes settings.json atomically and always leaves it 0600. A fresh file gets
# `semanticSearch: false` because this installation cannot build vectors; an
# existing value is preserved, so an update never silently changes a user's
# semantic choice. A file that is not ours is backed up before being replaced.
write_settings() {
  node - "$install_dir/settings.json" "$vault" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [file, vault] = process.argv.slice(2);
let doc = { writtenBy: "obsidian-bridge", values: {} };
let fresh = true;
try {
  const stat = fs.lstatSync(file);
  if (!stat.isFile()) throw new Error("not a regular file");
  const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  if (parsed && typeof parsed === "object" && parsed.writtenBy === "obsidian-bridge" &&
      parsed.values && typeof parsed.values === "object" && !Array.isArray(parsed.values)) {
    doc = parsed;
    fresh = false;
  } else {
    throw new Error("does not carry the obsidian-bridge marker");
  }
} catch (cause) {
  if (cause && cause.code !== "ENOENT" && fs.existsSync(file)) {
    const backup = `${file}.bak-${Date.now()}`;
    fs.copyFileSync(file, backup);
    fs.chmodSync(backup, 0o600);
    process.stderr.write(`obsidian-bridge-install: preserving the previous settings as ${backup}\n`);
  }
}
if (vault) doc.values.vaultPath = vault;
if (fresh && doc.values.semanticSearch === undefined) doc.values.semanticSearch = false;
const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
fs.writeFileSync(temp, JSON.stringify(doc, null, 2) + "\n", { mode: 0o600 });
fs.chmodSync(temp, 0o600);
fs.renameSync(temp, file);
fs.chmodSync(file, 0o600);
NODE
  info "Settings: $install_dir/settings.json (0600)"
}

# Records what this installer actually put into the user's skills root. Only
# `obsidian-bridge` is installed by default; the planning skills are opt-in and
# carry an `obsidian-` prefix, so they cannot collide with another plugin.
install_skills() {
  [ "$with_skills" = 1 ] || return 0
  [ -d "$install_dir/skills" ] || return 0
  mkdir -p "$skills_dir"
  # Keep a planning choice sticky across updates: a caller who installed the
  # planning skills and then runs the update command without the flag must not
  # silently lose them from the manifest.
  if [ "$planning_explicit" = 0 ] && printf '%s\n' "$old_skills" | grep -q '^obsidian-planning-'; then
    with_planning_skills=1
  fi
  local manifest="$install_dir/installed-skills.txt"
  : >"$manifest"
  local names="$SKILL_CORE"
  [ "$with_planning_skills" = 1 ] && names="$names $SKILL_PLANNING"
  local name src target
  for name in $names; do
    src="$install_dir/skills/$name"
    [ -d "$src" ] || die "the source does not ship skills/$name"
    target="$skills_dir/$name"
    if [ "$dry_run" = 1 ]; then
      info "would install skill $target"
      continue
    fi
    rm -rf -- "$target"
    mkdir -p "$target"
    cp -R "$src"/. "$target"/
    printf '%s\n' "$name" >>"$manifest"
    info "skill: $target"
  done
}

# install.json is written last: it is both the version marker and the
# standalone-home marker, so it must not describe a partial installation.
write_install_json() {
  node - "$install_dir/install.json" "$install_dir/installed-skills.txt" "$version" "${build_ref:-local}" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [file, manifest, version, ref] = process.argv.slice(2);
const skills = fs.existsSync(manifest)
  ? fs.readFileSync(manifest, "utf-8").split("\n").map((name) => name.trim()).filter(Boolean)
  : [];
const doc = {
  version,
  ref,
  installedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  semantic: false,
  skills,
};
const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
fs.writeFileSync(temp, JSON.stringify(doc) + "\n", { mode: 0o644 });
fs.renameSync(temp, file);
NODE
}

print_summary() {
  local node_bin
  node_bin="$(command -v node)"
  cat <<EOF

Installed obsidian-bridge $version in $install_dir

Add this to your MCP client configuration:

EOF
  node - "$node_bin" "$install_dir/dist/mcp-server.js" <<'NODE'
const [command, entry] = process.argv.slice(2);
const doc = { mcpServers: { "obsidian-bridge": { command, args: [entry] } } };
process.stdout.write(JSON.stringify(doc, null, 2) + "\n");
NODE
  cat <<EOF

The server resolves its own home from dist/../install.json, so the block needs
no environment variable. Point it at a vault with --vault <path>, by editing
$install_dir/settings.json, or with OBSIDIAN_VAULT_PATH.

Read $install_dir/AGENT-SETUP.md for the settings, the tools and troubleshooting.
EOF
}

source_label="obsidian-bridge@$SCRIPT_VERSION (the release this script belongs to)"
if [ "$ref_explicit" = 1 ]; then
  source_label="$ref"
elif [ -n "$source_arg" ]; then
  source_label="the local checkout $source_arg"
elif [ -n "$script_path" ] &&
  [ -f "$script_path/package.json" ] &&
  [ -f "$script_path/server/mcp-server.ts" ]; then
  source_label="the checkout this script was run from"
fi

info "obsidian-bridge standalone installer"
info "  install directory: $install_dir"
info "  source:            $source_label"
info "  semantic search:   lexical + graph only (standalone has no vector builder)"
info "  skills:            $([ "$with_skills" = 1 ] && echo "$skills_dir" || echo skipped)"

if [ "$uninstall" = 1 ]; then
  do_uninstall
  exit 0
fi

if [ "$dry_run" = 1 ]; then
  check_node
  prepare_source
  version="$(read_version)"
  check_version
  info "  plugin version:    $version"
  info "Plan: build the bundle, install into $install_dir, write settings.json, install $([ "$with_skills" = 1 ] && echo "skills into $skills_dir" || echo "no skills")."
  exit 0
fi

check_node
prepare_source
version="$(read_version)"
check_version
info "Plugin version: $version"
info "Release:        ${build_ref:-local}"
if [ -n "$vault" ] && [ ! -d "$vault" ]; then
  info "warning: '$vault' is not a directory yet; every tool will refuse until it exists."
fi

build_stage
install_files
write_settings
install_skills
write_install_json
print_summary
