import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { appHome, checking, exec, layout, props, run, theme } from "herdr";

const PROVIDERS = [
  { id: "claude", name: "Claude", hint: "Claude Code sign-in" },
  { id: "chatgpt", name: "ChatGPT", hint: "Codex sign-in" },
  { id: "copilot", name: "GitHub Copilot", hint: "GitHub CLI sign-in (experimental)" },
];

// The layout block's `providers` prop picks and orders the rows; without it, all of them.
function shownProviders() {
  const wanted = props()?.providers;
  if (!Array.isArray(wanted) || !wanted.length) return PROVIDERS;
  return wanted.map((id) => PROVIDERS.find((provider) => provider.id === id)).filter(Boolean);
}

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

// Color only when quota is running low or going faster than an even pace; a healthy reading stays neutral.
function colorFor(t, window, healthy) {
  const used = Number(window.usedPercent) || 0;
  if (used >= 85) return t.blocked;
  const pace = paceMark(window);
  if (used >= 60 || (pace !== null && used - pace >= 10)) return t.working;
  return healthy;
}

function staleLabel(timestamp) {
  if (!timestamp) return "Stale";
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  const age = minutes < 1 ? "under 1m" : minutes < 60 ? `${minutes}m`
    : `${Math.floor(minutes / 60)}h`;
  return `Stale, ${age} old`;
}

// How much would be used by now at an even pace through the window: the share of it that has passed.
function paceMark(window) {
  const length = window.resetsAt - window.startsAt;
  if (!(length > 0)) return null;
  return Math.max(0, Math.min(100, (Date.now() - window.startsAt) / length * 100));
}

// The window closest to running out, which is the one that will block first.
function tightestWindow(windows) {
  return windows.reduce((tightest, window) => (!tightest || window.usedPercent > tightest.usedPercent ? window : tightest), null);
}

// The layout block showing this mod, when a column gives it a fixed height.
function fixedBlock(node, parent) {
  if (node?.content?.mod === "quota") return parent?.type === "column" && node.size?.px ? node : null;
  for (const child of node?.children || []) {
    const found = fixedBlock(child, node);
    if (found) return found;
  }
  return null;
}

export default class Quota extends View {
  init(_props, cx) {
    this.windows = {};
    this.errors = {};
    this.absent = {};
    this.paused = {};
    this.expanded = {};
    this.busy = false;
    this.updatedAt = null;
    this.refresh(cx);
    if (checking()) return;
    cx.timer.every(300000, (cx) => this.refresh(cx));
    // Countdowns and ages move on between refreshes.
    cx.timer.every(60000, (cx) => cx.notify());
  }

