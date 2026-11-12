import { MODULE_ID, isAugment, getEffectText, escapeHTML as esc } from "./core.js";
import {
  analyzeEffect, applyOverride, activitySpec, applyAutomation, formulaToText, describeChanges, TRIGGERS
} from "./automation.js";
import { getReview, setOverride, setChecked, nameKey } from "./review.js";

/**
 * The audit's "Edit automation" panel. Shows what the reader built from the effect text as plain
 * fields, and saves whatever you change as a hand edit (see review.js). Unchanged fields aren't
 * stored, so they keep following the reader.
 */

const WHEN = { action: "Action", bonus: "Bonus action", reaction: "Reaction", special: "Triggered / free" };
const ROLLS = {
  save: "Saving throw", melee: "Melee attack", ranged: "Ranged attack", damage: "Damage only",
  heal: "Healing", temphp: "Temporary HP", utility: "No roll / other"
};
const ABILITIES = { str: "STR", dex: "DEX", con: "CON", int: "INT", wis: "WIS", cha: "CHA" };
const SHAPES = { "": "No area", radius: "Radius", sphere: "Sphere", cylinder: "Cylinder", cone: "Cone", line: "Line", cube: "Cube", square: "Square" };
const UNITS = { "": "No duration", round: "Rounds", minute: "Minutes", hour: "Hours", day: "Days" };

const opts = (map, cur) => Object.entries(map).map(([k, v]) => `<option value="${k}" ${String(cur ?? "") === k ? "selected" : ""}>${esc(v)}</option>`).join("");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The reader's own output (no hand edits), with each activity's editor fields. */
function baseOf(item) {
  const text = getEffectText(item);
  const result = analyzeEffect(text, { name: item.name, img: item.img, seed: item.id });
  const specs = result.activities.map(a => activitySpec(a, result.triggers.find(t => t.activity === a._id && !t.remind && !t.areaInfo)));
  return { text, result, specs };
}

function actHTML(spec, { key, removed = false, added = false, base = null }) {
  const trig = new Set(spec.triggers ?? []);
  const changed = base && !same(spec, base);
  // The moment's finer choices (whose turn, range, "only if"...) are set in Change augment; they're carried through here.
  const moment = spec.moment !== undefined ? ` data-moment="${esc(JSON.stringify(spec.moment))}"` : "";
  return `<fieldset class="aug-ed-act${removed ? " removed" : ""}" data-key="${key}" data-roll="${esc(spec.roll)}"${moment}>
    <div class="aug-ed-head">
      <input type="text" name="name" value="${esc(spec.name)}" aria-label="Name">
      ${changed ? `<span class="aug-ed-pill">edited</span>` : ""}
      ${added ? `<button type="button" data-ed="drop" data-tooltip="Remove this roll"><i class="fas fa-trash" inert></i></button>`
        : `<label class="aug-ed-keep" data-tooltip="Untick to remove this roll from the augment"><input type="checkbox" name="keep" ${removed ? "" : "checked"}> Keep</label>`}
      ${base && changed ? `<button type="button" data-ed="revert" data-tooltip="Back to what the reader built"><i class="fas fa-rotate-left" inert></i></button>` : ""}
    </div>
    <div class="aug-ed-grid">
      <label>When<select name="activation">${opts(WHEN, spec.activation)}</select></label>
      <label class="wide">Condition<input type="text" name="condition" value="${esc(spec.condition)}" placeholder="e.g. When a creature ends its turn in the area"></label>
      <label>Roll<select name="roll">${opts(ROLLS, spec.roll)}</select></label>
      <label class="f-save">Save<select name="ability">${opts(ABILITIES, spec.ability)}</select></label>
      <label class="f-save chk"><input type="checkbox" name="half" ${spec.half ? "checked" : ""}> Half on success</label>
      <label class="f-dmg wide">Damage<input type="text" name="damage" value="${esc(spec.damage)}" placeholder="2d8 + MOD fire; PB cold"></label>
      <label class="f-heal wide">Amount<input type="text" name="heal" value="${esc(spec.heal)}" placeholder="1d8 + PB"></label>
      <label class="f-extra">Extra roll<input type="text" name="extra" value="${esc(spec.extra)}" placeholder="1d4"></label>
      <label class="f-extra">Label<input type="text" name="extraName" value="${esc(spec.extraName)}" placeholder="Bonus die"></label>
      <label>Area<select name="areaType">${opts(SHAPES, spec.area?.type ?? "")}</select></label>
      <label>Size (ft)<input type="number" name="areaSize" min="5" step="5" value="${esc(spec.area?.size ?? "")}"></label>
      <label>Lasts<input type="number" name="durValue" min="1" value="${esc(spec.duration?.value ?? "")}"></label>
      <label><span>&nbsp;</span><select name="durUnits">${opts(UNITS, spec.duration?.units ?? "")}</select></label>
      <label class="chk"><input type="checkbox" name="concentration" ${spec.concentration ? "checked" : ""}> Concentration</label>
      <label class="chk"><input type="checkbox" name="consume" ${spec.consume ? "checked" : ""}> Spends a use</label>
    </div>
    <details class="aug-ed-trig" ${trig.size ? "open" : ""}>
      <summary>Prompt automatically ${trig.size ? `<em>${trig.size} moment${trig.size === 1 ? "" : "s"}</em>` : "<em>never</em>"}</summary>
      <div class="aug-ed-chips">${Object.entries(TRIGGERS).map(([k, t]) =>
        `<label class="aug-ed-chip"><input type="checkbox" name="trig" value="${k}" ${trig.has(k) ? "checked" : ""}><span>${esc(t.label)}</span></label>`).join("")}</div>
      <label class="chk"><input type="checkbox" name="once" ${spec.once ? "checked" : ""}> Only once per round</label>
    </details>
  </fieldset>`;
}

