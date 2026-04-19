/**
 * Minimal Chrome DevTools Protocol client.
 *
 * We intentionally don't use Playwright or Puppeteer — attaching to a
 * Chrome instance that has many open tabs trips known handshake-timeout
 * bugs in Playwright-JS under Bun. The subset of CDP we need is small:
 *
 *   - open a new tab at a URL               (HTTP: `/json/new`)
 *   - navigate                               (`Page.navigate`)
 *   - wait for the page to stop loading      (`Page.lifecycleEvent`)
 *   - read the full rendered HTML            (`Runtime.evaluate`)
 *   - click an element by CSS selector       (`Runtime.evaluate`)
 *   - read the current URL                   (`Runtime.evaluate`)
 *   - close the tab                          (HTTP: `/json/close/{id}`)
 *
 * That's it — ~150 lines, no native deps, works anywhere Bun runs.
 */

const DEFAULT_CDP = "http://127.0.0.1:9222";

export interface CdpPage {
  /** Tab id (Chrome target ID). */
  readonly targetId: string;
  /** Navigate and wait for the load lifecycle event. */
  navigate(url: string, opts?: { timeoutMs?: number }): Promise<void>;
  /** Get full HTML as served by `document.documentElement.outerHTML`. */
  html(): Promise<string>;
  /** Return the current page URL. */
  url(): Promise<string>;
  /** Click the first element matching `selector`. Throws if not found. */
  click(selector: string): Promise<void>;
  /** Click the first button/link/role=button whose visible text equals
   *  or contains `text` (case-insensitive). Robust against the hashed
   *  CSS-in-JS class names that React sites like Squarespace ship. */
  clickByText(text: string): Promise<void>;
  /** Convenience sleep. */
  wait(ms: number): Promise<void>;
  /** Close the tab. */
  close(): Promise<void>;
}

interface CdpTargetInfo {
  id: string;
  type: string;
  webSocketDebuggerUrl: string;
  url: string;
}

export interface OpenTabOptions {
  cdpUrl?: string;
  /** Timeout for the full open+navigate cycle. */
  timeoutMs?: number;
}

export async function openTab(
  url: string,
  opts: OpenTabOptions = {},
): Promise<CdpPage> {
  const cdp = opts.cdpUrl ?? DEFAULT_CDP;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  // `PUT /json/new?<url>` creates a new tab. Note: GET is deprecated.
  const newRes = await fetch(
    `${cdp}/json/new?${encodeURIComponent(url)}`,
    { method: "PUT" },
  );
  if (!newRes.ok) {
    throw new Error(`CDP /json/new failed: HTTP ${newRes.status}`);
  }
  const target = (await newRes.json()) as CdpTargetInfo;
  const session = await CdpSession.connect(target, cdp);
  // Wait for the initial navigation to settle before returning the Page.
  await session.waitForLoad(timeoutMs);
  return session;
}

/**
 * A single websocket connection to one Chrome tab. One command at a
 * time is sufficient for our needs; we don't pipeline.
 */
