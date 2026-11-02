import {
  MODULE_ID, RARITIES, isAugment, getRarity, getEffectText, boldMarkdown, escapeHTML as esc
} from "./core.js";
import { planAutomation, applyAutomation } from "./automation.js";
import { checkAutomation } from "./checker.js";
import { postAugmentCard } from "./chat.js";
import { openAugment } from "./ui.js";

/**
 * GM-only "Augment audit" window, opened from module settings.
 * Runs the effect reader and checker live on every augment in the Items directory, shows what each
 * one builds, and lets the GM rebuild it or test its abilities on a hidden test-bench character.
 */

const STATUS = {
  clean: { label: "Fully automated", note: "Every rule became a roll, use counter or effect." },
  reminders: { label: "Automated + reminders", note: "Rolls and effects built; situational rules posted to chat." },
  check: { label: "Needs a look", note: "Text mentions something the module may have missed." },
  text: { label: "Reminders only", note: "Roleplay, exploration or tactical rules posted to chat." }
};
const ACTIVATION = { action: "Action", bonus: "Bonus action", reaction: "Reaction", special: "Triggered" };
const ROW_LIMIT = 80;

/* -------------------------------------------- */
/*  Test bench                                  */
/* -------------------------------------------- */

const BENCH_NAME = "Augment Test Bench";

export async function getBench() {
  const existing = game.actors.find(a => a.flags?.[MODULE_ID]?.bench);
  if (existing) return existing;
  const abilities = Object.fromEntries(["str", "dex", "con", "int", "wis", "cha"].map(k => [k, { value: k === "con" ? 14 : 12 }]));
  return Actor.implementation.create({
    name: BENCH_NAME, type: "character", img: "icons/svg/mystery-man.svg",
    system: { abilities }, flags: { [MODULE_ID]: { bench: true } }
  });
}

/** A copy of the augment on the bench with everything switched on, reused while it's up to date. */
async function benchCopy(item) {
  const bench = await getBench();
  const sig = item.flags?.[MODULE_ID]?.auto?.signature ?? null;
  const existing = bench.items.find(i => i.flags?.[MODULE_ID]?.testOf === item.uuid);
  if (existing && existing.flags[MODULE_ID].testSig === sig) return existing;
  if (existing) await existing.delete();

  const data = item.toObject();
  delete data._id;
  delete data.folder;
  const mf = data.flags?.[MODULE_ID] ?? {};
  const stashed = Array.isArray(mf.stashedActivities) ? mf.stashedActivities : [];
  if (stashed.length) {
    data.system.activities = { ...(data.system.activities ?? {}), ...Object.fromEntries(stashed.map(a => [a._id, a])) };
    mf.stashedActivities = [];
  }
  mf.testOf = item.uuid;
  mf.testSig = sig;
  data.flags = { ...(data.flags ?? {}), [MODULE_ID]: mf };
  for (const e of data.effects ?? []) {
    const kind = e.flags?.[MODULE_ID]?.kind;
    if (e.transfer && kind !== "toggle" && kind !== "stack") e.disabled = false;
  }
  const [copy] = await bench.createEmbeddedDocuments("Item", [data], { augmentsSkipSync: true });
  // Count every test copy as installed, so stack counters and installed-only features work.
  await bench.setFlag(MODULE_ID, "slots", bench.items.filter(i => i.flags?.[MODULE_ID]?.testOf).map(i => i.id));
  return copy;
}

async function clearBench() {
  const bench = game.actors.find(a => a.flags?.[MODULE_ID]?.bench);
  if (!bench) return 0;
  const ids = bench.items.filter(i => i.flags?.[MODULE_ID]?.testOf).map(i => i.id);
  if (ids.length) await bench.deleteEmbeddedDocuments("Item", ids);
  return ids.length;
}

/* -------------------------------------------- */
/*  Rows                                        */
/* -------------------------------------------- */

function analyse(item) {
  const text = getEffectText(item);
  let plan = null;
  try { plan = planAutomation(item, text); } catch (err) { console.warn(`${MODULE_ID} | Audit couldn't analyse ${item.name}`, err); }
  const result = plan?.result ?? { activities: [], effects: [], summary: [], reminders: [] };
  const check = checkAutomation(text, result);
  return {
    id: item.id,
    name: item.name,
    img: item.img,
    rarity: getRarity(item),
    family: item.flags?.[MODULE_ID]?.family ?? "",
    text,
    status: check.status,
    flags: check.flags.map(f => f.message),
    builds: result.summary.filter(s => !/^\d+ reminders? in chat$/.test(s)).map(s => s.replace("Use tracker", "Uses counter")),
    reminders: result.reminders,
    outdated: plan ? !plan.unchanged : false,
    canAutomate: item.system?.activities !== undefined
  };
}

