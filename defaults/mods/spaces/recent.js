import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { closeOverlay, props, run, shared, theme } from "herdr";
import { look, MONO } from "./look.js";
import { projectCommand, recentProjects, RECENT_PROJECTS } from "./history.js";

const ROW = 44;
const GAP = 3;
const VISIBLE = 7;
const glyph = (name) => svg(`mods/workspace-chrome/icons/${name}.svg`).size(16).flex_none();

export function recentHistory() {
  const data = shared(RECENT_PROJECTS);
  return Array.isArray(data) ? data.filter((item) => item?.folder && typeof item.folder === "string"
    && typeof item.id === "string" && typeof item.name === "string") : [];
}

function subtitle(project, home) {
  const folder = project.folder;
  const local = home && (folder === home || folder.startsWith(`${home}/`)) ? `~${folder.slice(home.length)}` : folder;
  const label = project.machine ? `${project.machine} · ${folder}` : local;
  const chars = [...label];
  return chars.length <= 33 ? label : `${chars.slice(0, 14).join("")}…${chars.slice(-18).join("")}`;
}

export function drawRecentSpaces(currentProjects, home) {
  const k = look(theme());
  const projects = recentProjects(recentHistory(), currentProjects());
  const height = Math.min(VISIBLE, projects.length) * (ROW + GAP) - GAP;
  const row = (project) => h_flex().id(`recent-space-${project.id}-${project.folder}`).h(ROW).px(8).gap(9).items_center()
    .flex_none().rounded(7).cursor_pointer().when(project.active, (el) => el.bg(k.row_selected_strong))
    .hover((el) => el.bg(k.row_active_hover))
    .on_click(() => {
      const [command, args] = projectCommand(project, currentProjects());
      closeOverlay(props().overlay);
      run(command, args);
    })
    .child(h_flex().size(28).flex_none().items_center().justify_center().rounded(6).bg(k.tile)
      .child(glyph("folder").text_color(project.active ? k.accent_text : k.muted)))
    .child(v_flex().flex_1().min_w(0).gap(1)
      .child(div().truncate().text_size(13).font_medium().text_color(k.foreground).child(project.name))
      .child(div().truncate().font_family(MONO).text_size(10.5).text_color(k.muted).child(subtitle(project, home))))
    .when(project.open, (el) => el.child(div().flex_none().text_size(11).text_color(k.muted).child("Open")));

  return v_flex().w_full().min_h(0).p(6).gap(3)
    .child(h_flex().h(34).px(9).items_center().text_size(13).font_semibold().text_color(k.foreground).child("Recent spaces"))
    .child(projects.length
      ? v_flex().id("recent-project-list").w_full().h(height).min_h(0).flex_shrink(1).overflow_y_scrollbar()
        .gap(GAP).when(projects.length > VISIBLE, (el) => el.pr(16)).children(projects.map(row))
      : div().px(9).pb(11).text_size(12).text_color(k.muted).child("Projects appear here after you open a space."));
}
