import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { appHome, checking, exec, layout, openOverlay, props, run, setShared, shared, theme } from "herdr";

const PROVIDERS = [
  { id: "claude", name: "Claude", hint: "Claude Code sign-in" },
  { id: "chatgpt", name: "ChatGPT", hint: "Codex sign-in" },
  { id: "copilot", name: "GitHub Copilot", hint: "GitHub CLI sign-in (experimental)" },
];

// The layout block's `providers` prop picks and orders what the panel offers; without it, all of them.
// The settings popup is a second copy of the mod, handed the panel's props as `start`.
function offeredProviders() {
  const wanted = (props()?.menu ? props().start : props())?.providers;
  if (!Array.isArray(wanted) || !wanted.length) return PROVIDERS;
  return wanted.map((id) => PROVIDERS.find((provider) => provider.id === id)).filter(Boolean);
}

// The offered providers the person has not turned off. Only these are queried.
function shownProviders() {
  const off = saved().off;
  return offeredProviders().filter((provider) => !off.includes(provider.id));
}

// How often to read, in minutes. Anthropic rate-limits its usage endpoint, so nothing shorter is offered.
const INTERVALS = [2, 5, 15];
function interval() {
  const minutes = saved().minutes;
  return INTERVALS.includes(minutes) ? minutes : 5;
}

const ids = (providers) => providers.map((provider) => provider.id).join(",");