/* -------------------------------------------- */
/*  Window                                      */
/* -------------------------------------------- */

const AppV2 = foundry.applications?.api?.ApplicationV2;

export const AugmentAudit = AppV2 ? class AugmentAudit extends AppV2 {
  static DEFAULT_OPTIONS = {
    id: "augments-audit",
    classes: ["augments-audit"],
    tag: "div",
    window: { title: "Augment audit", icon: "fas fa-clipboard-check", resizable: true },
    position: { width: 940, height: 780 }
  };

  constructor(options = {}) {
    super(options);
    this.auditFilters = { q: "", s: "", r: "", f: "", limit: ROW_LIMIT };
    this.auditRows = null;
  }

  computeRows() {
    this.auditRows = game.items.filter(isAugment).sort((a, b) => a.name.localeCompare(b.name)).map(analyse);
  }

  async _renderHTML() {
    if (!game.user.isGM) return `<p class="aug-audit-empty">Only the GM can use the augment audit.</p>`;
    if (!this.auditRows) this.computeRows();
    return this.shellHTML();
  }

  _replaceHTML(result, content) {
    this.auditContent = content;
    content.innerHTML = result;
    this.bindShell(content);
    this.renderList();
  }

  /* ---------- markup ---------- */

  shellHTML() {
    const rows = this.auditRows;
    const counts = Object.fromEntries(Object.keys(STATUS).map(k => [k, rows.filter(r => r.status === k).length]));
    const outdated = rows.filter(r => r.outdated).length;
    const total = rows.length || 1;
    const families = [...new Set(rows.map(r => r.family).filter(Boolean))].sort();
    const bar = Object.keys(STATUS).map(k => `<span class="st-${k}" style="width:${(counts[k] / total) * 100}%"></span>`).join("");
    const legend = Object.entries(STATUS).map(([k, v]) =>
      `<div class="aug-audit-legend-item"><span class="aug-audit-swatch st-${k}"></span><b>${counts[k]}</b><span>${v.label}</span><em>${v.note}</em></div>`).join("");
    return `
      <div class="aug-audit">
        <section class="aug-audit-top">
          <p class="aug-audit-lede">${rows.length} augments in the Items directory, checked against the current rules.
            Expand one to compare its text with what it builds, then <strong>Test</strong> it on the test bench.</p>
          <div class="aug-audit-bar">${bar}</div>
          <div class="aug-audit-legend">${legend}</div>
          <div class="aug-audit-tools">
            ${outdated ? `<span class="aug-audit-outdated-note"><i class="fas fa-triangle-exclamation" inert></i> ${outdated} built with older rules</span>
              <button type="button" data-tool="rebuild-outdated"><i class="fas fa-arrows-rotate" inert></i> Rebuild those ${outdated}</button>` : ""}
            <button type="button" data-tool="bench"><i class="fas fa-user" inert></i> Open test bench</button>
            <button type="button" data-tool="clear"><i class="fas fa-broom" inert></i> Clear test bench</button>
            <button type="button" data-tool="refresh"><i class="fas fa-rotate-right" inert></i> Re-check</button>
          </div>
        </section>
        <section class="aug-audit-filters">
          <input type="search" name="q" placeholder="Search names, effects or families" value="${esc(this.auditFilters.q)}" aria-label="Search augments">
          <select name="s" aria-label="Status"><option value="">All statuses</option>${Object.entries(STATUS).map(([k, v]) =>
            `<option value="${k}" ${this.auditFilters.s === k ? "selected" : ""}>${v.label} (${counts[k]})</option>`).join("")}
            <option value="outdated" ${this.auditFilters.s === "outdated" ? "selected" : ""}>Built with older rules (${outdated})</option></select>
          <select name="r" aria-label="Rarity"><option value="">All rarities</option>${Object.entries(RARITIES).map(([k, v]) =>
            `<option value="${k}" ${this.auditFilters.r === k ? "selected" : ""}>${v.label}</option>`).join("")}</select>
          <select name="f" aria-label="Family"><option value="">All families</option>${families.map(f =>
            `<option value="${esc(f)}" ${this.auditFilters.f === f ? "selected" : ""}>${esc(f)}</option>`).join("")}</select>
          <span class="aug-audit-count"></span>
        </section>
        <div class="aug-audit-list"></div>
        <button type="button" class="aug-audit-more" hidden></button>
      </div>`;
  }

  rowHTML(row) {
    const color = RARITIES[row.rarity]?.color ?? "#8a93a6";
    return `<details class="aug-audit-row" data-id="${row.id}" style="--rarity:${color}">
      <summary>
        <img src="${esc(row.img)}" alt="">
        <span class="aug-audit-name">${esc(row.name)}<small>${esc(row.family)}</small></span>
        ${row.outdated ? `<span class="aug-audit-badge outdated" data-tooltip="Built with older rules. Rebuild to update.">Older rules</span>` : ""}
        <span class="aug-audit-rarity">${RARITIES[row.rarity]?.label ?? ""}</span>
        <span class="aug-audit-badge st-${row.status}">${STATUS[row.status].label}</span>
      </summary>
      <div class="aug-audit-body"></div>
    </details>`;
  }

  bodyHTML(row) {
    const builds = row.builds.length
      ? `<ul>${row.builds.map(b => `<li>${esc(b)}</li>`).join("")}</ul>`
      : `<p class="aug-audit-muted">Nothing rollable; it posts its reminders to chat when used.</p>`;
    const reminders = row.reminders.length
      ? `<h4>Chat reminders</h4><ul>${row.reminders.map(m => `<li>${m.tags.map(t => `<span class="aug-audit-tag">${esc(t)}</span>`).join("")}${esc(m.text)}</li>`).join("")}</ul>` : "";
    const flags = row.flags.length ? `<h4>Needs a look</h4><ul class="aug-audit-flags">${row.flags.map(f => `<li>${esc(f)}</li>`).join("")}</ul>` : "";
    return `
      <div class="aug-audit-cols">
        <div><h4>Effect text</h4><p>${boldMarkdown(row.text)}</p></div>
        <div><h4>What it builds</h4>${builds}${reminders}${flags}</div>
      </div>
      <div class="aug-audit-actions">
        <button type="button" data-row-action="test" ${row.canAutomate ? "" : "disabled"}><i class="fas fa-flask" inert></i> Test on bench</button>
        <button type="button" data-row-action="rebuild" ${row.canAutomate ? "" : "disabled"}><i class="fas fa-arrows-rotate" inert></i> Rebuild</button>
        <button type="button" data-row-action="open"><i class="fas fa-eye" inert></i> Open item</button>
      </div>
      <div class="aug-audit-test" hidden></div>`;
  }

  /* ---------- behaviour ---------- */

  filtered() {
    const q = this.auditFilters.q.toLowerCase();
    return this.auditRows.filter(r =>
      (!this.auditFilters.s || (this.auditFilters.s === "outdated" ? r.outdated : r.status === this.auditFilters.s))
      && (!this.auditFilters.r || r.rarity === this.auditFilters.r)
      && (!this.auditFilters.f || r.family === this.auditFilters.f)
      && (!q || r.name.toLowerCase().includes(q) || r.text.toLowerCase().includes(q) || r.family.toLowerCase().includes(q)));
  }

  renderList() {
    const root = this.auditContent;
    const list = root?.querySelector(".aug-audit-list");
    if (!list) return;
    const rows = this.filtered();
    const shown = rows.slice(0, this.auditFilters.limit);
    list.innerHTML = shown.length ? shown.map(r => this.rowHTML(r)).join("")
      : `<p class="aug-audit-empty">${this.auditRows.length ? "No augments match these filters." : "No augments in the Items directory yet. Import some first."}</p>`;
    root.querySelector(".aug-audit-count").textContent = `${rows.length} of ${this.auditRows.length}`;
    const more = root.querySelector(".aug-audit-more");
    more.hidden = rows.length <= this.auditFilters.limit;
    more.textContent = `Show ${Math.min(ROW_LIMIT, rows.length - this.auditFilters.limit)} more`;
    for (const d of list.querySelectorAll("details.aug-audit-row")) d.addEventListener("toggle", () => this.fillRow(d));
  }

  fillRow(details) {
    const body = details.querySelector(".aug-audit-body");
    if (!details.open || body.childElementCount) return;
    const row = this.auditRows.find(r => r.id === details.dataset.id);
    if (!row) return;
    body.innerHTML = this.bodyHTML(row);
    body.querySelectorAll("[data-row-action]").forEach(btn => btn.addEventListener("click", ev => {
      ev.preventDefault();
      this.rowAction(btn.dataset.rowAction, row, details);
    }));
  }

  async rowAction(action, row, details) {
    const item = game.items.get(row.id);
    if (!item) return ui.notifications.warn(`${row.name} no longer exists.`);
    if (action === "open") return openAugment(item.uuid);
    if (action === "rebuild") {
      await applyAutomation(item, null, { quiet: true });
      Object.assign(row, analyse(item));
      details.outerHTML = this.rowHTML(row);
      const fresh = this.auditContent.querySelector(`details.aug-audit-row[data-id="${row.id}"]`);
      fresh.addEventListener("toggle", () => this.fillRow(fresh));
      fresh.open = true;
      return ui.notifications.info(`${item.name} rebuilt.`);
    }
    if (action === "test") return this.showTest(item, details);
  }

  async showTest(item, details) {
    const panel = details.querySelector(".aug-audit-test");
    panel.hidden = false;
    panel.innerHTML = `<p class="aug-audit-muted"><i class="fas fa-spinner fa-spin" inert></i> Setting up the test bench...</p>`;
    let copy;
    try {
      copy = await benchCopy(item);
    } catch (err) {
      console.error(`${MODULE_ID} | Test bench failed`, err);
      panel.innerHTML = `<p class="aug-audit-flags">Couldn't set up the test bench: ${esc(err.message)}</p>`;
      return;
    }
    const acts = copy.system?.activities?.contents ?? [];
    const passives = copy.effects.filter(e => e.transfer && !e.disabled);
    panel.innerHTML = `
      <h4>Test on ${esc(copy.parent.name)}</h4>
      ${acts.length ? `<div class="aug-audit-acts">${acts.map(a => `
        <button type="button" data-activity="${a.id}"><i class="fas fa-play" inert></i>
          <span>${esc(a.name || item.name)}</span><em>${ACTIVATION[a.activation?.type] ?? a.activation?.type ?? ""}${a.activation?.condition ? `: ${esc(a.activation.condition)}` : ""}</em></button>`).join("")}</div>`
        : `<p class="aug-audit-muted">No abilities to use. This augment only has effects or reminders.</p>`}
      ${passives.length ? `<p class="aug-audit-muted">Always on while installed: ${passives.map(e => esc(e.name)).join(", ")}. Open the test bench to see them on its sheet.</p>` : ""}
      <div class="aug-audit-actions">
        <button type="button" data-test="post"><i class="fas fa-comment" inert></i> Post reminders to chat</button>
        <button type="button" data-test="sheet"><i class="fas fa-user" inert></i> Open test bench</button>
      </div>`;
    panel.querySelectorAll("[data-activity]").forEach(btn => btn.addEventListener("click", async ev => {
      ev.preventDefault();
      const activity = copy.system.activities.get(btn.dataset.activity);
      try { await activity?.use(); } catch (err) {
        console.error(`${MODULE_ID} | Using ${activity?.name} failed`, err);
        ui.notifications.error(`${activity?.name ?? "That ability"} failed: ${err.message}`);
      }
    }));
    panel.querySelector('[data-test="post"]').addEventListener("click", async () => {
      if (!(await postAugmentCard(copy))) ui.notifications.info(`${item.name} has no reminders or effects to post.`);
    });
    panel.querySelector('[data-test="sheet"]').addEventListener("click", () => copy.parent.sheet.render(true));
  }

  bindShell(root) {
    const on = (sel, ev, fn) => root.querySelector(sel)?.addEventListener(ev, fn);
    const refilter = () => { this.auditFilters.limit = ROW_LIMIT; this.renderList(); };
    on('input[name="q"]', "input", ev => { this.auditFilters.q = ev.target.value.trim(); refilter(); });
    for (const key of ["s", "r", "f"]) on(`select[name="${key}"]`, "change", ev => { this.auditFilters[key] = ev.target.value; refilter(); });
    on(".aug-audit-more", "click", () => { this.auditFilters.limit += ROW_LIMIT; this.renderList(); });
    root.querySelectorAll("[data-tool]").forEach(btn => btn.addEventListener("click", async ev => {
      ev.preventDefault();
      const tool = btn.dataset.tool;
      if (tool === "bench") return (await getBench()).sheet.render(true);
      if (tool === "clear") return ui.notifications.info(`Removed ${await clearBench()} test copies from the test bench.`);
      if (tool === "refresh") { this.auditRows = null; return this.render(); }
      if (tool === "rebuild-outdated") {
        const items = this.auditRows.filter(r => r.outdated).map(r => game.items.get(r.id)).filter(Boolean);
        btn.disabled = true;
        for (const item of items) await applyAutomation(item, null, { quiet: true });
        ui.notifications.info(`Rebuilt ${items.length} augments. Run Update all augments to update characters' copies too.`);
        this.auditRows = null;
        return this.render();
      }
    }));
  }
} : null;