function readAct(fs) {
  const out = readFields(fs);
  const { spec } = out;
  if (fs.dataset.moment !== undefined) {
    const shown = JSON.parse(fs.dataset.moment || "null");
    const sameKinds = JSON.stringify(spec.triggers) === JSON.stringify(shown?.kinds ?? []);
    const wasOnce = !!shown && shown.often !== "always";
    if (!spec.triggers.length) spec.moment = null;
    else if (sameKinds && wasOnce === spec.once) spec.moment = shown;
    else spec.moment = {
      who: "self", side: "any", range: null, outcome: "any", cond: null, ...(shown ?? {}),
      kinds: spec.triggers, often: spec.once ? (wasOnce ? shown.often : "round") : "always"
    };
  }
  return out;
}

function readFields(fs) {
  const v = n => fs.querySelector(`[name="${n}"]`);
  const areaType = v("areaType").value;
  const units = v("durUnits").value;
  return {
    spec: {
      name: v("name").value.trim(),
      activation: v("activation").value,
      condition: v("condition").value.trim(),
      roll: v("roll").value,
      ability: v("ability").value,
      half: v("half").checked,
      damage: v("damage").value.trim(),
      heal: v("heal").value.trim(),
      extra: v("extra").value.trim(),
      extraName: v("extraName").value.trim(),
      area: areaType ? { type: areaType, size: Number(v("areaSize").value) || 5 } : null,
      concentration: v("concentration").checked,
      duration: units ? { value: String(v("durValue").value || "1"), units } : null,
      consume: v("consume").checked,
      triggers: [...fs.querySelectorAll('[name="trig"]:checked')].map(c => c.value),
      once: v("once").checked
    },
    removed: v("keep") ? !v("keep").checked : false
  };
}

function reminderHTML(r, i) {
  return `<div class="aug-ed-rem" data-i="${i}"${r.moment !== undefined ? ` data-moment="${esc(JSON.stringify(r.moment))}"` : ""}>
    <input type="text" name="tags" value="${esc((r.tags ?? []).join(", "))}" placeholder="Tags" aria-label="Tags">
    <textarea name="text" rows="2" aria-label="Reminder">${esc(r.text)}</textarea>
    <button type="button" data-ed="drop-rem" data-tooltip="Remove this reminder"><i class="fas fa-trash" inert></i></button>
  </div>`;
}