class CdpSession implements CdpPage {
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
  }>();
  private lifecycleHandlers = new Set<(name: string) => void>();

  static async connect(target: CdpTargetInfo, cdpUrl: string): Promise<CdpSession> {
    const session = new CdpSession(target, cdpUrl);
    await session.open();
    return session;
  }

  constructor(
    private target: CdpTargetInfo,
    private cdpUrl: string,
    private ws: WebSocket | null = null,
  ) {}

  get targetId() {
    return this.target.id;
  }

  private async open() {
    this.ws = new WebSocket(this.target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      this.ws!.addEventListener("open", () => resolve(), { once: true });
      this.ws!.addEventListener("error", (e) => reject(new Error(String(e))), { once: true });
    });
    this.ws.addEventListener("message", (ev) => this.onMessage(ev.data as string));
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    await this.send("Page.setLifecycleEventsEnabled", { enabled: true });
  }

  private onMessage(raw: string) {
    const msg = JSON.parse(raw) as
      | { id: number; result?: unknown; error?: { message: string } }
      | { method: string; params?: Record<string, unknown> };
    if ("id" in msg) {
      const h = this.pending.get(msg.id);
      if (!h) return;
      this.pending.delete(msg.id);
      if ("error" in msg && msg.error) h.reject(new Error(msg.error.message));
      else h.resolve(msg.result);
      return;
    }
    if ("method" in msg && msg.method === "Page.lifecycleEvent" && msg.params) {
      const name = String(msg.params.name);
      for (const cb of this.lifecycleHandlers) cb(name);
    }
  }

  private send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      });
      this.ws!.send(JSON.stringify({ id, method, params: params ?? {} }));
    });
  }

  async waitForLoad(timeoutMs = 30_000): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.lifecycleHandlers.delete(onLifecycle);
        reject(new Error(`CDP load timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      const onLifecycle = (name: string) => {
        // "networkAlmostIdle" fires when the page is basically done;
        // "load" fires on the `load` event. We take whichever comes first
        // after navigation has started.
        if (name === "networkAlmostIdle" || name === "load") {
          clearTimeout(timer);
          this.lifecycleHandlers.delete(onLifecycle);
          resolve();
        }
      };
      this.lifecycleHandlers.add(onLifecycle);
    });
  }

  async navigate(url: string, opts: { timeoutMs?: number } = {}): Promise<void> {
    await this.send("Page.navigate", { url });
    await this.waitForLoad(opts.timeoutMs ?? 45_000);
  }

  async html(): Promise<string> {
    const res = await this.send<{ result: { value?: string } }>(
      "Runtime.evaluate",
      {
        expression: "document.documentElement.outerHTML",
        returnByValue: true,
      },
    );
    return res.result?.value ?? "";
  }

  async url(): Promise<string> {
    const res = await this.send<{ result: { value?: string } }>(
      "Runtime.evaluate",
      { expression: "location.href", returnByValue: true },
    );
    return res.result?.value ?? "";
  }

  async click(selector: string): Promise<void> {
    // We pass the selector as a constant string via JSON.stringify so
    // quoting is handled without injection risk.
    const expr = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error("selector not found: " + ${JSON.stringify(selector)});
      el.scrollIntoView({block: "center"});
      el.click();
      return true;
    })()`;
    await this.send("Runtime.evaluate", { expression: expr, awaitPromise: true });
  }

  async clickByText(text: string): Promise<void> {
    const needle = JSON.stringify(text.toLowerCase());
    const expr = `(() => {
      const needle = ${needle};
      const cands = document.querySelectorAll('button, a, [role="button"], [role="menuitem"]');
      let best = null;
      for (const el of cands) {
        const t = (el.textContent || "").trim().toLowerCase();
        if (t === needle) { best = el; break; }
        if (!best && t.includes(needle)) best = el;
      }
      if (!best) throw new Error("no clickable element with text: " + needle);
      best.scrollIntoView({block: "center"});
      best.click();
      return true;
    })()`;
    await this.send("Runtime.evaluate", { expression: expr, awaitPromise: true });
  }

  wait(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  async close(): Promise<void> {
    try {
      await fetch(
        `${this.cdpUrl}/json/close/${encodeURIComponent(this.target.id)}`,
      );
    } catch {
      /* tab may already be gone */
    }
    this.ws?.close();
    this.pending.forEach((h) =>
      h.reject(new Error("CDP session closed")),
    );
    this.pending.clear();
  }
}

/** Small helper: probe the CDP endpoint and return a helpful error. */
export async function pingCdp(cdpUrl: string = DEFAULT_CDP): Promise<void> {
  try {
    const res = await fetch(`${cdpUrl}/json/version`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    throw new Error(
      `Cannot reach Chrome CDP at ${cdpUrl}. Launch Chrome with --remote-debugging-port=9222. (${(e as Error).message})`,
    );
  }
}
