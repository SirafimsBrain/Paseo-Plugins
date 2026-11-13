import { useCallback, useEffect, useState } from "react";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import {
  reindexVault,
  vaultStatus,
  verifyVault,
  type VerifyVaultResult,
} from "../shared/contracts";
import { obsidianBridgeSettings } from "../shared/settings";
import { interfaceFontFamily, scaledFont, useHostTypography } from "./use-host-typography";

/**
 * Plugin settings screen (Paseo Settings → Plugins → Obsidian Bridge).
 *
 * Every setting of this plugin lives here — there is no side-channel HTTP
 * server. The vault path is the one value the plugin cannot infer, so the
 * screen validates it ("Check path") before indexing is started by saving it.
 */
export function ObsidianBridgeSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(obsidianBridgeSettings);
  const typography = useHostTypography();
  const font = (base: number) => scaledFont(base, typography);
  const uiFont = interfaceFontFamily(typography);
  const uiFontStyle = uiFont ? { fontFamily: uiFont } : null;
  const fg = theme.colors.foreground;
  const fgMuted = theme.colors.foregroundMuted;
  const accent = theme.colors.accent;
  const success = theme.colors.statusSuccess;
  const danger = theme.colors.statusDanger;

  const verifyRpc = useRpc(verifyVault);
  const statusRpc = useRpc(vaultStatus);
  const reindexRpc = useRpc(reindexVault);

  const [check, setCheck] = useState<VerifyVaultResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [indexMessage, setIndexMessage] = useState<string | null>(null);
  const [indexing, setIndexing] = useState(false);

  const currentPath = settings.status === "ready" ? settings.values.vaultPath : "";

  const runCheck = useCallback(
    async (path: string) => {
      if (path.trim().length === 0) {
        setCheck(null);
        return;
      }
      setChecking(true);
      try {
        setCheck(await verifyRpc({ path }));
      } catch (cause) {
        setCheck({
          ok: false,
          path,
          exists: false,
          isDirectory: false,
          isObsidianVault: false,
          markdownFiles: 0,
          capped: false,
          sample: [],
          error: cause instanceof Error ? cause.message : String(cause),
        });
      } finally {
        setChecking(false);
      }
    },
    [verifyRpc],
  );

  useEffect(() => {
    if (currentPath.trim().length > 0) void runCheck(currentPath);
  }, [currentPath, runCheck]);

  const rebuild = useCallback(async () => {
    setIndexing(true);
    setIndexMessage(null);
    try {
      const result = await reindexRpc({});
      setIndexMessage(
        result.ok
          ? `Indexed ${result.notes} notes (${result.chunks} chunks) in ${result.tookMs} ms.`
          : (result.error ?? "Reindex failed."),
      );
      void statusRpc({}).catch(() => undefined);
    } catch (cause) {
      setIndexMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIndexing(false);
    }
  }, [reindexRpc, statusRpc]);

  if (settings.status === "loading") {
    return (
      <View style={styles.container}>
        <Text style={{ color: fg, fontSize: font(13), ...uiFontStyle }}>Loading settings…</Text>
      </View>
    );
  }
  if (settings.status !== "ready") {
    return (
      <View style={styles.container}>
        <Text style={{ color: danger, fontSize: font(12), ...uiFontStyle }}>
          Settings are invalid: {settings.error}
        </Text>
      </View>
    );
  }

  const values = settings.values;
  const patch = (partial: Partial<typeof values>) => {
    void settings.save({ ...values, ...partial }, settings.revision);
  };

  return (
    <ScrollView style={styles.container}>
      {settings.saveError ? (
        <Text style={{ color: danger, fontSize: font(12), ...uiFontStyle }}>
          {settings.saveError}
        </Text>
      ) : null}

      <SettingsCard>
        <SettingsSection
          title="Directory available to Paseo"
          info="The one directory this plugin may touch. Agents cannot reach anything above it, and writes are confined to the roles below. Read from disk, so Obsidian does not need to be running."
        >
          <SettingsInput
            label="Directory path"
            hint="Absolute path, a ~ path, or a path relative to your home directory — either a whole vault or a project directory inside one, e.g. ~/.obsidian/Main/Paseo. Saving a valid path starts the first scan."
            initialValue={values.vaultPath}
            placeholder="/home/you/.obsidian/Main/Paseo"
            onChangeText={(text: string) => patch({ vaultPath: text })}
          />
          <SettingsAction
            label="Validate path"
            hint={
              check
                ? `${check.markdownFiles}${check.capped ? "+" : ""} Markdown files${
                    check.isObsidianVault ? " · looks like an Obsidian vault" : " · no .obsidian folder"
                  }`
                : "Checks the path before it is used for indexing."
            }
            actionLabel={checking ? "Checking…" : "Check path"}
            onPress={() => void runCheck(values.vaultPath)}
            disabled={checking || values.vaultPath.trim().length === 0}
          />
          {check ? (
            <Text
              style={{
                color: check.ok ? success : danger,
                fontSize: font(11),
                ...uiFontStyle,
              }}
              numberOfLines={5}
            >
              {check.ok
                ? `OK — ${check.markdownFiles}${check.capped ? "+" : ""} notes found${
                    check.sample.length > 0 ? `, e.g. ${check.sample[0]}` : ""
                  }`
                : (check.error ?? "This path cannot be used.")}
            </Text>
          ) : null}
          <SettingsSwitch
            label="Indexing enabled"
            hint="Pause indexing without clearing the path. The last index stays readable while paused."
            value={values.indexingEnabled}
            onValueChange={(enabled: boolean) => patch({ indexingEnabled: enabled })}
          />
          <SettingsAction
            label="Rebuild index"
            hint="Forces a full scan of the vault right now."
            actionLabel={indexing ? "Indexing…" : "Reindex now"}
            onPress={() => void rebuild()}
            disabled={indexing || values.vaultPath.trim().length === 0}
          />
          {indexMessage ? (
            <Text style={{ color: fgMuted, fontSize: font(11), ...uiFontStyle }} numberOfLines={4}>
              {indexMessage}
            </Text>
          ) : null}
        </SettingsSection>
      </SettingsCard>

      <SettingsCard>
        <SettingsSection
          title="Directories"
          info="Paths relative to the directory above. Agents are told which directory is for what, and write only inside these roles."
        >
          <SettingsInput
            label="Inbox (incoming documents)"
            hint="Converted documents, reference books, primary sources. Read; append only when the user asks. Empty = no inbox role."
            initialValue={values.inboxDir}
            placeholder="Inbox"
            onChangeText={(text: string) => patch({ inboxDir: text })}
          />
          <SettingsInput
            label="Documentation (authored documents)"
            hint="Where an agent writes the extended document it was asked for. Created on demand; appends only."
            initialValue={values.outDir}
            placeholder="Documentation"
            onChangeText={(text: string) => patch({ outDir: text })}
          />
          <SettingsInput
            label="Raw (intermediate documents)"
            hint="Scratch material the agent may compose freely: clarifications, bugfix alternatives, temporary notes that lose value after the work."
            initialValue={values.rawDir}
            placeholder="raw"
            onChangeText={(text: string) => patch({ rawDir: text })}
          />
        </SettingsSection>
      </SettingsCard>

      <SettingsCard>
        <SettingsSection
          title="Indexing"
          info="Which notes are indexed, how often the index is reconciled, and how the full-text index tokenizes text."
        >
          <SettingsInput
            label="Include folders"
            hint="Comma-separated vault-relative folders, e.g. Projects, Research. Empty = the whole vault."
            initialValue={values.includeFolders}
            placeholder="(whole vault)"
            onChangeText={(text: string) => patch({ includeFolders: text })}
          />
          <SettingsInput
            label="Exclude globs"
            hint="Comma-separated vault-relative globs, * and ** supported. .obsidian is always excluded."
            initialValue={values.excludeGlobs}
            placeholder=".obsidian/**, .trash/**"
            onChangeText={(text: string) => patch({ excludeGlobs: text })}
          />
          <SettingsSwitch
            label="Porter stemming"
            hint="English-only stemmer. Leave off for mixed Russian/English vaults; changing it triggers a full reindex."
            value={values.ftsStemming}
            onValueChange={(enabled: boolean) => patch({ ftsStemming: enabled })}
          />
          <SettingsInput
            label="Reconcile interval (minutes)"
            hint="Background full compare against the vault. File changes are picked up by the watcher immediately; this covers missed events."
            initialValue={String(values.reconcileMinutes)}
            onChangeText={(text: string) => {
              const parsed = Number.parseInt(text, 10);
              if (Number.isFinite(parsed) && String(parsed) === text.trim()) {
                patch({ reconcileMinutes: parsed });
              }
            }}
          />
        </SettingsSection>
      </SettingsCard>

      <SettingsCard>
        <SettingsSection
          title="Search"
          info="Defaults for the obsidian_search tool and the panel's search box."
        >
          <SettingsInput
            label="Max results"
            hint="Hits per search, 1–50."
            initialValue={String(values.maxResults)}
            onChangeText={(text: string) => {
              const parsed = Number.parseInt(text, 10);
              if (Number.isFinite(parsed) && String(parsed) === text.trim()) {
                patch({ maxResults: parsed });
              }
            }}
          />
          <SettingsInput
            label="Answer budget (characters)"
            hint="Upper bound for the text block returned to an agent. Snippets are trimmed to fit."
            initialValue={String(values.searchBudgetChars)}
            onChangeText={(text: string) => {
              const parsed = Number.parseInt(text, 10);
              if (Number.isFinite(parsed) && String(parsed) === text.trim()) {
                patch({ searchBudgetChars: parsed });
              }
            }}
          />
          <SettingsInput
            label="Snippet length (characters)"
            hint="How much of each matching chunk is shown per hit."
            initialValue={String(values.snippetChars)}
            onChangeText={(text: string) => {
              const parsed = Number.parseInt(text, 10);
              if (Number.isFinite(parsed) && String(parsed) === text.trim()) {
                patch({ snippetChars: parsed });
              }
            }}
          />
        </SettingsSection>
      </SettingsCard>

      <SettingsCard>
        <SettingsSection
          title="Semantic search"
          info="Local embeddings from @huggingface/transformers, fused with full text and the link graph. Runs in-process: no Ollama, no Python, no external service. The model is downloaded once (~118 MB for q8)."
        >
          <SettingsSwitch
            label="Semantic signal"
            hint="Adds meaning-based matches to search (works across Russian and English). Lexical search keeps working while vectors are still being built."
            value={values.semanticSearch}
            onValueChange={(enabled: boolean) => patch({ semanticSearch: enabled })}
          />
          <SettingsInput
            label="Embedding model"
            hint="Hugging Face repo with ONNX weights. Default: Xenova/multilingual-e5-small (384 dimensions, Russian + English)."
            initialValue={values.embeddingModel}
            onChangeText={(text: string) => patch({ embeddingModel: text })}
          />
          <SettingsInput
            label="Model dtype"
            hint="q8 ≈ 118 MB and is the measured default (batch 1); fp32 ≈ 470 MB; q4 is smaller and less accurate."
            initialValue={values.embeddingDtype}
            onChangeText={(text: string) => patch({ embeddingDtype: text })}
          />
          <SettingsInput
            label="Unload model after (minutes)"
            hint="0 keeps it loaded. Memory is a warning, not a limit: up to 2 GB is normal, 2–4 GB is reported in the panel."
            initialValue={String(values.embeddingIdleMinutes)}
            onChangeText={(text: string) => {
              const parsed = Number.parseInt(text, 10);
              if (Number.isFinite(parsed) && String(parsed) === text.trim()) {
                patch({ embeddingIdleMinutes: parsed });
              }
            }}
          />
        </SettingsSection>
      </SettingsCard>

      <SettingsCard>
        <SettingsSection
          title="Integration"
          info="Agents receive read-only vault tools. They are available so an agent can answer an explicit request; nothing here makes an agent consult the vault on its own."
        >
          <SettingsSwitch
            label="Give agents the vault tools"
            hint="Injects the obsidian-bridge MCP server into every agent, or the equivalent native tools for providers without MCP support."
            value={values.injectIntoAgents}
            onValueChange={(enabled: boolean) => patch({ injectIntoAgents: enabled })}
          />
          <SettingsSwitch
            label="Refuse writes"
            hint="Turns every write tool off. Writes are already append-only and confined to the inbox/out/raw directories, so this is an extra brake."
            value={values.readOnly}
            onValueChange={(enabled: boolean) => patch({ readOnly: enabled })}
          />
          <SettingsInput
            label="Max document size (characters)"
            hint="Upper bound for one written body; larger documents are rejected with a request to split them."
            initialValue={String(values.maxWriteChars)}
            onChangeText={(text: string) => {
              const parsed = Number.parseInt(text, 10);
              if (Number.isFinite(parsed) && String(parsed) === text.trim()) {
                patch({ maxWriteChars: parsed });
              }
            }}
          />
          <Text style={{ color: fgMuted, fontSize: font(10), ...uiFontStyle }}>
            The vault is read from disk; the Obsidian application does not have to be running.
          </Text>
        </SettingsSection>
      </SettingsCard>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 12, gap: 8 },
});
