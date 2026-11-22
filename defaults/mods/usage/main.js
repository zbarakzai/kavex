import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { closeOverlay, openOverlay, props, run, setShared, settings, shared, theme } from "herdr";
import { checking, POPOVER_HEIGHT, POPOVER_WIDTH, subscriptions } from "./checks.js";
import { look, MONO, soft } from "./look.js";
import { loader } from "./loader.js";

const ICONS = "mods/workspace-chrome/icons";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * 24 * 60;
const INSET = 14;
const ROSTER_CHROME = 151;
const DETAIL_WIDTH = POPOVER_WIDTH - 2 * (INSET + 1);

const rowId = (row) => `${row.agent}-${row.who ?? row.machine ?? "local"}`;
const limitId = (row, limit) => `${rowId(row)}-${limit.key ?? limit.label}`;

function presentation() {
  const pref = shared("usage.presentation");
  return {
    display: pref?.display === "remaining" ? "remaining" : "used",
    mode: pref?.mode === "verbose" ? "verbose" : "compact",
  };
}

function changePreference(change) {
  setShared("usage.presentation", { ...presentation(), ...change });
}

function percent(used, display = "used") {
  if (!Number.isFinite(used)) return 0;
  const clamped = Math.round(Math.max(0, Math.min(100, used)));
  return display === "remaining" ? 100 - clamped : clamped;
}

function duration(ms) {
  if (ms <= 0) return "now";
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
  const hours = Math.floor(ms / HOUR);
  const minutes = Math.floor((ms % HOUR) / MINUTE);
  if (ms < DAY) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  const days = Math.floor(ms / DAY), rest = hours % 24;
  return rest ? `${days}d ${rest}h` : `${days}d`;
}

function resetLabel(at, now, long = false) {
  if (!Number.isFinite(at)) return null;
  const remaining = duration(at - now);
  if (!long) return remaining;
  return remaining === "now" ? "Resets now" : `Resets in ${remaining}`;
}

const timed = (limits) => limits.map((limit) => limit.resetsAt).filter(Number.isFinite);

function nextReset(limits, now) {
  const resets = timed(limits);
  const pending = resets.filter((at) => at > now);
  return resetLabel(Math.min(...(pending.length ? pending : resets)), now, true);
}

function relativeUpdate(at, now) {
  if (!Number.isFinite(at) || !at) return "Not yet updated";
  const elapsed = now - at;
  if (elapsed < MINUTE) return "Updated just now";
  const since = elapsed < HOUR ? `${Math.floor(elapsed / MINUTE)}m` : `${Math.floor(elapsed / HOUR)}h`;
  return `Updated ${since} ago`;
}

function planLabel(plan) {
  return plan && !/^unknown$/i.test(plan) ? String(plan).replaceAll("_", " ") : null;
}

const compareUsed = (a, b) => percent(b.used) - percent(a.used);
const scoped = (row, limit) => limit.scoped || (row.agent === "claude" && /^fable(?: weekly)?$/i.test(limit.label));
const primaryLimits = (row) => row.limits.filter((limit) => !scoped(row, limit));
const rank = (row) => Math.max(-1, ...primaryLimits(row).map((limit) => percent(limit.used)));

function headline(row) {
  const primary = primaryLimits(row);
  const cursor = row.agent === "cursor" && primary.find((limit) => limit.label?.toLowerCase() === "models");
  return cursor || primary.sort(compareUsed)[0] || null;
}

