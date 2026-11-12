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
          title="Vault"
          info="The local Obsidian vault this plugin indexes. It is read from disk, so Obsidian does not need to be running."
        >
          <SettingsInput
            label="Vault path"
            hint="Absolute path of the vault folder (the directory that contains your notes and the .obsidian folder). Saving a valid path starts the first scan — no project files are ever written."
            initialValue={values.vaultPath}
            placeholder="/home/you/Obsidian/MyVault"
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
            label="Read-only"
            hint="Reserved for the write tools planned in 0.2.0. 0.1.0 ships read-only tools, so this switch has no effect yet."
            value={values.readOnly}
            onValueChange={(enabled: boolean) => patch({ readOnly: enabled })}
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