  refresh(cx) {
    if (this.busy || checking()) return;
    const collector = `${appHome()}/mods/quota/collect.mjs`;
    this.busy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const only = shownProviders().length < PROVIDERS.length ? shownProviders().map((provider) => provider.id) : [];
        const result = await exec("node", [collector, ...only], { timeout: 25000 });
        if (result.code !== 0) throw new Error("Quota collector failed");
        const snapshot = JSON.parse(result.stdout);
        this.windows = snapshot.providers || {};
        this.errors = snapshot.errors || {};
        this.absent = snapshot.absent || {};
        this.paused = snapshot.paused || {};
        // The newest reading, not this run: a run inside a minute returns cached readings.
        const fetched = Object.values(this.windows).map((provider) => provider?.fetchedAt).filter(Number.isFinite);
        this.updatedAt = fetched.length ? Math.max(...fetched) : null;
      } catch (error) {
        this.errors = { panel: String(error?.message || error) };
      } finally {
        this.busy = false;
        cx.notify();
      }
    });
  }

  // Keeps the block as tall as its rows, so nothing is cut off or left empty.
  fit(height) {
    if (checking()) return;
    const block = fixedBlock(layout());
    const px = Math.ceil(41 + height + 10);
    if (block && block.size.px !== px) run("layout.resize", { id: block.id, px });
  }

  provider(t, provider) {
    const data = this.windows[provider.id];
    const error = this.errors[provider.id] || data?.note;
    const windows = Array.isArray(data?.windows) ? data.windows : [];
    // How old a failed refresh left the reading, then why it failed.
    const note = [data?.stale ? staleLabel(data.fetchedAt) : "", error].filter(Boolean).join(" · ");
    const absent = !windows.length && Boolean(this.absent[provider.id]);
    // An idle Claude Code is not a failure, so its note stays dim.
    const quiet = absent || Boolean(this.paused[provider.id]);
    const current = tightestWindow(windows);
    const currentUsed = current ? Math.round(current.usedPercent) : null;
    const open = Boolean(this.expanded[provider.id]);
    const plan = typeof data?.plan === "string" ? data.plan.charAt(0).toUpperCase() + data.plan.slice(1) : "";
    return v_flex().gap(5)
      .child(h_flex().id(`quota-${provider.id}`).items_center().gap(7).cursor_pointer()
        .on_click((_event, cx) => {
          this.expanded[provider.id] = !this.expanded[provider.id];
          cx.notify();
        })
        .child(div().flex_none().text_color(absent ? t.muted : t.foreground).font_semibold().child(provider.name))
        .child(div().flex_1().min_w(0).truncate().text_size(9).text_color(t.dim).child(plan))
        .when(current && !open, (el) => el.child(div().flex_none().text_size(10).text_color(t.dim).child(current.label)))
        .when(current && !open, (el) => el.child(div().flex_none().text_size(11).font_semibold()
          .text_color(colorFor(t, current, t.foreground)).child(`${currentUsed}% used`)))
        .when(absent, (el) => el.child(div().flex_none().text_size(10).text_color(t.dim).child("Not signed in")))
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none().text_color(t.dim)))
      .when(!windows.length, (el) => el.when(open || (Boolean(error) && !absent), (inner) => inner
        .child(div().text_size(11).text_color(error && !quiet ? t.working : t.dim)
          .child(error || `${provider.hint} not detected`))))
      .when(open, (el) => el.children(windows.map((window) => {
        const used = Math.max(0, Math.min(100, Number(window.usedPercent) || 0));
        const pace = paceMark(window);
        return v_flex().gap(4)
          .child(h_flex().items_center().justify_between()
            .child(div().text_size(11).text_color(t.muted).child(window.label))
          .child(div().text_size(11).font_semibold().text_color(colorFor(t, window, t.foreground)).child(`${Math.round(used)}% used`)))
          .child(div().relative().h(4).w_full().rounded(2).bg(t.border)
            .child(div().h_full().rounded(2).bg(colorFor(t, window, t.muted)).w(`${used}%`))
            .when(pace !== null, (el) => el.child(div().absolute().top(-2).left(`${pace}%`).ml(-1).w(2).h(8).bg(t.foreground))))
          .child(div().text_size(10).text_color(t.dim).child(resetLabel(window.resetsAt)));
      })))
      .when(Boolean(note) && windows.length > 0, (el) => el.child(div().text_size(9.5)
        .text_color(quiet ? t.dim : t.working).child(note)));
  }

  render() {
    const t = theme();
    // The runtime ignores toLocaleTimeString's options, so drop the seconds by hand.
    const updated = this.updatedAt ? new Date(this.updatedAt).toLocaleTimeString().replace(/(\d+:\d+):\d+/, "$1") : null;
    return v_flex().id("quota-panel").size_full().min_h(0).bg(t.chrome).border_t(1).border_color(t.border)
      .text_size(13)
      .child(h_flex().h(41).pl(16).pr(10).pt(14).pb(5).flex_none().items_center().justify_between()
        .child(div().text_size(11.5).font_medium().text_color(t.dim).child("Quota"))
        .child(h_flex().items_center().gap(7)
        .child(div().text_size(10).text_color(t.dim).child(this.busy ? "Updating…" : updated || "Not updated"))
        .child(div().id("quota-refresh").size(26).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.dim)
          .hover((el) => el.bg(t.hover).text_color(t.foreground))
          .tooltip("Refresh quota")
          .on_click((_event, cx) => this.refresh(cx))
          .child("↻"))))
      .child(v_flex().id("quota-content").flex_1().min_h(0).pl(16).pr(12).pb(10).overflow_y_scrollbar().mode("always")
        .child(v_flex().id("quota-rows").flex_none().gap(12).on_size_change((size) => this.fit(size.height))
          .children(shownProviders().map((provider) => this.provider(t, provider)))
          .when(Boolean(this.errors.panel), (el) => el.child(div().text_size(10).text_color(t.working).child(this.errors.panel)))));
  }
}
