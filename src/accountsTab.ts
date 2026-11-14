// Settings → Accounts: every subscription saved per agent CLI, and one click
// to make another one the login that CLI uses. The backend (accounts.rs) does
// the saving and swapping; this is the list.

import { invoke } from "@tauri-apps/api/core";
import { markSvg } from "./paneIcons";
import type { ConfirmOptions } from "./confirm";
import "./accounts.css";

type ProviderId = "claude" | "codex" | "gemini";

interface Account {
  id: string;
  email: string;
  plan: string;
  org: string;
  active: boolean;
  addedAt: number;
}

interface ProviderAccounts {
  provider: ProviderId;
  installed: boolean;
  accounts: Account[];
}

const PROVIDERS: Record<ProviderId, { name: string; desc: string; keywords: string }> = {
  claude: {
    name: "Claude Code",
    desc: "Claude Pro, Max, Team and Enterprise subscriptions.",
    keywords: "anthropic claude subscription login account switch usage limit",
  },
  codex: {
    name: "Codex",
    desc: "ChatGPT Plus, Pro and Business subscriptions.",
    keywords: "openai chatgpt codex subscription login account switch usage limit",
  },
  gemini: {
    name: "Gemini CLI",
    desc: "Google accounts signed in to Gemini.",
    keywords: "google gemini subscription login account switch usage limit",
  },
};

export interface AccountsTabOptions {
  confirm(opts: ConfirmOptions): Promise<boolean>;
  /** Leave settings and run a command in a new terminal pane. */
  runInTerminal(command: string): void;
}

