import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, props, theme } from "herdr";

const PROVIDERS = [
  { id: "claude", name: "Claude", hint: "Claude Code sign-in" },
  { id: "chatgpt", name: "ChatGPT", hint: "Codex sign-in" },
  { id: "copilot", name: "GitHub Copilot", hint: "GitHub CLI sign-in (experimental)" },
];

function resetLabel(value) {
  if (!value) return "Reset time unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Reset time unavailable";
  const minutes = Math.max(0, Math.ceil((date.getTime() - Date.now()) / 60000));
  const remaining = minutes < 60 ? `${minutes}m` : minutes < 1440
    ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
    : `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`;
  return `Resets in ${remaining}`;
}

// Color only when quota is running low; a healthy reading stays neutral.
function colorFor(t, percent, healthy) {
  if (percent >= 85) return t.blocked;
  if (percent >= 60) return t.working;
  return healthy;
}

function staleLabel(timestamp) {
  if (!timestamp) return "Stale";
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  const age = minutes < 1 ? "just now" : minutes < 60 ? `${minutes}m ago`
    : `${Math.floor(minutes / 60)}h ago`;
  return `Stale · ${age}`;
}

function currentWindow(windows) {
  return windows.find((window) => /^(5h|5-hour|session)$/i.test(window.label))
    || windows[0];
}

export default class Quota extends View {
  init(_props, cx) {
    this.windows = {};
    this.errors = {};
    this.absent = {};
    this.expanded = {};
    this.busy = false;
    this.updatedAt = null;
    this.refresh(cx);
    cx.timer.every(300000, (cx) => this.refresh(cx));
    // Countdowns and ages move on between refreshes.
    cx.timer.every(60000, (cx) => cx.notify());
  }

  refresh(cx) {
    if (this.busy) return;
    const collector = props()?.collector;
    if (!collector) {
      this.errors = { panel: "Collector is not configured. Reinstall the mod from its repository." };
      cx.notify();
      return;
    }
    this.busy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const result = await exec("node", [collector], { timeout: 25000 });
        if (result.code !== 0) throw new Error("Quota collector failed");
        const snapshot = JSON.parse(result.stdout);
        this.windows = snapshot.providers || {};
        this.errors = snapshot.errors || {};
        this.absent = snapshot.absent || {};
        this.updatedAt = Date.now();
      } catch (error) {
        this.errors = { panel: String(error?.message || error) };
      } finally {
        this.busy = false;
        cx.notify();
      }
    });
  }

  provider(t, provider) {
    const data = this.windows[provider.id];
    const error = this.errors[provider.id] || data?.note;
    const windows = Array.isArray(data?.windows) ? data.windows : [];
    const absent = !windows.length && Boolean(this.absent[provider.id]);
    const current = currentWindow(windows);
    const currentRemaining = current ? Math.round(100 - current.usedPercent) : null;
    const open = Boolean(this.expanded[provider.id]);
    return v_flex().gap(5)
      .child(h_flex().id(`usage-${provider.id}`).items_center().gap(7).cursor_pointer()
        .on_click((_event, cx) => {
          this.expanded[provider.id] = !this.expanded[provider.id];
          cx.notify();
        })
        .child(div().flex_none().text_color(absent ? t.muted : t.foreground).font_semibold().child(provider.name))
        .child(div().flex_1().min_w(0).truncate().text_size(9).text_color(t.working)
          .child(data?.stale ? staleLabel(data.fetchedAt) : ""))
        .when(current && !open, (el) => el.child(div().flex_none().text_size(10).text_color(t.dim).child(current.label)))
        .when(current && !open, (el) => el.child(div().flex_none().text_size(11).font_semibold()
          .text_color(colorFor(t, current.usedPercent, t.foreground)).child(`${currentRemaining}% left`)))
        .when(absent, (el) => el.child(div().flex_none().text_size(10).text_color(t.dim).child("Not signed in")))
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none().text_color(t.dim)))
      .when(!windows.length, (el) => el.when(open || (Boolean(error) && !absent), (inner) => inner
        .child(div().text_size(11).text_color(error && !absent ? t.working : t.dim)
          .child(error || `${provider.hint} not detected`))))
      .when(open, (el) => el.children(windows.map((window) => {
        const used = Math.max(0, Math.min(100, Number(window.usedPercent) || 0));
        const remaining = 100 - used;
        return v_flex().gap(4)
          .child(h_flex().items_center().justify_between()
            .child(div().text_size(11).text_color(t.muted).child(window.label))
          .child(div().text_size(11).font_semibold().text_color(colorFor(t, used, t.foreground)).child(`${Math.round(remaining)}% left`)))
          .child(div().h(4).w_full().rounded(2).bg(t.border)
            .child(div().h_full().rounded(2).bg(colorFor(t, used, t.muted)).w(`${remaining}%`)))
          .child(div().text_size(10).text_color(t.dim).child(resetLabel(window.resetsAt)));
      })))
      .when(Boolean(error) && windows.length > 0, (el) => el.child(div().text_size(9.5)
        .text_color(t.working).child(error)));
  }

  render() {
    const t = theme();
    // The runtime ignores toLocaleTimeString's options, so drop the seconds by hand.
    const updated = this.updatedAt ? new Date(this.updatedAt).toLocaleTimeString().replace(/(\d+:\d+):\d+/, "$1") : null;
    return v_flex().id("usage-panel").size_full().min_h(0).bg(t.chrome).border_t(1).border_color(t.border)
      .text_size(13)
      .child(h_flex().h(41).pl(16).pr(10).pt(14).pb(5).flex_none().items_center().justify_between()
        .child(div().text_size(11.5).font_medium().text_color(t.dim).child("Quota"))
        .child(h_flex().items_center().gap(7)
        .child(div().text_size(10).text_color(t.dim).child(this.busy ? "Updating…" : updated || "Not updated"))
        .child(div().id("usage-refresh").size(26).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.dim)
          .hover((el) => el.bg(t.hover).text_color(t.foreground))
          .tooltip("Refresh usage")
          .on_click((_event, cx) => this.refresh(cx))
          .child("↻"))))
      .child(v_flex().id("usage-content").flex_1().min_h(0).pl(16).pr(12).pb(10).gap(12).overflow_y_scrollbar().mode("always")
        .children(PROVIDERS.map((provider) => this.provider(t, provider)))
        .when(Boolean(this.errors.panel), (el) => el.child(div().text_size(10).text_color(t.working).child(this.errors.panel))));
  }
}
