// Terminal runtime glue (stage B2): wraps ghostty-web's Terminal + FitAddon
// into a mountable component. The PTY bridge (stage B3) will feed bytes
// through `terminal.write`; for now the terminal renders a banner so the
// runtime can be exercised in isolation.

import { FitAddon, Terminal, init } from "ghostty-web";

export interface MountedTerminal {
  terminal: Terminal;
  fitAddon: FitAddon;
  dispose: () => void;
}

export interface MountOptions {
  fontSize?: number;
  fontFamily?: string;
  cursorBlink?: boolean;
  cursorStyle?: "block" | "bar" | "underline";
  theme?: {
    background?: string;
    foreground?: string;
    cursor?: string;
  };
  banner?: string;
}

let initPromise: Promise<void> | null = null;

function ensureInit(): Promise<void> {
  if (initPromise === null) {
    initPromise = init();
  }
  return initPromise;
}

export async function mountTerminal(
  container: HTMLElement,
  options: MountOptions = {},
): Promise<MountedTerminal> {
  await ensureInit();

  const terminal = new Terminal({
    cols: 80,
    rows: 24,
    fontSize: options.fontSize,
    fontFamily: options.fontFamily,
    cursorBlink: options.cursorBlink,
    cursorStyle: options.cursorStyle,
    theme: options.theme,
    scrollback: 1000,
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  terminal.open(container);
  fitAddon.fit();
  fitAddon.observeResize();

  if (options.banner) {
    terminal.write(options.banner);
  }

  const dispose = (): void => {
    try {
      fitAddon.dispose();
    } catch {
      // ignore
    }
    try {
      terminal.dispose();
    } catch {
      // ignore
    }
  };

  return { terminal, fitAddon, dispose };
}