// What the person chose, kept by Herdr across restarts. The store is shared by every mod, hence the prefix.
const SAVED = "herdr-quota.settings";
function saved() {
  const stored = shared(SAVED);
  return { expanded: {}, off: [], ...(stored && typeof stored === "object" ? stored : {}) };
}
function save(change) {
  setShared(SAVED, { ...saved(), ...change });
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
  if (used >= 60 || aheadOfPace(window)) return t.working;
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

// Using quota 10 or more points faster than an even pace through the window.
// Not below 20% used: just after a reset almost any use is ahead of pace, and none of it is a worry.
function aheadOfPace(window) {
  const pace = paceMark(window);
  const used = Number(window.usedPercent) || 0;
  return pace !== null && used >= 20 && used - pace >= 10;
}

// The window that most needs attention: one nearly used up, then one ahead of pace, then the most used.
function urgentWindow(windows) {
  const rank = (window) => (window.usedPercent >= 85 ? 2 : aheadOfPace(window) ? 1 : 0);
  return windows.reduce((urgent, window) => (!urgent || rank(window) > rank(urgent)
    || (rank(window) === rank(urgent) && window.usedPercent > urgent.usedPercent) ? window : urgent), null);
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
    // The settings popup only draws; the panel does the reading.
    if (props()?.menu) return;
    this.windows = {};
    this.errors = {};
    this.absent = {};
    this.paused = {};
    this.busy = false;
    this.updatedAt = null;
    this.refresh(cx);
    if (checking()) return;
    // One tick a minute moves countdowns and ages on, and reads again once the chosen interval has passed.
    cx.timer.every(60000, (cx) => {
      if (Date.now() - this.ranAt >= interval() * 60000 - 5000) this.refresh(cx);
      else cx.notify();
    });
  }

  refresh(cx) {
    if (this.busy || checking()) return;
    const collector = `${appHome()}/mods/quota/collect.mjs`;
    const shown = shownProviders();
    this.queried = ids(shown);
    this.ranAt = Date.now();
    this.busy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        // With no ids the collector reads every provider, so an empty choice must not reach it.
        const only = shown.length < PROVIDERS.length ? shown.map((provider) => provider.id) : [];
        const result = shown.length ? await exec("node", [collector, ...only], { timeout: 25000 }) : { code: 0, stdout: "{}" };
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
    // The panel's top border, its header, the rows and the padding beneath them.
    const px = Math.ceil(1 + 41 + height + 10);
    if (block && block.size.px !== px) run("layout.resize", { id: block.id, px });
  }

  openSettings() {
    const offered = offeredProviders();
    openOverlay({
      mod: "quota",
      kind: "popup",
      width: 230,
      height: 10 + 28 + offered.length * 30 + 34 + INTERVALS.length * 30,
      props: { menu: true, start: props() ?? {}, absent: offered.filter((provider) => this.hidden(provider)).map((provider) => provider.id) },
    });
  }

  settings(t) {
    const off = saved().off;
    const absent = props().absent || [];
    const row = (id, label, on, act, note) => h_flex().id(id).h(30).px(8).gap(8).rounded(6).items_center().cursor_pointer()
      .hover((el) => el.bg(t.hover))
      .on_click(act)
      .child(div().flex_1().min_w(0).truncate().text_color(on ? t.foreground : t.muted).child(label))
      .when(Boolean(note), (el) => el.child(div().flex_none().text_size(10).text_color(t.dim).child(note)))
      .child(div().size(14).flex_none()
        .when(on, (el) => el.child(svg("mods/workspace-chrome/check.svg").size(14).text_color(t.accent))));
    return v_flex().id("quota-settings-menu").w_full().p(5).bg(t.popover).text_size(12.5)
      .child(div().px(8).pt(6).pb(4).text_size(10.5).text_color(t.dim).child("Providers to check"))
      .children(offeredProviders().map((provider) => {
        const on = !off.includes(provider.id);
        return row(`quota-toggle-${provider.id}`, provider.name, on,
          () => save({ off: on ? [...off, provider.id] : off.filter((id) => id !== provider.id) }),
          on && absent.includes(provider.id) ? "not signed in" : "");
      }))
      .child(div().px(8).pt(12).pb(4).text_size(10.5).text_color(t.dim).child("Refresh every"))
      .children(INTERVALS.map((minutes) => row(`quota-interval-${minutes}`, `${minutes} minutes`, minutes === interval(),
        () => save({ minutes }))));
  }

  // Never signed in, and no earlier reading to show: these get no row.
  hidden(provider) {
    return Boolean(this.absent[provider.id]) && !this.windows[provider.id]?.windows?.length;
  }

  provider(t, provider) {
    const data = this.windows[provider.id];
    const error = this.errors[provider.id] || data?.note;
    const windows = Array.isArray(data?.windows) ? data.windows : [];
    // How old a failed refresh left the reading, then why it failed.
    const note = [data?.stale ? staleLabel(data.fetchedAt) : "", error].filter(Boolean).join(" · ");
    // An idle Claude Code is not a failure, so its note stays dim.
    const quiet = Boolean(this.paused[provider.id]);
    const current = urgentWindow(windows);
    const currentUsed = current ? Math.round(current.usedPercent) : null;
    const open = Boolean(saved().expanded[provider.id]);
    const plan = typeof data?.plan === "string" ? data.plan.charAt(0).toUpperCase() + data.plan.slice(1) : "";
    return v_flex().gap(5)
      .child(h_flex().id(`quota-${provider.id}`).items_center().gap(7).cursor_pointer()
        .on_click(() => save({ expanded: { ...saved().expanded, [provider.id]: !open } }))
        .child(div().flex_none().text_color(t.foreground).font_semibold().child(provider.name))
        .child(div().flex_1().min_w(0).truncate().text_size(9).text_color(t.dim).child(plan))
        .when(current && !open, (el) => el.child(div().flex_none().text_size(10).text_color(t.dim).child(current.label)))
        .when(current && !open, (el) => el.child(div().flex_none().text_size(11).font_semibold()
          .text_color(colorFor(t, current, t.foreground)).child(`${currentUsed}% used`)))
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none().text_color(t.dim)))
      .when(!windows.length, (el) => el.when(open || Boolean(error), (inner) => inner
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

  render(cx) {
    const t = theme();
    if (props()?.menu) return this.settings(t);
    // A change in the settings popup arrives as a re-render: read again for the new choice.
    const shown = shownProviders();
    if (ids(shown) !== this.queried && !this.busy && !checking()) cx.spawn(async (cx) => this.refresh(cx));
    // The runtime ignores toLocaleTimeString's options, so drop the seconds by hand.
    const updated = this.updatedAt ? new Date(this.updatedAt).toLocaleTimeString().replace(/(\d+:\d+):\d+/, "$1") : null;
    const hidden = shown.filter((provider) => this.hidden(provider));
    return v_flex().id("quota-panel").size_full().min_h(0).bg(t.chrome).border_t(1).border_color(t.border)
      .text_size(13)
      .child(h_flex().h(41).pl(16).pr(10).pt(14).pb(5).flex_none().items_center().justify_between()
        .child(div().text_size(11.5).font_medium().text_color(t.dim).child("Quota"))
        .child(h_flex().items_center().gap(3)
        .child(div().mr(4).text_size(10).text_color(t.dim).child(this.busy ? "Updating…" : updated || "Not updated"))
        .child(div().id("quota-settings").size(26).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.dim)
          .hover((el) => el.bg(t.hover).text_color(t.foreground))
          .tooltip("Quota settings")
          .on_click(() => this.openSettings())
          .child(svg("mods/workspace-chrome/settings.svg").size(13)))
        .child(div().id("quota-refresh").size(26).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.dim)
          .hover((el) => el.bg(t.hover).text_color(t.foreground))
          .tooltip("Refresh quota")
          .on_click((_event, cx) => this.refresh(cx))
          .child("↻"))))
      .child(v_flex().id("quota-content").flex_1().min_h(0).pl(16).pr(12).pb(10).overflow_y_scrollbar().mode("always")
        .child(v_flex().id("quota-rows").flex_none().gap(12).on_size_change((size) => this.fit(size.height))
          .children(shown.filter((provider) => !this.hidden(provider)).map((provider) => this.provider(t, provider)))
          .when(!shown.length, (el) => el.child(div().text_size(10).text_color(t.dim).child("No providers selected")))
          .when(hidden.length > 0, (el) => el.child(div().text_size(10).text_color(t.dim)
            .child(`Not signed in: ${hidden.map((provider) => provider.name).join(", ")}`)))
          .when(Boolean(this.errors.panel), (el) => el.child(div().text_size(10).text_color(t.working).child(this.errors.panel)))));
  }
}
