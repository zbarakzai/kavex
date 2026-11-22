import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { closeOverlay, openOverlay, props, run, setShared, shared, theme } from "herdr";
import { checking, NEAR, POPOVER_HEIGHT, POPOVER_WIDTH, subscriptions } from "./checks.js";
import { look, MONO, sectionLabel, tile } from "./look.js";
import { loader } from "./loader.js";

const ICONS = "mods/workspace-chrome/icons";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * 24 * 60;
const GUTTER = 5;
const INSET = 14;
const HEADER = 44;
const FOOTER = 46;
const ROOM = POPOVER_HEIGHT - HEADER - FOOTER - 2;
const ROW_HEIGHT = 48;
const CARD_INSET = 10;
const PROVIDER_TILE = 26;
const PROVIDER_GAP = 10;
const DIALOG_WIDTH = 600, DIALOG_HEIGHT = 460;
const DISPLAY_OPTIONS = [["used", "Used"], ["remaining", "Left"]];
const DETAIL_WIDTH = POPOVER_WIDTH - 2 * (1 + GUTTER + 1 + INSET);

const rowId = (row) => `${row.agent}-${row.who ?? row.machine ?? "local"}`;
const limitId = (row, limit) => `${rowId(row)}-${limit.key ?? limit.label}`;

const displayPreference = () => shared("usage.presentation")?.display === "remaining" ? "remaining" : "used";
const chooseDisplay = (display) => setShared("usage.presentation", { display });

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

const scoped = (row, limit) => limit.scoped || (row.agent === "claude" && /^fable(?: weekly)?$/i.test(limit.label));
const primaryLimits = (row) => row.limits.filter((limit) => !scoped(row, limit));
const rank = (row) => Math.max(-1, ...primaryLimits(row).map((limit) => percent(limit.used)));

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

const hue = (row, k) => ({ claude: k.accent, codex: k.groups.blue.text, opencode: k.groups.teal.text })[row.agent] ?? k.muted;

function miniBar(id, row, used, display, k, width, height = 4) {
  const fill = percent(used) >= NEAR ? k.blocked : hue(row, k);
  return div().w(width).h(height).flex_none().rounded_full().overflow_hidden().bg(k.row_ring)
    .child(div().id(`bar-${id}`).h_full().w(width * percent(used, display) / 100)
      .rounded_full().bg(fill).transition("width", 240));
}

function value(used, display, size, k) {
  return div().flex_none().font_family(MONO).text_right().font_medium().text_size(size).text_color(k.foreground)
    .child(`${percent(used, display)}%`);
}

const dialogCard = (k) => v_flex().w_full().flex_none().rounded(14)
  .border_1().border_color(k.card_border).bg(k.card);

function consentDescription(row) {
  if (row.agent === "opencode") {
    return "Kavex reads your OpenCode key and sends it only to opencode.ai, to ask for your Go plan's limits.";
  }
  return `Read the existing ${row.name} login for usage requests to ${consentDomain(row)}.`;
}
const icon = (name, size, color) => svg(`${ICONS}/${name}.svg`).size(size).flex_none().text_color(color);

const control = (id, label, action, k) => h_flex().id(id).flex_none().items_center().justify_center()
  .accessibility_label(label).rounded(6).cursor_pointer().text_color(k.muted)
  .hover((s) => s.bg(k.hover_strong).text_color(k.foreground))
  .on_click(action);