function shortLabel(limit) {
  const { minutes, label } = limit;
  if (!minutes || limit.scoped || (label && !/^((this )?(week|month)|weekly|monthly|\d+ (minutes?|hours?|days?))$/i.test(label))) return label ?? "Usage";
  if (minutes === WEEK) return "wk";
  if (minutes % WEEK === 0) return `${minutes / WEEK}wk`;
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

const localOpenCode = (row) => row.agent === "opencode" && !row.machine;
const consentKey = (row) => row.machine ? `${row.agent}|${row.machine}` : row.agent;

function consent(row) {
  return localOpenCode(row) ? shared("usage.opencode") : shared("usage.consent")?.[consentKey(row)];
}

function consentDomain(row) {
  return row.consentDomain ?? (localOpenCode(row) ? "opencode.ai" : null);
}

function status(row, pending) {
  if (row.ask) {
    const answer = consent(row);
    if (answer === true) return "Loading usage…";
    return answer === false ? "Usage access declined" : "Connect usage";
  }
  if (row.state === "signed-out" || row.state === "missing-credentials" || row.state === "sign-in") return "not signed in";
  if (row.failed || row.state === "error") return row.error ?? "Could not check";
  if (row.expired) return "Refresh needed";
  if (row.state === "unavailable" || row.state === "unsupported") return row.error ?? "Usage unavailable";
  if ((row.state === "fetching" || row.state === "idle" || row.state === "loading" || pending) && !row.checkedAt) return "Loading usage…";
  if (row.balances?.length || Number.isFinite(row.extraUsage?.balance)) return "Balance available";
  return "No usage data";
}

function providerGlyph(row, k, size = 13) {
  if (!row.icon) return icon("terminal", size, k.muted);
  return row.tint ? svg(row.icon).size(size).flex_none().text_color(k.foreground) : image(row.icon).size(size).flex_none();
}

function providerTile(row, k) {
  return h_flex().size(20).flex_none().items_center().justify_center()
    .rounded(6).border_1().border_color(k.border).bg(k.raised).child(providerGlyph(row, k));
}

function miniBar(id, used, display, k, width, height = 5, health = false) {
  const utilization = percent(used);
  let fill = soft(k.muted, "66");
  if (health) {
    if (utilization >= 90) fill = k.failed;
    else if (utilization >= 80) fill = k.ansi3 ?? k.blocked;
    else fill = k.added;
  }
  return div().w(width).h(height).flex_none().rounded_full().overflow_hidden().bg(k.row_ring)
    .child(div().id(`bar-${id}`).h_full().w(width * percent(used, display) / 100)
      .rounded_full().bg(fill).transition("width", 300));
}

function value(used, display, size, k) {
  return div().flex_none().font_family(MONO).text_right().font_medium().text_size(size).text_color(k.foreground)
    .child(`${percent(used, display)}%`);
}

const rule = (k) => div().w_full().h(1).flex_none().bg(soft(k.row_ring, "b3"));
const icon = (name, size, color) => svg(`${ICONS}/${name}.svg`).size(size).flex_none().text_color(color);

const control = (id, label, action, k) => h_flex().id(id).flex_none().items_center().justify_center()
  .accessibility_label(label).rounded(5).cursor_pointer().text_color(k.muted)
  .hover((s) => s.bg(k.hover_strong).text_color(k.foreground))
  .on_click(action);

function detailMetric(row, limit, display, k) {
  const id = limitId(row, limit);
  return h_flex().id(`limit-${id}`).flex_none().items_center().gap(6)
    .child(div().text_size(10).text_color(k.muted).child(shortLabel(limit)))
    .child(miniBar(id, limit.used, display, k, 28))
    .child(value(limit.used, display, 11, k));
}

function detailWindow(row, limit, display, k, now, width) {
  const id = `detail-${limitId(row, limit)}`;
  const reset = resetLabel(limit.resetsAt, now, true);
  return v_flex().id(`limit-${id}`).gap(6)
    .child(h_flex().items_center().gap(8)
      .child(h_flex().flex_1().min_w(0).items_center().gap(3)
        .child(div().min_w(0).truncate().font_medium().child(limit.label))
        .when(Boolean(reset), (el) => el.child(div().flex_none().text_color(k.muted).child(`· ${reset.toLowerCase()}`))))
      .child(value(limit.used, display, 12, k)))
    .child(miniBar(id, limit.used, display, k, width, 6, true));
}

function visibleEntries(entries, machine) {
  if (machine === undefined) return entries;
  return Object.fromEntries(Object.entries(entries ?? {}).filter(([, row]) => (row.machine ?? null) === machine));
}

function balanceRows(row, k) {
  const extra = row.extraUsage;
  const balances = [...(row.balances ?? [])];
  if (Number.isFinite(extra?.balance)) {
    balances.push({ label: extra.label ?? "Extra usage balance", amount: extra.balance, currency: extra.currency ?? extra.currencyCode });
  }
  return balances.filter(({ amount }) => Number.isFinite(amount)).map(({ label, amount, currency }) =>
    h_flex().justify_between().items_center().gap(8)
      .child(div().text_size(12).text_color(k.muted).child(label))
      .child(div().text_size(12).font_medium().child(currency ? `${currency} ${amount.toFixed(2)}` : String(amount))));
}

export default class Usage extends View {
  init(_props, cx) {
    const config = props() ?? {};
    this.from = config.from;
    this.overlay = config.overlay;
    this.page = config.page ?? "roster";
    this.machine = config.machine;
    this.windowWidth = config.windowWidth;
    this.providerKey = config.provider;
    this.hovered = null;
    this.selected = null;
    this.bounds = new Map();
    this.focus = cx.focus_handle();
    this.focus.focus();
    if (this.page === "roster") run("workspace-chrome.check-usage");
  }

  close() {
    if (this.submenu) closeOverlay(this.submenu);
    if (this.from) setShared("popup.closed", { from: this.from, at: Date.now() });
  }

  openDetail(row) {
    if (this.submenu) closeOverlay(this.submenu);
    const zoom = Number(settings().zoom) || 1;
    const bounds = this.bounds.get(rowId(row));
    let at;
    if (bounds) {
      const right = bounds.x + bounds.width + 4 * zoom;
      const fits = this.windowWidth ? right + POPOVER_WIDTH * zoom < this.windowWidth * zoom : this.from !== "usage-status";
      at = { x: fits ? right : bounds.x - (POPOVER_WIDTH + 4) * zoom, y: bounds.y };
    }
    this.submenu = openOverlay({
      mod: "usage", kind: "popup", width: POPOVER_WIDTH, height: POPOVER_HEIGHT,
      ...(at ? { at } : {}), props: {
        page: "provider", provider: rowId(row), parent: this.overlay,
        ...(this.machine !== undefined && { machine: this.machine }),
      },
    });
  }

  openPage(page) {
    const parent = props()?.parent;
    if (parent) closeOverlay(parent);
    if (this.overlay) closeOverlay(this.overlay);
    openOverlay({
      mod: "usage", kind: "dialog", width: 680, height: page === "history" ? 520 : 480,
      props: { page, ...(this.machine !== undefined && { machine: this.machine }) },
    });
  }

  scheduleClock(cx, rows, now) {
    const resets = timed(rows.flatMap((row) => row.limits)).filter((at) => at > now);
    const nextResetTick = Math.min(...resets.map((at) => (at - now) % (at - now >= DAY ? HOUR : MINUTE) + 1));
    const showsUpdate = this.page === "provider" && rows.some((row) => rowId(row) === this.providerKey && row.checkedAt);
    const delay = Math.min(nextResetTick, showsUpdate ? MINUTE - now % MINUTE : Infinity);
    const next = now + delay;
    if (!Number.isFinite(delay) || this.nextClock === next) return;
    this.nextClock = next;
    cx.timer.after(delay, (clock) => {
      if (this.nextClock !== next) return;
      this.nextClock = null;
      clock.notify();
    });
  }

  toggleDisplay(display) {
    changePreference({ display: display === "used" ? "remaining" : "used" });
  }

  displayToggle(display, k) {
    const label = display === "used" ? "Used" : "Left";
    return control("usage-display", label, () => this.toggleDisplay(display), k)
      .h(23).px(6).gap(5).text_size(11).bg(k.raised)
      .when(this.selected === "usage-display", (el) => el.bg(k.selected))
      .child(label).child(div().text_size(12).child("↕"));
  }

  density(mode, k) {
    return h_flex().id("usage-density").mx(INSET).mb(10).h(24).flex_none().gap(2)
      .p(2).rounded(6).border_1().border_color(k.border).bg(soft(k.background ?? k.canvas ?? k.surface, "80"))
      .children([["verbose", "Detailed"], ["compact", "Compact"]].map(([option, label]) =>
        h_flex().id(`usage-${option}`).flex_1().min_w(0).items_center().justify_center()
          .accessibility_label(label).rounded(4).cursor_pointer().text_size(12)
          .text_color(option === mode ? k.foreground : k.muted)
          .when(option === mode, (el) => el.bg(k.row_ring).font_medium())
          .when(this.selected === `usage-${option}`, (el) => el.border_1().border_color(k.accent))
          .on_click(() => changePreference({ mode: option }))
          .hover((s) => s.text_color(k.foreground))
          .child(label)));
  }

  compactMetric(row, display, k, now) {
    const primary = headline(row);
    const extra = row.limits.filter((limit) => scoped(row, limit)).sort(compareUsed)[0];
    if (!primary) {
      return h_flex().flex_none().items_center().gap(5)
        .when(Boolean(extra), (el) => el.id(`limit-${limitId(row, extra)}`)
          .child(div().text_size(11).text_color(k.muted).child(shortLabel(extra)))
          .child(value(extra.used, display, 12, k)));
    }
    const id = limitId(row, primary);
    const flag = Boolean(extra && percent(extra.used) >= 90 && percent(primary.used) < 90);
    const reset = resetLabel(primary.resetsAt, now);
    return h_flex().id(`limit-${id}`).flex_none().items_center().gap(8)
      .when(flag, (el) => el.child(div().text_size(11).text_color(k.muted).child(`${shortLabel(extra)} ${percent(extra.used, display)}%`)))
      .when(!flag && Boolean(reset), (el) => el.child(div().text_size(11).text_color(k.muted).child(reset)))
      .child(miniBar(id, primary.used, display, k, 30))
      .child(value(primary.used, display, 12, k).w(36));
  }

  rosterRow(row, pref, k, now, pending) {
    const id = rowId(row);
    const showDetails = pref.mode === "verbose" && row.limits.length > 0;
    const plan = planLabel(row.plan), reset = showDetails && nextReset(row.limits, now);
    const text = row.limits.length ? null : status(row, pending);
    const handleMove = (event, cx) => {
      this.bounds.set(id, event.bounds);
      if (this.hovered === id) return;
      this.hovered = id;
      this.selected = id;
      cx.notify();
      cx.timer.after(160, () => {
        if (this.hovered === id) this.openDetail(row);
      });
    };
    return h_flex().id(`usage-row-${id}`).flex_none().px(INSET).py(10).w_full()
      .gap(12).items_center().cursor_pointer().accessibility_label(`${row.name} usage details`)
      .hover((s) => s.bg(k.hover_strong))
      .when(this.selected === id, (el) => el.bg(k.hover))
      .on_mouse_move(handleMove)
      .on_hover((hovered) => { if (!hovered && this.hovered === id) this.hovered = null; })
      .on_click(() => { this.hovered = null; this.openDetail(row); })
      .child(v_flex().flex_1().min_w(0).gap(4)
        .child(h_flex().items_center().gap(10)
          .child(providerTile(row, k))
          .child(h_flex().min_w(0).gap(3).items_center().when(!showDetails, (el) => el.flex_1())
            .child(div().min_w(0).truncate().font_medium().text_size(13).child(row.name))
            .when(Boolean(plan), (el) => el.child(div().min_w(0).truncate().text_size(13).text_color(k.muted).child(`· ${plan}`))))
          .when(Boolean(text), (el) => el.child(div().min_w(0).truncate().text_size(11).text_color(k.muted).child(text)))
          .when(Boolean(reset), (el) => el.child(div().flex_none().text_size(11).text_color(k.muted).child(reset)))
          .when(!showDetails && row.limits.length > 0, (el) => el.child(this.compactMetric(row, pref.display, k, now))))
        .when(Boolean(row.failed && row.limits.length), (el) => el.child(div().flex_none().text_size(11).text_color(k.muted).child("Cached")))
      .when(Boolean(row.place), (el) => el.child(div().pl(30).text_size(11).text_color(k.muted).truncate().child(row.place)))
        .when(showDetails, (el) => el.child(h_flex().pl(30).flex_wrap().gap(10)
          .children(row.limits.map((limit) => detailMetric(row, limit, pref.display, k))))))
      .child(icon("chevron-right", 16, k.muted));
  }

  actionRow(id, label, action, k) {
    return h_flex().id(id).w_full().h(40).flex_none().px(INSET).gap(12).items_center().justify_between()
      .accessibility_label(label).cursor_pointer().hover((s) => s.bg(k.hover_strong))
      .when(this.selected === id, (el) => el.bg(k.hover))
      .on_click(action)
      .child(div().text_size(13).child(label)).child(icon("chevron-right", 16, k.muted));
  }

  answer(row, answer) {
    if (localOpenCode(row)) {
      setShared("usage.opencode", answer);
      if (answer && row.ask) run("workspace-chrome.allow-opencode");
      else run("workspace-chrome.refresh-usage");
    } else {
      setShared("usage.consent", { ...(shared("usage.consent") ?? {}), [consentKey(row)]: answer });
      run("workspace-chrome.refresh-usage");
    }
  }

  consentActions(row) {
    const answer = consent(row);
    const key = rowId(row);
    return [
      ...(answer == null ? [[`usage-not-now-${key}`, "Not now", false]] : []),
      [`usage-${answer === true ? "disconnect" : "allow"}-${key}`, answer === true ? "Disconnect" : "Allow", answer !== true],
    ];
  }

  consentControls(row, k) {
    const domain = consentDomain(row), answer = consent(row), open = answer === true;
    const description = row.agent === "opencode"
      ? "Kavex reads your OpenCode key and sends it only to opencode.ai, to ask for your Go plan's limits."
      : `Read the existing ${row.name} login for usage requests to ${domain}.`;
    return v_flex().id(`usage-consent-${rowId(row)}`).gap(9).p(12).rounded(6).border_1().border_color(k.border).bg(k.raised)
      .child(div().text_size(12).text_color(k.text_secondary).child(description))
      .child(h_flex().justify_end().gap(6).children(this.consentActions(row).map(([id, label, accepted]) =>
        control(id, label, () => this.answer(row, accepted), k).h(25).px(9)
          .when(accepted, (button) => button.bg(k.solid).text_color(k.solid_foreground))
          .when(open && !accepted, (button) => button.bg(k.background ?? k.canvas ?? k.surface))
          .when(this.selected === id, (button) => button.border_1().border_color(k.accent))
          .child(label))));
  }

  roster(rows, usage, pref, k, now) {
    const pending = checking(usage, now), sorted = [...rows].sort((a, b) => rank(b) - rank(a));
    const estimated = rows.reduce((sum, row) => {
      const metricWidth = row.limits.reduce((width, limit) => width + shortLabel(limit).length * 6 + 76, 0);
      const metrics = pref.mode === "verbose" && metricWidth ? Math.ceil(metricWidth / (POPOVER_WIDTH - 100)) * 24 : 0;
      return sum + 40 + metrics + (row.place ? 15 : 0);
    }, 0);
    const available = POPOVER_HEIGHT - ROSTER_CHROME;
    const list = v_flex().id("usage-rows").w_full()
      .when(estimated > available, (el) => el.h(available).min_h(0).overflow_y_scrollbar())
      .when(!sorted.length, (el) => el.child(div().px(INSET).py(10).text_size(12).text_color(k.muted)
        .child(pending || !usage.checkedAt ? "Loading usage…" : "No usage data")))
      .children(sorted.map((row) => this.rosterRow(row, pref, k, now, pending)));
    this.actions = [
      ["usage-refresh", () => run("workspace-chrome.refresh-usage")],
      ["usage-display", () => this.toggleDisplay(pref.display)],
      ["usage-verbose", () => changePreference({ mode: "verbose" })],
      ["usage-compact", () => changePreference({ mode: "compact" })],
      ...sorted.map((row) => [rowId(row), () => this.openDetail(row), true]),
      ["usage-history", () => this.openPage("history")],
      ["usage-accounts", () => this.openPage("accounts")],
    ];
    return v_flex().id("usage").w_full().min_h(0).rounded(12).overflow_hidden().bg(k.popover ?? k.canvas)
      .child(h_flex().w_full().flex_none().pl(INSET).pr(30).pt(12).pb(8).gap(8).items_center().justify_between()
        .child(h_flex().min_w(0).gap(6).items_center()
          .child(div().text_size(13).font_weight(600).child("Usage"))
          .child(div().min_w(0).truncate().text_size(11).text_color(k.muted).child("· all agents"))
          .child(control("usage-refresh", "Refresh rate limits", () => run("workspace-chrome.refresh-usage"), k)
            .size(20).when(this.selected === "usage-refresh", (el) => el.bg(k.selected))
            .child(pending ? loader(k.muted, 2) : icon("refresh", 16, k.muted))))
        .child(this.displayToggle(pref.display, k)))
      .child(this.density(pref.mode, k))
      .child(rule(k))
      .child(list)
      .child(rule(k))
      .child(this.actionRow("usage-history", "Usage details & history", () => this.openPage("history"), k))
      .child(this.actionRow("usage-accounts", "Manage Accounts…", () => this.openPage("accounts"), k));
  }

  provider(row, usage, pref, k, now) {
    const hasConsentControl = Boolean(row && consentDomain(row));
    this.actions = [
      ["usage-display", () => this.toggleDisplay(pref.display)],
      ...(hasConsentControl ? this.consentActions(row).map(([id, , answer]) => [id, () => this.answer(row, answer)]) : []),
      ["usage-accounts", () => this.openPage("accounts")],
    ];
    if (!row) return v_flex().w_full().p(INSET).child(div().text_size(12).text_color(k.muted).child("No usage data"));
    const plan = planLabel(row.plan), retry = resetLabel(row.retryAt, now);
    const failed = row.failed || row.state === "error", reading = row.limits.length > 0;
    const accountCard = row.agent === "claude" || row.agent === "codex";
    const balances = balanceRows(row, k);
    const scroll = row.limits.length * 39 + balances.length * 25 + (hasConsentControl ? 105 : 0) + (accountCard ? 143 : 102) > POPOVER_HEIGHT;
    const update = () => div().text_size(11).text_color(k.muted).child(relativeUpdate(row.checkedAt, now));
    const name = () => h_flex().min_w(0).items_center().gap(6)
      .child(providerGlyph(row, k))
      .child(div().min_w(0).truncate().text_size(13).font_medium().child(row.name));
    const meters = v_flex().w_full().gap(12)
      .when(!reading && !balances.length, (el) => el.child(div().text_color(k.muted).child(status(row, checking(usage, now)))))
      .children(row.limits.map((limit) => detailWindow(row, limit, pref.display, k, now, accountCard ? DETAIL_WIDTH - 22 : DETAIL_WIDTH)))
      .children(balances)
      .when(failed && reading, (el) => el.child(v_flex().gap(4)
        .child(div().font_medium().text_size(11).child("Refresh failed · showing cached data"))
        .when(Boolean(row.error), (warning) => warning.child(div().text_size(11).text_color(k.muted).child(row.error)))))
      .when(Boolean(retry) && retry !== "now", (el) => el.child(div().text_size(11).text_color(k.muted).child(`Retry in ${retry}`)));
    const info = accountCard
      ? v_flex().gap(8)
        .child(h_flex().justify_between().items_center().gap(8).child(name()).child(update()))
        .child(v_flex().gap(12).p(10).rounded(8).border_1().border_color(k.card_border).bg(k.card)
          .child(h_flex().items_center().gap(8).justify_between()
            .child(div().flex_1().min_w(0).truncate().font_medium().text_size(13).child([row.place, plan].filter(Boolean).join(" · ")))
            .child(this.displayToggle(pref.display, k)))
          .child(meters))
      : v_flex().gap(12)
        .child(h_flex().items_center().justify_between().gap(8)
          .child(v_flex().flex_1().min_w(0).gap(3).child(name()).child(update()))
          .child(this.displayToggle(pref.display, k)))
        .when(Boolean(row.place), (el) => el.child(div().text_size(11).text_color(k.muted).child(row.place)))
        .child(rule(k))
        .child(meters);
    return v_flex().id("usage-provider").w_full().p(INSET).gap(12).text_size(12).rounded(12).bg(k.popover ?? k.canvas)
      .when(scroll, (el) => el.h(POPOVER_HEIGHT - 2).overflow_y_scrollbar())
      .child(info)
      .when(hasConsentControl, (el) => el.child(this.consentControls(row, k)))
      .child(rule(k))
      .child(this.actionRow("usage-accounts", "Manage Accounts…", () => this.openPage("accounts"), k));
  }

  pageHeader(label, k) {
    return h_flex().w_full().h(48).flex_none().px(18).gap(6).justify_between().items_center()
      .child(div().text_size(16).font_weight(600).child(label))
      .child(control("usage-close", "Close", () => closeOverlay(this.overlay), k).size(26).child(icon("close", 16, k.muted)));
  }

  history(rows, usage, display, k) {
    const selected = visibleEntries(usage.entries, this.machine);
    const readings = Object.entries(usage.history ?? {}).flatMap(([id, snapshots]) => {
      const [agent, machine] = id.split("|");
      if (this.machine !== undefined && (machine || null) !== this.machine) return [];
      const row = selected?.[id] ?? rows.find((entry) => entry.agent === agent);
      const title = row?.name ?? agent;
      return snapshots.filter((sample) => Number.isFinite(sample.at)).map((sample) => ({ ...sample, title, machine, id }));
    }).sort((a, b) => b.at - a.at);
    this.actions = [["usage-close", () => closeOverlay(this.overlay)]];
    return v_flex().id("usage-history-page").size_full().bg(k.popover ?? k.canvas)
      .child(this.pageHeader("Usage details & history", k)).child(rule(k))
      .when(!readings.length, (el) => el.child(div().p(18).text_size(12).text_color(k.muted).child("No usage history yet")))
      .when(readings.length > 0, (el) => el.child(v_flex().id("usage-history-list").flex_1().min_h(0).overflow_y_scrollbar().px(18)
        .children(readings.map(({ at, limits, title, machine, id }) =>
          v_flex().id(`usage-history-${id}-${at}`).gap(6).py(10).border_b(1).border_color(k.border)
            .child(h_flex().w_full().justify_between().items_center().gap(10)
              .child(div().min_w(0).truncate().text_size(13).font_medium().child(machine ? `${title} · ${machine}` : title))
              .child(div().flex_none().text_size(11).text_color(k.muted).child(new Date(at).toLocaleString())))
            .child(h_flex().flex_wrap().gap(12).children(limits.map((limit) =>
              h_flex().gap(6).items_center()
                .child(div().text_size(11).text_color(k.muted).child(shortLabel(limit)))
                .child(value(limit.used, display, 11, k)))))))));
  }

  accounts(rows, usage, k, now) {
    this.actions = [
      ["usage-close", () => closeOverlay(this.overlay)],
      ...rows.filter(consentDomain).flatMap((row) =>
        this.consentActions(row).map(([id, , answer]) => [id, () => this.answer(row, answer)])),
    ];
    return v_flex().id("usage-accounts-page").size_full().bg(k.popover ?? k.canvas)
      .child(this.pageHeader("Manage Accounts", k)).child(rule(k))
      .when(!rows.length, (el) => el.child(div().p(18).text_size(12).text_color(k.muted).child("No usage accounts configured")))
      .when(rows.length > 0, (el) => el.child(v_flex().id("usage-accounts-list").flex_1().min_h(0).overflow_y_scrollbar().px(18)
        .children(rows.map((row) => {
          const connected = row.limits.length ? relativeUpdate(row.checkedAt, now) : status(row, checking(usage, now));
          return v_flex().id(`usage-account-${row.agent}-${row.machine ?? "local"}`).py(12).gap(9).border_b(1).border_color(k.border)
            .child(h_flex().w_full().items_center().gap(8)
              .child(providerTile(row, k))
              .child(h_flex().flex_1().min_w(0).items_center().gap(5)
                .child(div().min_w(0).truncate().text_size(13).font_medium().child(row.name))
                .when(Boolean(row.place), (name) => name.child(div().min_w(0).truncate().text_size(11).text_color(k.muted).child(`· ${row.place}`))))
              .child(div().text_size(11).text_color(k.muted).child(connected)))
            .when(Boolean(consentDomain(row)), (item) => item.child(this.consentControls(row, k)));
        }))));
  }

  keyDown(event, cx) {
    const actions = this.actions ?? [];
    const index = actions.findIndex(([id]) => id === this.selected);
    if (event.key === "left" && this.page === "provider") {
      closeOverlay(this.overlay);
    } else if ((event.key === "up" || event.key === "down") && actions.length) {
      const offset = event.key === "down" ? 1 : -1;
      const next = index < 0 ? (offset > 0 ? 0 : actions.length - 1) : (index + offset + actions.length) % actions.length;
      this.selected = actions[next][0];
      cx.notify();
    } else if (index >= 0 && (event.key === "enter" || event.key === "space" || (event.key === "right" && actions[index][2]))) {
      actions[index][1]();
    } else {
      return;
    }
    cx.stop_propagation();
  }

  render(cx) {
    const k = look(theme()), now = Date.now(), usage = shared("usage") ?? {}, pref = presentation();
    const rows = subscriptions(visibleEntries(usage.entries, this.machine), now, this.page !== "accounts");
    this.scheduleClock(cx, rows, now);
    let page;
    switch (this.page) {
      case "provider": page = this.provider(rows.find((row) => rowId(row) === this.providerKey), usage, pref, k, now); break;
      case "history": page = this.history(rows, { history: shared("usage.history") }, pref.display, k); break;
      case "accounts": page = this.accounts(rows, usage, k, now); break;
      default: page = this.roster(rows, usage, pref, k, now);
    }
    return page.text_color(k.foreground).track_focus(this.focus).on_key_down((event, cx) => this.keyDown(event, cx));
  }
}
