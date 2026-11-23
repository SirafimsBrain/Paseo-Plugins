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

# The release this script belongs to (0.24.22).
#
# `curl … | bash` from a tag URL fetches this file at that tag, so the version
# here is the tag the caller asked for. The default source is therefore that
# tag, not `main`: the build, `install.json`'s `version` and `ref` all describe
# the release whose installer was run, however much `main` has moved since.
# The release workflow refuses to publish a tag that disagrees with this value.
SCRIPT_VERSION="0.24.22"
DEFAULT_HOME="${HOME}/.agents/obsidian-bridge-mcp"
SKILL_NAMES="obsidian-bridge planning-create planning-execute planning-review"

ref=""
ref_explicit=0
ref_defaulted=0
build_ref=""
install_dir="${OBSIDIAN_BRIDGE_HOME:-$DEFAULT_HOME}"
vault=""
with_semantic=0
with_skills=1
skills_dir="${HOME}/.agents/skills"
source_arg=""
uninstall=0
dry_run=0

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
  --vault <path>        Vault root to write into settings.json.
  --with-semantic       Also install the optional embedding stack (~380 MB).
  --no-semantic         Lexical search only, the default.
  --no-skills           Do not copy the Agent Skills into the skills root.
  --skills-dir <path>   Skills root (default ~/.agents/skills).
  --source <path>       Build from a local checkout instead of downloading.
  --uninstall           Remove the installation and its skill directories.
  --dry-run             Print the plan and exit without changing anything.
  -h, --help            This text.

Environment:
  OBSIDIAN_BRIDGE_HOME  Install directory, same as --dir.
  OBSIDIAN_BRIDGE_REPO  owner/repo on GitHub (default SirafimsBrain/Paseo-Plugins).

After installing, point your MCP client at <dir>/dist/mcp-server.js; the script
prints the exact block. Requirements: Node.js >= 22.13 (node:sqlite with FTS5).
EOF
}

info() { printf '%s\n' "$*"; }
die() { printf 'obsidian-bridge-install: %s\n' "$*" >&2; exit 1; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || die "--version needs a value"
      ref="obsidian-bridge@$2"
      ref_explicit=1
      shift 2
      ;;
    --ref)
      [ "$#" -ge 2 ] || die "--ref needs a value"
      ref="$2"
      ref_explicit=1
      shift
      shift
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
      with_semantic=1
      shift
      ;;
    --no-semantic)
      with_semantic=0
      shift
      ;;
    --no-skills)
      with_skills=0
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

install_dir="${install_dir%/}"

check_node() {
  command -v node >/dev/null 2>&1 || die "node is not on PATH; install Node.js 22.13 or newer."
  local major minor
  major="$(node -p 'process.versions.node.split(".")[0]')"
  minor="$(node -p 'process.versions.node.split(".")[1]')"
  if [ "$major" -lt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -lt 13 ]; }; then
    die "Node.js $(node -v) is too old: the index uses node:sqlite (22.13 or newer)."
  fi
  node -e 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(":memory:"); db.exec("CREATE VIRTUAL TABLE t USING fts5(x)"); db.close();' \
    >/dev/null 2>&1 ||
    die "this Node build has no node:sqlite with FTS5; install Node.js 22.13+ from nodejs.org."
}

remove_skills() {
  local name removed=0
  for name in $SKILL_NAMES; do
    if [ -d "$skills_dir/$name" ]; then
      if [ "$dry_run" = 1 ]; then
        info "would remove $skills_dir/$name"
      else
        rm -rf "$skills_dir/$name"
        info "removed $skills_dir/$name"
      fi
      removed=1
    fi
  done
  [ "$removed" = 1 ] || info "no skill directories in $skills_dir"
}

do_uninstall() {
  case "$install_dir" in
    "" | "/" | "$HOME") die "refusing to remove '$install_dir'" ;;
  esac
  info "Removing the standalone installation in $install_dir"
  remove_skills
  if [ -d "$install_dir" ]; then
    if [ "$dry_run" = 1 ]; then
      info "would remove $install_dir"
    else
      rm -rf "$install_dir"
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
cleanup() { [ -n "$work" ] && rm -rf "$work"; }
trap cleanup EXIT INT TERM