function detailMetric(row, limit, display, k) {
  const id = limitId(row, limit);
  return h_flex().id(`limit-${id}`).flex_none().items_center().gap(6)
    .child(div().text_size(10).text_color(k.muted).child(shortLabel(limit)))
    .child(miniBar(id, row, limit.used, display, k, 28))
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
    .child(miniBar(id, row, limit.used, display, k, width, 7));
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
    this.providerKey = config.provider;
    this.selected = null;
    this.focus = cx.focus_handle();
    this.focus.focus();
    if (this.page === "roster") run("workspace-chrome.check-usage");
  }

  close() {
    if (this.from) setShared("popup.closed", { from: this.from, at: Date.now() });
  }

  openDetail(row, cx) {
    this.providerKey = rowId(row);
    this.page = "provider";
    this.selected = null;
    cx.notify();
  }

  back(cx) {
    this.page = "roster";
    this.selected = this.providerKey;
    cx.notify();
  }

  openPage(page) {
    if (this.overlay) closeOverlay(this.overlay);
    openOverlay({
      mod: "usage", kind: "dialog", width: DIALOG_WIDTH, height: DIALOG_HEIGHT,
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

  // The same pill and segment sizes as Settings.
  displayPicker(current, k) {
    return h_flex().id("usage-display").flex_none().p(3).gap(2).items_center()
      .role("list_box").accessibility_label("Percentage display")
      .rounded(999).border_1().border_color(k.pill_ring).bg(k.pill)
      .children(DISPLAY_OPTIONS.map(([value, text]) => {
        const selected = value === current, optionId = `usage-${value}`;
        return h_flex().id(optionId).h(26).px(11).items_center().rounded(13)
          .role("list_box_option").accessibility_label(text).aria_selected(selected)
          .border_1().border_color(this.selected === optionId ? k.accent : k.clear)
          .text_size(13).cursor_pointer()
          .when(selected, (el) => el.bg(k.pill_selected).text_color(k.foreground))
          .when(!selected, (el) => el.text_color(k.muted).hover((st) => st.bg(k.hover_strong).text_color(k.foreground)))
          .on_click(() => chooseDisplay(value))
          .child(text);
      }));
  }

  displayActions() {
    return DISPLAY_OPTIONS.map(([value]) => [`usage-${value}`, () => chooseDisplay(value)]);
  }

  rosterRow(row, display, k, now, pending) {
    const id = rowId(row);
    const showDetails = row.limits.length > 0;
    const plan = planLabel(row.plan), reset = showDetails && nextReset(row.limits, now);
    const text = row.limits.length ? null : status(row, pending);
    return v_flex().id(`usage-row-${id}`).flex_none().min_h(ROW_HEIGHT).justify_center().px(CARD_INSET).py(8).gap(7)
      .rounded(10).border_1().border_color(k.card_border).bg(k.card)
      .cursor_pointer().accessibility_label(`${row.name} usage details`)
      .hover((el) => el.bg(k.row_active_hover).border_color(k.row_ring))
      .when(this.selected === id, (el) => el.border_color(k.accent))
      .on_click((_event, cx) => this.openDetail(row, cx))
      .child(h_flex().items_center().gap(PROVIDER_GAP)
        .child(tile(row, PROVIDER_TILE, k))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(h_flex().items_center().min_w(0).gap(5)
            .child(div().min_w(0).truncate().font_medium().text_size(13.5).child(row.name))
            .when(Boolean(plan), (el) => el.child(div().min_w(0).truncate().text_size(11).text_color(k.muted).child(`· ${plan}`))))
          .when(Boolean(row.place || text || (row.failed && row.limits.length)), (el) => el.child(
            h_flex().min_w(0).gap(5).text_size(11).text_color(k.muted)
              .when(Boolean(row.place), (line) => line.child(div().min_w(0).truncate().child(row.place)))
              .when(Boolean(text), (line) => line.child(div().min_w(0).truncate().child(text)))
              .when(Boolean(row.failed && row.limits.length), (line) => line.child(div().flex_none().child("Cached"))))))
        .when(Boolean(reset), (el) => el.child(div().flex_none().text_size(11).text_color(k.muted).child(reset)))
        .child(icon("chevron-right", 12, k.muted)))
      .when(showDetails, (el) => el.child(h_flex().pl(PROVIDER_TILE + PROVIDER_GAP).flex_wrap().gap(10).pb(2)
        .children(row.limits.map((limit) => detailMetric(row, limit, display, k)))));
  }

  footer(pending, k) {
    const link = (id, label, title, page) => control(id, title, () => this.openPage(page), k)
      .h(34).px(14).rounded(999).border_1().border_color(this.selected === id ? k.accent : k.pill_ring)
      .bg(k.pill).text_size(13).text_color(k.foreground)
      .child(label);
    return h_flex().h(FOOTER).flex_none().px(9).gap(6).items_center()
      .child(link("usage-history", "History", "Usage history", "history"))
      .child(link("usage-accounts", "Accounts", "Manage accounts", "accounts"))
      .child(div().flex_1())
      .child(control("usage-refresh", "Refresh rate limits", () => run("workspace-chrome.refresh-usage"), k)
        .h(34).px(14).gap(6).rounded(999).text_size(13).font_medium()
        .border_1().border_color(this.selected === "usage-refresh" ? k.foreground : k.clear)
        .bg(k.accent).text_color(k.accent_foreground)
        .hover((el) => el.bg(k.accent).text_color(k.accent_foreground).opacity(0.88))
        .child(h_flex().size(16).items_center().justify_center()
          .child(pending ? loader(k.accent_foreground, 2) : icon("refresh", 16, k.accent_foreground)))
        .child("Refresh"));
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

  consentButtons(row, k, height) {
    return h_flex().flex_none().justify_end().items_center().gap(6)
      .children(this.consentActions(row).map(([id, label, accepted]) =>
        control(id, label, () => this.answer(row, accepted), k).h(height).px(14).rounded(999)
          .border_1().border_color(this.selected === id ? k.accent : k.pill_ring)
          .bg(k.pill).text_color(k.foreground).text_size(13)
          .when(accepted, (button) => button.bg(k.solid).text_color(k.solid_foreground)
            .hover((el) => el.bg(k.solid).text_color(k.solid_foreground).opacity(0.88)))
          .child(label)));
  }

  consentControls(row, k) {
    return v_flex().id(`usage-consent-${rowId(row)}`).gap(9).p(INSET).rounded(10).border_1().border_color(k.card_border).bg(k.card)
      .child(div().text_size(12).text_color(k.text_secondary).child(consentDescription(row)))
      .child(this.consentButtons(row, k, 28));
  }

  roster(rows, usage, display, k, now) {
    const pending = checking(usage, now), sorted = [...rows].sort((a, b) => rank(b) - rank(a));
    const estimated = rows.reduce((sum, row) => {
      const metricWidth = row.limits.reduce((width, limit) => width + shortLabel(limit).length * 6 + 76, 0);
      const lines = Math.ceil(metricWidth / (POPOVER_WIDTH - 76));
      return sum + ROW_HEIGHT + GUTTER + lines * 23;
    }, 0);
    const list = v_flex().id("usage-rows").w_full().px(GUTTER).gap(GUTTER)
      .when(estimated > ROOM, (el) => el.h(ROOM).min_h(0).overflow_y_scrollbar())
      .when(!sorted.length, (el) => el.child(div().mx(1).p(INSET).rounded(10).border_1()
        .border_color(k.card_border).bg(k.card).text_size(12).text_color(k.muted)
        .child(pending || !usage.checkedAt ? "Loading usage…" : "No usage data")))
      .children(sorted.map((row) => this.rosterRow(row, display, k, now, pending)));
    this.actions = [
      ...this.displayActions(),
      ...sorted.map((row) => [rowId(row), (cx) => this.openDetail(row, cx), true]),
      ["usage-history", () => this.openPage("history")],
      ["usage-accounts", () => this.openPage("accounts")],
      ["usage-refresh", () => run("workspace-chrome.refresh-usage")],
    ];
    return v_flex().id("usage").w_full().min_h(0).rounded(13).bg(k.canvas)
      .child(h_flex().h(HEADER).flex_none().pl(GUTTER + INSET).pr(9).gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(14).font_medium().child("Usage limits"))
        .child(this.displayPicker(display, k)))
      .child(list)
      .child(this.footer(pending, k));
  }

  provider(row, usage, display, k, now) {
    const hasConsentControl = Boolean(row && consentDomain(row));
    const pending = checking(usage, now);
    this.actions = [
      ["usage-back", (cx) => this.back(cx)],
      ...this.displayActions(),
      ...(hasConsentControl ? this.consentActions(row).map(([id, , answer]) => [id, () => this.answer(row, answer)]) : []),
      ["usage-history", () => this.openPage("history")],
      ["usage-accounts", () => this.openPage("accounts")],
      ["usage-refresh", () => run("workspace-chrome.refresh-usage")],
    ];
    const body = v_flex().id("usage-provider-body").w_full().px(GUTTER).gap(GUTTER);
    if (row) {
      const metadata = [row.place, planLabel(row.plan)].filter(Boolean).join(" · ");
      const retry = resetLabel(row.retryAt, now);
      const failed = row.failed || row.state === "error", reading = row.limits.length > 0;
      const balances = balanceRows(row, k);
      const estimated = 82 + row.limits.length * 44 + balances.length * 28 +
        (hasConsentControl ? 122 : 0) + (failed ? 54 : 0) + (retry ? 20 : 0);
      body.when(estimated > ROOM, (el) => el.h(ROOM).min_h(0).overflow_y_scrollbar())
        .child(v_flex().flex_none().gap(14).p(INSET).rounded(10).border_1().border_color(k.card_border).bg(k.card)
          .child(h_flex().items_center().gap(10)
            .child(tile(row, PROVIDER_TILE, k))
            .child(v_flex().flex_1().min_w(0).gap(2)
              .child(div().min_w(0).truncate().text_size(14).font_medium().child(row.name))
              .when(Boolean(metadata), (el) => el.child(div().truncate().text_size(11).text_color(k.muted).child(metadata))))
            .child(div().flex_none().text_size(11).text_color(k.muted).child(relativeUpdate(row.checkedAt, now))))
          .when(!reading && !balances.length, (el) => el.child(div().text_color(k.muted).child(status(row, pending))))
          .children(row.limits.map((limit) => detailWindow(row, limit, display, k, now, DETAIL_WIDTH)))
          .children(balances)
          .when(failed && reading, (el) => el.child(v_flex().gap(4)
            .child(div().font_medium().text_size(11).text_color(k.failed_text).child("Refresh failed · showing cached data"))
            .when(Boolean(row.error), (warning) => warning.child(div().text_size(11).text_color(k.muted).child(row.error)))))
          .when(Boolean(retry) && retry !== "now", (el) => el.child(div().text_size(11).text_color(k.muted).child(`Retry in ${retry}`))))
        .when(hasConsentControl, (el) => el.child(this.consentControls(row, k)));
    } else {
      body.child(div().p(INSET).text_color(k.muted).child("No usage data"));
    }
    return v_flex().id("usage-provider").w_full().min_h(0).rounded(13).bg(k.canvas).text_size(12)
      .child(h_flex().h(HEADER).w_full().flex_none().px(9).gap(8).items_center()
        .child(control("usage-back", "Back to usage limits", (_event, cx) => this.back(cx), k)
          .h(34).px(10).gap(10).rounded(10).text_size(13.5)
          .border_1().border_color(this.selected === "usage-back" ? k.accent : k.clear)
          .child(icon("chevron-left", 16, k.label)).child("Usage limits"))
        .child(div().flex_1())
        .child(this.displayPicker(display, k)))
      .child(body)
      .child(this.footer(pending, k));
  }

  dialog(page, title, content, k, tools = null) {
    const close = control("usage-close", "Close", () => closeOverlay(this.overlay), k)
      .size(28).rounded(7).border_1().border_color(this.selected === "usage-close" ? k.accent : k.clear)
      .child(icon("close", 16, k.muted));
    return v_flex().id(`usage-${page}-page`).size_full().min_h(0).rounded(13).overflow_hidden().bg(k.panel)
      .child(h_flex().h(56).flex_none().px(18).gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().child(title))
        .when(Boolean(tools), (el) => el.child(tools))
        .child(close))
      .child(v_flex().id(`usage-${page}-list`).flex_1().min_h(0).overflow_y_scrollbar()
        .px(18).pb(16).gap(12).children(content));
  }

  history(rows, usage, display, k) {
    const readings = Object.entries(shared("usage.history") ?? {}).flatMap(([id, snapshots]) => {
      const [agent, machine] = id.split("|");
      if (this.machine !== undefined && (machine || null) !== this.machine) return [];
      const provider = usage.entries?.[id] ?? rows.find((entry) => entry.agent === agent) ?? { agent, name: agent };
      return snapshots.filter((sample) => Number.isFinite(sample.at))
        .map((sample) => ({ ...sample, provider, machine, id }));
    }).sort((a, b) => b.at - a.at);

    const days = new Map();
    for (const reading of readings) {
      const day = new Date(reading.at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
      if (!days.has(day)) days.set(day, []);
      days.get(day).push(reading);
    }
    const content = [...days].map(([day, samples]) =>
      v_flex().w_full().flex_none().gap(8)
        .child(div().px(2).child(sectionLabel(k, day.toUpperCase())))
        .child(dialogCard(k).px(14).py(3).children(samples.map(({ at, limits, provider, machine, id }) =>
          h_flex().id(`usage-history-${id}-${at}`).w_full().min_h(52).py(8).gap(12).items_center()
            .child(tile(provider, PROVIDER_TILE, k))
            .child(v_flex().flex_1().min_w(0).gap(4)
              .child(div().truncate().text_size(13.5).font_medium()
                .child(machine ? `${provider.name} · ${machine}` : provider.name))
              .child(h_flex().flex_wrap().gap(12).children(limits.map((limit) => detailMetric(provider, limit, display, k)))))
            .child(div().flex_none().font_family(MONO).text_size(11).text_color(k.label)
              .child(new Date(at).toLocaleTimeString()))))));
    if (!content.length) {
      content.push(dialogCard(k).p(14).text_size(13).text_color(k.muted).child("No usage history yet"));
    }
    this.actions = [...this.displayActions(), ["usage-close", () => closeOverlay(this.overlay)]];
    return this.dialog("history", "Usage history", content, k, this.displayPicker(display, k));
  }

  accounts(rows, usage, k, now) {
    this.actions = [
      ["usage-close", () => closeOverlay(this.overlay)],
      ...rows.filter(consentDomain).flatMap((row) =>
        this.consentActions(row).map(([id, , answer]) => [id, () => this.answer(row, answer)])),
    ];
    const pending = checking(usage, now);
    const content = rows.map((row) => {
      const connected = row.limits.length ? relativeUpdate(row.checkedAt, now) : status(row, pending);
      const metadata = [row.place, planLabel(row.plan)].filter(Boolean).join(" · ");
      return dialogCard(k).id(`usage-account-${row.agent}-${row.machine ?? "local"}`).p(14).gap(10)
        .child(h_flex().w_full().items_center().gap(10)
          .child(tile(row, PROVIDER_TILE, k))
          .child(v_flex().flex_1().min_w(0).gap(2)
            .child(div().truncate().text_size(13.5).font_medium().child(row.name))
            .when(Boolean(metadata), (el) => el.child(div().truncate().text_size(12).text_color(k.label).child(metadata))))
          .child(div().max_w(220).truncate().text_size(12).text_color(k.label).child(connected)))
        .when(Boolean(consentDomain(row)), (item) => item.child(h_flex().id(`usage-consent-${rowId(row)}`).w_full().items_center().gap(12)
          .child(div().flex_1().min_w(0).text_size(12).line_height("17px").text_color(k.text_secondary).child(consentDescription(row)))
          .child(this.consentButtons(row, k, 34))));
    });
    if (!content.length) {
      content.push(dialogCard(k).p(14).text_size(13).text_color(k.muted).child("No usage accounts configured"));
    }
    return this.dialog("accounts", "Manage accounts", content, k);
  }

  keyDown(event, cx) {
    const actions = this.actions ?? [];
    const index = actions.findIndex(([id]) => id === this.selected);
    if (event.key === "left" && this.page === "provider") {
      this.back(cx);
    } else if ((event.key === "up" || event.key === "down") && actions.length) {
      const offset = event.key === "down" ? 1 : -1;
      const next = index < 0 ? (offset > 0 ? 0 : actions.length - 1) : (index + offset + actions.length) % actions.length;
      this.selected = actions[next][0];
      cx.notify();
    } else if (index >= 0 && (event.key === "enter" || event.key === "space" || (event.key === "right" && actions[index][2]))) {
      actions[index][1](cx);
    } else {
      return;
    }
    cx.stop_propagation();
  }

  render(cx) {
    const k = look(theme()), now = Date.now(), usage = shared("usage") ?? {}, display = displayPreference();
    const rows = subscriptions(visibleEntries(usage.entries, this.machine), now, this.page !== "accounts");
    this.scheduleClock(cx, rows, now);
    let page;
    switch (this.page) {
      case "provider": page = this.provider(rows.find((row) => rowId(row) === this.providerKey), usage, display, k, now); break;
      case "history": page = this.history(rows, usage, display, k); break;
      case "accounts": page = this.accounts(rows, usage, k, now); break;
      default: page = this.roster(rows, usage, display, k, now);
    }
    return page.text_color(k.foreground).track_focus(this.focus).on_key_down((event, cx) => this.keyDown(event, cx));
  }
}