/** Open the editor in `panel` for a world augment. onDone(saved) runs after Save or Cancel. */
export function openEditor(panel, item, { onDone } = {}) {
  const base = baseOf(item);
  const review = getReview(item);
  // Working copy of the saved edits; the setting itself is only written on Save.
  const ov = foundry.utils.deepClone(review?.override ?? {});
  const added = (ov.added ?? []).map(s => ({ ...s }));
  let markChecked = true;

  const render = () => {
    const usesNow = ov.uses?.none ? null : ov.uses?.max ? ov.uses
      : base.result.uses ? { max: formulaToText(base.result.uses.max), period: base.result.uses.period } : null;
    const reminders = Array.isArray(ov.reminders) ? ov.reminders : base.result.reminders;
    const acts = base.specs.map((spec, i) => {
      const o = ov.activities?.[`a${i}`];
      return actHTML(o?.spec ?? spec, { key: `a${i}`, removed: !!o?.removed, base: spec });
    }).join("");
    const extra = added.map((spec, i) => actHTML(spec, { key: `n${i}`, added: true })).join("");
    const effects = base.result.effects.map((e, i) => `
      <label class="aug-ed-eff"><input type="checkbox" name="eff" value="e${i}" ${ov.effects?.[`e${i}`]?.removed ? "" : "checked"}>
        <img src="${esc(e.img)}" alt=""><span><strong>${esc(e.name)}</strong><em>${esc(describeChanges(e) || (e.statuses ?? []).join(", ") || e.flags?.[MODULE_ID]?.kind || "")}</em></span></label>`).join("");
    panel.innerHTML = `
      <div class="aug-ed">
        <div class="aug-ed-intro">
          <p>Change anything the reader got wrong. Only what you change is saved; the rest keeps following the effect text.
          In formulas, <b>PB</b> is proficiency bonus and <b>MOD</b> is the augment ability modifier; separate damage types with <b>;</b>.</p>
        </div>
        <section><h4>Uses</h4>
          <div class="aug-ed-grid">
            <label>Limited uses<select name="usesOn">${opts({ "": "No limit", on: "Limited" }, usesNow ? "on" : "")}</select></label>
            <label>How many<input type="text" name="usesMax" value="${esc(usesNow?.max ?? "PB")}" placeholder="PB"></label>
            <label>Recover on<select name="usesPeriod">${opts({ lr: "Long rest", sr: "Short or long rest" }, usesNow?.period ?? "lr")}</select></label>
          </div>
        </section>
        <section><h4>Rolls</h4>
          <div class="aug-ed-acts">${acts || `<p class="aug-audit-muted">The reader built no rolls.</p>`}${extra}</div>
          <button type="button" data-ed="add"><i class="fas fa-plus" inert></i> Add a roll</button>
        </section>
        ${effects ? `<section><h4>Effects</h4><div class="aug-ed-effs">${effects}</div></section>` : ""}
        <section><h4>Chat reminders</h4>
          <div class="aug-ed-rems">${reminders.map(reminderHTML).join("")}</div>
          <button type="button" data-ed="add-rem"><i class="fas fa-plus" inert></i> Add a reminder</button>
        </section>
        <section class="aug-ed-preview"><h4>It will build</h4><ul></ul></section>
        <footer class="aug-ed-foot">
          <label class="chk"><input type="checkbox" name="markChecked" ${markChecked ? "checked" : ""}> Mark as checked</label>
          <span class="aug-ed-spacer"></span>
          ${review?.override ? `<button type="button" data-ed="reset" data-tooltip="Remove all your edits"><i class="fas fa-eraser" inert></i> Reset to automatic</button>` : ""}
          <button type="button" data-ed="more" data-tooltip="Open this augment in Change augment, where you can also set whose turn, range, how often and 'only if' for each moment, and when each reminder shows"><i class="fas fa-sliders" inert></i> More options</button>
          <button type="button" data-ed="cancel">Cancel</button>
          <button type="button" data-ed="save" class="primary"><i class="fas fa-floppy-disk" inert></i> Save</button>
        </footer>
      </div>`;
    bind();
    preview();
  };

  /** Turn the form into an override, storing only what differs from the reader. */
  const collect = () => {
    const out = {};
    const acts = {};
    panel.querySelectorAll(".aug-ed-act").forEach(fs => {
      const key = fs.dataset.key;
      const { spec, removed } = readAct(fs);
      if (key.startsWith("n")) { added[Number(key.slice(1))] = spec; return; }
      const i = Number(key.slice(1));
      if (removed) acts[key] = { removed: true };
      else if (!same(spec, base.specs[i])) acts[key] = { spec };
    });
    if (Object.keys(acts).length) out.activities = acts;
    if (added.length) out.added = added;

    const on = panel.querySelector('[name="usesOn"]').value === "on";
    const uses = on ? { max: panel.querySelector('[name="usesMax"]').value.trim() || "PB", period: panel.querySelector('[name="usesPeriod"]').value } : null;
    const baseUses = base.result.uses ? { max: formulaToText(base.result.uses.max), period: base.result.uses.period } : null;
    if (!same(uses, baseUses)) out.uses = uses ?? { none: true };

    const effs = {};
    panel.querySelectorAll('[name="eff"]').forEach(c => { if (!c.checked) effs[c.value] = { removed: true }; });
    if (Object.keys(effs).length) out.effects = effs;

    const rems = [...panel.querySelectorAll(".aug-ed-rem")].map(el => {
      const r = {
        tags: el.querySelector('[name="tags"]').value.split(",").map(t => t.trim()).filter(Boolean),
        text: el.querySelector('[name="text"]').value.trim()
      };
      if (el.dataset.moment !== undefined) r.moment = JSON.parse(el.dataset.moment || "null");
      return r;
    }).filter(r => r.text);
    const baseRems = base.result.reminders.map(r => ({ tags: r.tags, text: r.text }));
    if (!same(rems, baseRems)) out.reminders = rems;
    return Object.keys(out).length ? out : null;
  };

  const preview = foundry.utils.debounce(() => {
    const list = panel.querySelector(".aug-ed-preview ul");
    if (!list) return;
    try {
      const fresh = analyzeEffect(base.text, { name: item.name, img: item.img, seed: item.id });
      const ov2 = collect();
      if (ov2) applyOverride(fresh, ov2, { name: item.name, seed: item.id });
      list.innerHTML = fresh.summary.map(s => `<li>${esc(s)}</li>`).join("") || `<li class="aug-audit-muted">Nothing; reminders only.</li>`;
    } catch (err) {
      list.innerHTML = `<li class="aug-audit-flags">${esc(err.message)}</li>`;
    }
  }, 120);

  const bind = () => {
    panel.querySelectorAll(".aug-ed-act").forEach(fs => {
      fs.querySelector('[name="roll"]').addEventListener("change", ev => { fs.dataset.roll = ev.target.value; });
      fs.querySelector('[name="keep"]')?.addEventListener("change", ev => fs.classList.toggle("removed", !ev.target.checked));
    });
    panel.querySelector(".aug-ed").addEventListener("input", preview);
    panel.querySelector(".aug-ed").addEventListener("change", preview);
    panel.querySelectorAll("[data-ed]").forEach(btn => btn.addEventListener("click", async ev => {
      ev.preventDefault();
      const what = btn.dataset.ed;
      if (["add", "drop", "revert", "add-rem", "drop-rem"].includes(what)) {
        // Remember everything typed so far, then redraw.
        const keep = collect() ?? {};
        for (const k of ["activities", "uses", "effects"]) { if (keep[k]) ov[k] = keep[k]; else delete ov[k]; }
        ov.reminders = currentReminders();
        markChecked = panel.querySelector('[name="markChecked"]').checked;
        const fs = btn.closest(".aug-ed-act");
        if (what === "add") added.push({ ...activitySpec({ type: "utility", name: `${item.name}: New roll`, activation: { type: "special", condition: "" }, consumption: { targets: [] } }) });
        if (what === "drop") added.splice(Number(fs.dataset.key.slice(1)), 1);
        if (what === "revert") delete ov.activities?.[fs.dataset.key];
        if (what === "add-rem") ov.reminders.push({ tags: ["Rule"], text: "" });
        if (what === "drop-rem") {
          const i = Number(btn.closest(".aug-ed-rem").dataset.i);
          ov.reminders = ov.reminders.filter((_, j) => j !== i);
        }
        return render();
      }
      if (what === "cancel") return onDone?.(false);
      if (what === "more") {
        const { openChangeAugment } = await import("./edit-augment.js");
        openChangeAugment(item, { tab: "rules" });
        return onDone?.(false);
      }
      if (what === "reset") {
        await setOverride(item, null);
        await rebuildEverywhere(item);
        ui.notifications.info(`${item.name}: back to automatic.`);
        return onDone?.(true);
      }
      if (what === "save") {
        btn.disabled = true;
        const override = collect();
        await setOverride(item, override);
        const result = await rebuildEverywhere(item);
        if (panel.querySelector('[name="markChecked"]').checked) await setChecked(item, true, result);
        ui.notifications.info(override ? `${item.name}: your changes are saved.` : `${item.name}: nothing differs from the automatic version.`);
        return onDone?.(true);
      }
    }));
  };

  // Reminders exactly as typed (blank ones included, so a just-added row stays on screen).
  // Moments set in Change augment ride along on each reminder, so a redraw here keeps them.
  const currentReminders = () => [...panel.querySelectorAll(".aug-ed-rem")].map(el => {
    const r = { tags: el.querySelector('[name="tags"]').value.split(",").map(t => t.trim()).filter(Boolean), text: el.querySelector('[name="text"]').value };
    if (el.dataset.moment !== undefined) r.moment = JSON.parse(el.dataset.moment || "null");
    return r;
  });

  render();
}

/** Rebuild the Items-folder augment and every character's copy with the same name. */
export async function rebuildEverywhere(item) {
  const key = nameKey(item.name);
  const copies = game.actors.contents.flatMap(a => a.items.contents).filter(i => isAugment(i) && nameKey(i.name) === key);
  let result = null;
  for (const it of [item, ...copies]) {
    if (it.system?.activities === undefined) continue;
    const r = await applyAutomation(it, null, { quiet: true });
    if (it === item) result = r;
  }
  return result;
}