export function createAccountsTab(opts: AccountsTabOptions) {
  const el = document.createElement("div");
  el.className = "accounts-tab";

  let data: ProviderAccounts[] = [];
  let seen = "";
  let busy = false;
  const notices = new Map<ProviderId, { text: string; tone: "ok" | "bad" | "" }>();

  function say(provider: ProviderId, text: string, tone: "ok" | "bad" | "" = ""): void {
    notices.set(provider, { text, tone });
  }

  async function run(provider: ProviderId, call: () => Promise<ProviderAccounts[] | void>): Promise<void> {
    if (busy) return;
    busy = true;
    el.classList.add("busy");
    try {
      const next = await call();
      if (next) data = next;
    } catch (e) {
      say(provider, String(e), "bad");
    } finally {
      busy = false;
      el.classList.remove("busy");
      seen = JSON.stringify(data);
      draw();
    }
  }

  function switchTo(p: ProviderAccounts, a: Account): void {
    void run(p.provider, async () => {
      const next = await invoke<ProviderAccounts[]>("accounts_switch", { provider: p.provider, id: a.id });
      say(
        p.provider,
        `Now using ${a.email}. New ${PROVIDERS[p.provider].name} sessions start on it; restart ones already running to move them over.`,
        "ok"
      );
      return next;
    });
  }

  async function remove(p: ProviderAccounts, a: Account): Promise<void> {
    const ok = await opts.confirm({
      title: `Remove ${a.email}?`,
      message: `OpenTerm forgets this ${PROVIDERS[p.provider].name} login. The subscription itself isn't affected, and you can add it again by signing in.`,
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    notices.delete(p.provider);
    void run(p.provider, () => invoke<ProviderAccounts[]>("accounts_remove", { provider: p.provider, id: a.id }));
  }

  function addAccount(p: ProviderAccounts): void {
    void run(p.provider, async () => {
      const command = await invoke<string>("accounts_begin_login", { provider: p.provider });
      say(p.provider, "Finish signing in in the terminal. The new account appears here on its own.");
      opts.runInTerminal(command);
    });
  }

  function row(p: ProviderAccounts, a: Account): HTMLElement {
    const r = document.createElement("div");
    r.className = "acct-row";
    r.classList.toggle("active", a.active);
    r.dataset.search = `${a.email} ${a.plan} ${a.org}`.toLowerCase();

    const avatar = document.createElement("span");
    avatar.className = "acct-avatar";
    avatar.textContent = (a.email.trim()[0] ?? "?").toUpperCase();

    const main = document.createElement("div");
    main.className = "acct-main";
    const email = document.createElement("div");
    email.className = "acct-email";
    email.textContent = a.email || "Unknown account";
    email.title = a.email;
    main.appendChild(email);
    const meta = [a.plan, a.org].filter(Boolean).join(" · ");
    if (meta) {
      const sub = document.createElement("div");
      sub.className = "acct-meta";
      sub.textContent = meta;
      main.appendChild(sub);
    }

    const side = document.createElement("div");
    side.className = "acct-side";
    if (a.active) {
      const pill = document.createElement("span");
      pill.className = "acct-active";
      pill.textContent = "In use";
      side.appendChild(pill);
    } else {
      const use = document.createElement("button");
      use.type = "button";
      use.className = "btn-secondary";
      use.textContent = "Switch";
      use.title = `Use ${a.email} for ${PROVIDERS[p.provider].name}`;
      use.addEventListener("click", () => switchTo(p, a));
      const del = document.createElement("button");
      del.type = "button";
      del.className = "acct-remove";
      del.title = "Remove this account";
      del.setAttribute("aria-label", `Remove ${a.email}`);
      del.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>`;
      del.addEventListener("click", () => void remove(p, a));
      side.append(use, del);
    }

    r.append(avatar, main, side);
    return r;
  }

  function section(p: ProviderAccounts): HTMLElement {
    const info = PROVIDERS[p.provider];
    const s = document.createElement("section");
    s.className = "settings-section acct-section";
    s.dataset.search = `${info.name} ${info.keywords}`.toLowerCase();

    const head = document.createElement("div");
    head.className = "settings-section-head";
    const brand = document.createElement("span");
    brand.className = "acct-brand";
    brand.innerHTML = markSvg(p.provider);
    const text = document.createElement("div");
    text.className = "settings-section-text";
    const h = document.createElement("h2");
    h.textContent = info.name;
    const d = document.createElement("p");
    d.className = "settings-section-desc";
    d.textContent = info.desc;
    text.append(h, d);
    head.append(brand, text);

    if (p.installed) {
      const actions = document.createElement("div");
      actions.className = "settings-section-actions";
      const add = document.createElement("button");
      add.type = "button";
      add.className = p.accounts.length ? "btn-secondary" : "btn-primary";
      add.textContent = p.accounts.length ? "Add account" : "Sign in";
      add.title = `Sign in to another ${info.name} account in a new terminal`;
      add.addEventListener("click", () => addAccount(p));
      actions.appendChild(add);
      head.appendChild(actions);
    }

    const body = document.createElement("div");
    body.className = "settings-section-body";
    if (p.accounts.length) {
      body.append(...p.accounts.map((a) => row(p, a)));
    } else {
      const empty = document.createElement("div");
      empty.className = "settings-empty-note";
      empty.textContent = p.installed
        ? `Not signed in. Sign in once and ${info.name} shows up here.`
        : `${info.name} isn't set up on this computer.`;
      body.appendChild(empty);
    }

    const n = notices.get(p.provider);
    if (n?.text) {
      const note = document.createElement("div");
      note.className = `field-hint acct-notice ${n.tone}`;
      note.textContent = n.text;
      body.appendChild(note);
    }

    s.append(head, body);
    return s;
  }

  function draw(): void {
    // Settings search hides rows it doesn't match; a redraw must not undo that.
    const hidden = new Set(
      Array.from(el.querySelectorAll<HTMLElement>("[data-search][hidden]")).map((x) => x.dataset.search)
    );
    el.replaceChildren(...data.map(section));
    for (const x of Array.from(el.querySelectorAll<HTMLElement>("[data-search]"))) {
      if (hidden.has(x.dataset.search)) x.hidden = true;
    }
  }

  /** Re-reads the accounts. Cheap, and it's also what notices a new sign-in. */
  async function refresh(): Promise<void> {
    if (busy) return;
    try {
      const next = await invoke<ProviderAccounts[]>("accounts_list");
      const key = JSON.stringify(next);
      if (busy || key === seen) return;
      // A new account just landed: the "finish signing in" hint has done its job.
      for (const p of next) {
        const before = data.find((d) => d.provider === p.provider);
        if (before && p.accounts.length > before.accounts.length) notices.delete(p.provider);
      }
      data = next;
      seen = key;
      draw();
    } catch {
      /* the next tick tries again */
    }
  }

  // Only while the page is on screen: a sign-in finishing in a terminal or the
  // browser should show up without the user having to ask.
  const visible = () => el.offsetParent !== null;
  setInterval(() => {
    if (visible() && document.hasFocus()) void refresh();
  }, 3000);
  window.addEventListener("focus", () => {
    if (visible()) void refresh();
  });
  void refresh();

  return { el, refresh };
}