prepare_source() {
  if [ -n "$source_arg" ]; then
    [ -f "$source_arg/package.json" ] && [ -d "$source_arg/server" ] ||
      die "--source $source_arg is not an obsidian-bridge checkout"
    source_dir="$(cd "$source_arg" && pwd)"
    build_ref="local"
    info "Using the local checkout: $source_dir"
    return
  fi
  # Running the script from a checkout (git clone … && ./obsidian-bridge/obsidian-bridge-install.sh)
  # builds what is in the working tree, so an uncommitted fix can be installed.
  if [ -n "$script_path" ] && [ -f "$script_path/package.json" ] && [ -f "$script_path/server/mcp-server.ts" ]; then
    source_dir="$script_path"
    build_ref="local"
    info "Using the checkout this script was run from: $source_dir"
    return
  fi

  # Nothing local: build the release this script ships with unless the caller
  # pinned another ref (0.24.21).
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
# install something other than what the caller asked for.
check_version() {
  [ "$ref_defaulted" = 1 ] || return 0
  [ "$version" = "$SCRIPT_VERSION" ] ||
    die "$build_ref contains version $version, but this installer ships $SCRIPT_VERSION; use --ref $build_ref explicitly"
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
  # the three packages the bundle needs (20 MB).
  printf '{"name":"obsidian-bridge","private":true,"version":"%s"}\n' "$version" >"$stage/package.json"

  info "Installing the build tools (esbuild, zod, yaml)"
  (cd "$stage" && npm install --no-save --no-audit --no-fund esbuild@^0.25.12 zod@^4.4.3 yaml@^2.9.1 >/dev/null) ||
    die "npm install of the build tools failed"
  info "Bundling dist/mcp-server.js"
  (cd "$stage" && node scripts/bundle-mcp-server.mjs >/dev/null) || die "the bundle failed"
  [ -f "$stage/dist/mcp-server.js" ] || die "the bundle produced no dist/mcp-server.js"
}

install_files() {
  mkdir -p "$install_dir"
  rm -rf "$install_dir/dist" "$install_dir/skills"
  cp -R "$work/stage/dist" "$install_dir/dist"
  if [ -d "$source_dir/skills" ]; then cp -R "$source_dir/skills" "$install_dir/skills"; fi
  if [ -f "$source_dir/README.md" ]; then cp "$source_dir/README.md" "$install_dir/README.md"; fi
  if [ -f "$source_dir/AGENT-SETUP.md" ]; then
    cp "$source_dir/AGENT-SETUP.md" "$install_dir/AGENT-SETUP.md"
  fi
  printf '{"name":"obsidian-bridge","private":true,"version":"%s"}\n' "$version" >"$install_dir/package.json"
  printf '{"version":"%s","ref":"%s","installedAt":"%s","semantic":%s}\n' \
    "$version" "${build_ref:-main}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "$([ "$with_semantic" = 1 ] && echo true || echo false)" >"$install_dir/install.json"
}

install_semantic() {
  [ "$with_semantic" = 1 ] || return 0
  info "Installing the embedding stack (@huggingface/transformers, ~380 MB)"
  (cd "$install_dir" && npm install --no-save --omit=dev --no-audit --no-fund '@huggingface/transformers@^3.8.1' >/dev/null) ||
    die "npm install of @huggingface/transformers failed"
}

write_settings() {
  local semantic_value="0"
  [ "$with_semantic" = 1 ] && semantic_value="1"
  node - "$install_dir/settings.json" "$vault" "$semantic_value" <<'NODE'
const fs = require("node:fs");
const [file, vault, semantic] = process.argv.slice(2);
let doc = { writtenBy: "obsidian-bridge", values: {} };
try {
  const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  if (parsed && typeof parsed === "object" && parsed.writtenBy === "obsidian-bridge" &&
      parsed.values && typeof parsed.values === "object" && !Array.isArray(parsed.values)) {
    doc = parsed;
  }
} catch {
  // No settings yet: start from the defaults the server compiles in.
}
if (vault) doc.values.vaultPath = vault;
doc.values.semanticSearch = semantic === "1";
fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n", { mode: 0o600 });
NODE
  info "Settings: $install_dir/settings.json"
}

install_skills() {
  [ "$with_skills" = 1 ] || return 0
  [ -d "$install_dir/skills" ] || return 0
  mkdir -p "$skills_dir"
  local src name
  for src in "$install_dir"/skills/*/; do
    [ -d "$src" ] || continue
    name="$(basename "$src")"
    mkdir -p "$skills_dir/$name"
    cp -R "$src"/. "$skills_dir/$name/"
    info "skill: $skills_dir/$name"
  done
}

print_summary() {
  local node_bin
  node_bin="$(command -v node)"
  cat <<EOF

Installed obsidian-bridge $version in $install_dir

Add this to your MCP client configuration:

  {
    "mcpServers": {
      "obsidian-bridge": {
        "command": "$node_bin",
        "args": ["$install_dir/dist/mcp-server.js"]
      }
    }
  }

The server resolves its own home from dist/../install.json, so the block needs
no environment variable. Point it at a vault with --vault <path>, by editing
$install_dir/settings.json, or with OBSIDIAN_VAULT_PATH.

Read $install_dir/AGENT-SETUP.md for the settings, the tools and troubleshooting.
EOF
}

info "obsidian-bridge standalone installer"
info "  install directory: $install_dir"
if [ "$ref_explicit" = 1 ]; then
  info "  source:            $ref"
elif [ -n "$source_arg" ]; then
  info "  source:            the local checkout $source_arg"
elif [ -n "$script_path" ] && [ -f "$script_path/package.json" ] && [ -f "$script_path/server/mcp-server.ts" ]; then
  info "  source:            the checkout this script was run from"
else
  info "  source:            obsidian-bridge@$SCRIPT_VERSION (the release this script belongs to)"
fi
info "  semantic search:   $([ "$with_semantic" = 1 ] && echo enabled || echo lexical only)"
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
install_semantic
write_settings
install_skills
print_summary
