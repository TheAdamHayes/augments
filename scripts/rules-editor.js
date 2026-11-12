import { MODULE_ID, escapeHTML as esc } from "./core.js";
import {
  analyzeEffect, applyOverride, activitySpec, formulaToText, describeChanges, describeMoment, momentOf, whoFor, TRIGGERS
} from "./automation.js";

/**
 * "Edit rules" in the Change augment window: what the module runs for an augment, as plain choices.
 * Every roll, its moment (when it prompts), the uses, the effects and every chat reminder (what it
 * says and when it shows) can be changed without touching the augment's text. Only what differs
 * from what the module reads in the text is saved, as the augment's hand edits (the same ones the
 * audit window uses), so they apply to every copy and survive re-imports.
 */

const opts = (map, cur) => Object.entries(map).map(([k, v]) => `<option value="${esc(k)}" ${String(cur ?? "") === k ? "selected" : ""}>${esc(v)}</option>`).join("");
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const clone = x => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

const WHEN = { action: "An action", bonus: "A bonus action", reaction: "A reaction", special: "No action (it just happens)" };
const ROLLS = {
  save: "A saving throw", melee: "A melee attack", ranged: "A ranged attack", damage: "Damage (no attack or save)",
  heal: "Healing", temphp: "Temporary hit points", utility: "No roll, or another roll"
};
const ABILITIES = { str: "Strength", dex: "Dexterity", con: "Constitution", int: "Intelligence", wis: "Wisdom", cha: "Charisma" };
const SHAPES = { "": "No area", radius: "Radius around a point", sphere: "Sphere", cylinder: "Cylinder", cone: "Cone", line: "Line", cube: "Cube", square: "Square" };
const UNITS = { "": "Instant", round: "Rounds", minute: "Minutes", hour: "Hours", day: "Days" };
const TAGS = ["Rule", "Attacks", "Movement", "Opportunity attacks", "Forced movement", "Target", "Allies", "Damage rules", "Advantage", "Stealth", "Cover", "Resource", "Stacks"];
const WHO = { self: "Yours", selfOrAlly: "Yours or an ally's", ally: "An ally's", enemy: "An enemy's" };
const SIDE = { any: "Any creature", ally: "Allies only", enemy: "Enemies only" };
const OUTCOME = { any: "Either result", fail: "Only if it fails", success: "Only if it succeeds" };
const OFTEN = { always: "Every time", turn: "At most once per turn", round: "At most once per round" };
const CONDS = {
  "": "Nothing else", movedAtLeast: "You moved at least … feet this turn", movedAtMost: "You moved no more than … feet this turn",
  noDamage: "You dealt no damage this turn", dealtDamage: "You damaged an enemy this turn", belowHalf: "You're below half your hit points",
  crit: "It was a critical hit (with “you hit with an attack”)",
  ask: "Ask the player (write the question)"
};
export const MOMENT_GROUPS = [
  ["Your turn", ["turnStart", "turnEnd", "initiative"]],
  ["Hit points", ["damaged", "bloodied", "zeroHp", "regainHp", "gainTemp"]],
  ["Attacks", ["attackHit", "dealDamage", "missedBy"]],
  ["Rolls", ["saveRoll", "checkRoll", "hitDie"]],
  ["Magic and resources", ["castSpell", "spendResource", "heal"]],
  ["Rests", ["shortRest", "longRest"]],
  ["Allies and enemies", ["allyDamaged", "allyBloodied", "allyZero", "enemyZero"]],
  ["Areas (for augments that place one)", ["areaEnter", "areaStart", "areaEnd"]]
];
const cap = s => String(s ?? "").charAt(0).toUpperCase() + String(s ?? "").slice(1);

/* -------------------------------------------- */
/*  What the module reads from the text         */
/* -------------------------------------------- */

/** The reader's own output for a text (no hand edits), as editor fields. */
export function rulesBase(item, text) {
  const seed = item.id ?? item.name;
  const result = analyzeEffect(text, { name: item.name, img: item.img, seed });
  const own = a => result.triggers.find(t => t.activity === a._id && !t.remind && !t.areaInfo) ?? null;
  const specs = result.activities.map(a => activitySpec(a, own(a)));
  const reminders = result.reminders.map(r => ({ tags: [...r.tags], text: r.text, moment: momentOf(result.triggers.find(t => t.remind && t.text === r.text)) }));
  const uses = result.uses ? { max: formulaToText(result.uses.max), period: result.uses.period } : null;
  return { result, specs, reminders, uses, trackerId: result.trackerId ?? null, seed };
}

/** The rules as they stand with the edits `ov` (what the editor shows). */
function current(base, ov) {
  const acts = base.specs.map((spec, i) => {
    const o = ov.activities?.[`a${i}`];
    return { key: `a${i}`, spec: clone(o?.spec ?? spec), removed: !!o?.removed, base: spec, tracker: base.result.activities[i]?._id === base.trackerId };
  });
  (ov.added ?? []).forEach((spec, i) => acts.push({ key: `n${i}`, spec: clone(spec), added: true }));
  const uses = ov.uses?.none ? null : ov.uses?.max ? { ...ov.uses } : base.uses;
  const reminders = Array.isArray(ov.reminders)
    ? ov.reminders.map(r => {
      const b = base.reminders.find(x => x.text === r.text);
      return { tags: [...(r.tags ?? [])], text: r.text, src: r.src ?? b?.text ?? null, moment: r.moment !== undefined ? clone(r.moment) : (b?.moment ?? null), base: b ?? null };
    })
    : base.reminders.map(r => ({ ...clone(r), src: r.text, base: r }));
  const effects = base.result.effects.map((e, i) => ({ key: `e${i}`, effect: e, removed: !!ov.effects?.[`e${i}`]?.removed }));
  return { acts, uses, reminders, effects };
}

/** Specs compared without caring about the order moments were ticked in. */
const sameSet = (a, b) => !!b && a.length === b.length && a.every(x => b.includes(x));
const sortKinds = spec => spec && ({ ...spec, triggers: [...(spec.triggers ?? [])].sort(), moment: spec.moment ? { ...spec.moment, kinds: [...spec.moment.kinds].sort() } : spec.moment });
const sameSpec = (a, b) => same(sortKinds(a), sortKinds(b));
const sameMoment = (a, b) => same(a ? { ...a, kinds: [...a.kinds].sort() } : a, b ? { ...b, kinds: [...b.kinds].sort() } : b);

/** Is the rule edited compared with the reader's version? */
const editedAct = a => a.added || a.removed || !sameSpec(a.spec, a.base);
const editedRem = r => !r.base || !sameMoment(r.moment, r.base.moment) || !same(r.tags, r.base.tags);

/* -------------------------------------------- */
/*  HTML                                        */
/* -------------------------------------------- */

function momentHTML(m, { reminder = false } = {}) {
  const on = !!m?.kinds?.length;
  const kinds = new Set(m?.kinds ?? []);
  const area = [...kinds].some(k => TRIGGERS[k]?.area);
  const rolls = [...kinds].some(k => k === "saveRoll" || k === "checkRoll");
  const who = m?.who ?? "self";
  const cond = m?.cond ?? null;
  const odd = cond?.type && !CONDS[cond.type];
  const condOpts = odd ? { keep: `As the text says (${cond.label ? `after using ${cond.label}` : cond.type})`, ...CONDS } : CONDS;
  return `<div class="aug-rl-when" data-moment ${odd ? `data-cond="${esc(JSON.stringify(cond))}"` : ""}>
    <label class="aug-rl-wide"><span>${reminder ? "When it shows" : "When it's used"}</span>
      <select name="m-mode">${opts(reminder
        ? { none: "On the augment's chat card when you use it", moment: "Also as its own card at a moment in play" }
        : { none: "When you click it on the sheet", moment: "Prompt automatically at a moment in play" }, on ? "moment" : "none")}</select></label>
    <div class="aug-rl-moment" ${on ? "" : "hidden"}>
      <p class="aug-rl-ask">Which moment? Tick one or more.</p>
      <div class="aug-rl-groups">${MOMENT_GROUPS.map(([g, ks]) => `<div class="aug-rl-group"><span>${esc(g)}</span>${ks.filter(k => TRIGGERS[k]).map(k =>
        `<label class="aug-rl-chip"><input type="checkbox" name="m-kind" value="${k}" ${kinds.has(k) ? "checked" : ""}><span>${esc(cap(TRIGGERS[k].label))}</span></label>`).join("")}</div>`).join("")}</div>
      <div class="aug-rl-grid">
        <label class="m-who" ${area ? "hidden" : ""}><span>Whose moment</span><select name="m-who">${opts(WHO, who)}</select></label>
        <label class="m-range" ${area || who === "self" ? "hidden" : ""}><span>Within (feet)</span><input type="number" name="m-range" min="0" step="5" value="${esc(m?.range ?? "")}" placeholder="${who === "enemy" ? "any" : "30"}"></label>
        <label class="m-side" ${area ? "" : "hidden"}><span>Which creatures</span><select name="m-side">${opts(SIDE, m?.side ?? "any")}</select></label>
        <label class="m-outcome" ${rolls ? "" : "hidden"}><span>Roll result</span><select name="m-outcome">${opts(OUTCOME, m?.outcome ?? "any")}</select></label>
        <label><span>How often</span><select name="m-often">${opts(OFTEN, m?.often ?? "always")}</select></label>
        <label><span>Only if</span><select name="m-cond">${opts(condOpts, odd ? "keep" : cond?.type ?? "")}</select></label>
        <label class="m-condn" ${cond?.type === "movedAtLeast" || cond?.type === "movedAtMost" ? "" : "hidden"}><span>Feet</span><input type="number" name="m-condn" min="0" step="5" value="${esc(cond?.n ?? 20)}"></label>
        <label class="m-condt aug-rl-wide" ${cond?.type === "ask" ? "" : "hidden"}><span>Question on the card</span><input type="text" name="m-condt" value="${esc(cond?.text ?? "")}" placeholder="Only if you took the Dodge action this turn."></label>
      </div>
      <p class="aug-rl-hint m-areanote" ${area ? "" : "hidden"}><i class="fas fa-circle-info" inert></i> Area moments only happen for an augment that places an area (a roll with an Area set).</p>
      <p class="aug-rl-hint m-critnote" ${cond?.type === "crit" && !kinds.has("attackHit") ? "" : "hidden"}><i class="fas fa-circle-info" inert></i> The module can only tell a critical hit for “When you hit with an attack”. For other moments the card asks the player instead.</p>
      <p class="aug-rl-reads"><i class="fas fa-comment-dots" inert></i> <span>${esc(describeMoment(m) || "Tick a moment above.")}</span></p>
    </div>
  </div>`;
}

function actHTML(a, i, open) {
  const s = a.spec;
  const title = a.tracker ? "Use counter (spends a use)" : s.name || "Roll";
  const when = s.moment?.kinds?.length ? describeMoment(s.moment) : WHEN[s.activation] ?? s.activation;
  return `<details class="aug-rl-card act${a.removed ? " removed" : ""}" data-key="${a.key}" data-roll="${esc(s.roll)}" ${a.tracker ? "data-tracker" : ""} ${open ? "open" : ""}>
    <summary><i class="fas ${a.removed ? "fa-ban" : "fa-dice-d20"}" inert></i><b>${esc(title)}</b><span class="aug-rl-when-line">${esc(when)}</span>
      ${editedAct(a) ? `<span class="aug-rl-badge">${a.added ? "added" : a.removed ? "removed" : "edited"}</span>` : ""}</summary>
    <div class="aug-rl-body">
      <div class="aug-rl-grid">
        <label class="aug-rl-wide"><span>Name on the button</span><input type="text" name="name" value="${esc(s.name)}"></label>
        <label><span>Takes</span><select name="activation">${opts(s.activation in WHEN ? WHEN : { ...WHEN, [s.activation]: cap(s.activation) }, s.activation)}</select></label>
        <label class="aug-rl-wide"><span>Note shown with it (optional)</span><input type="text" name="condition" value="${esc(s.condition)}" placeholder="e.g. When a creature ends its turn in the area"></label>
        <label><span>What it rolls</span><select name="roll">${opts(s.roll in ROLLS ? ROLLS : { ...ROLLS, [s.roll]: cap(s.roll) }, s.roll)}</select></label>
        <label class="f-save"><span>Saving throw</span><select name="ability">${opts(ABILITIES, s.ability)}</select></label>
        <label class="f-save aug-rl-check"><input type="checkbox" name="half" ${s.half ? "checked" : ""}> Half damage on a success</label>
        <label class="f-dmg aug-rl-wide"><span>Damage</span><input type="text" name="damage" value="${esc(s.damage)}" placeholder="2d8 + MOD fire; PB cold"></label>
        <label class="f-heal aug-rl-wide"><span>How much</span><input type="text" name="heal" value="${esc(s.heal)}" placeholder="1d8 + PB"></label>
        <label class="f-extra"><span>Roll</span><input type="text" name="extra" value="${esc(s.extra)}" placeholder="1d4"></label>
        <label class="f-extra"><span>Roll's name</span><input type="text" name="extraName" value="${esc(s.extraName)}" placeholder="Bonus die"></label>
        <label><span>Area</span><select name="areaType">${opts(SHAPES, s.area?.type ?? "")}</select></label>
        <label class="f-areasize" ${s.area?.type ? "" : "hidden"}><span>Size (feet)</span><input type="number" name="areaSize" min="5" step="5" value="${esc(s.area?.size ?? 15)}"></label>
        <div class="aug-rl-wide aug-rl-dur"><span>Lasts</span>
          <div><input type="number" name="durValue" min="1" value="${esc(s.duration?.value ?? 1)}" aria-label="How long" ${s.duration?.units ? "" : "hidden"}>
          <select name="durUnits" aria-label="Units">${opts(UNITS, s.duration?.units ?? "")}</select></div></div>
        <label class="aug-rl-check"><input type="checkbox" name="concentration" ${s.concentration ? "checked" : ""}> Needs concentration</label>
        <label class="aug-rl-check"><input type="checkbox" name="consume" ${s.consume ? "checked" : ""}> Spends one of the augment's uses</label>
      </div>
      ${momentHTML(s.moment)}
      <div class="aug-rl-actions">
        ${a.added ? `<button type="button" data-rl="drop-act"><i class="fas fa-trash" inert></i> Remove this roll</button>`
          : `<label class="aug-rl-check"><input type="checkbox" name="keep" ${a.removed ? "" : "checked"}> Keep this roll</label>`}
        ${!a.added && editedAct(a) ? `<button type="button" data-rl="revert-act"><i class="fas fa-rotate-left" inert></i> Back to what the text says</button>` : ""}
      </div>
    </div>
  </details>`;
}

function remHTML(r, i, open, count) {
  const tags = new Set(r.tags ?? []);
  const when = r.moment?.kinds?.length ? describeMoment(r.moment) : "On the augment's card when used";
  return `<details class="aug-rl-card rem" data-i="${i}" ${r.src ? `data-src="${esc(r.src)}"` : ""} ${open ? "open" : ""}>
    <summary><i class="fas fa-scroll" inert></i><b>${esc(String(r.text || "New reminder").slice(0, 70))}${String(r.text).length > 70 ? "…" : ""}</b>
      <span class="aug-rl-when-line">${esc(when)}</span>${editedRem(r) ? `<span class="aug-rl-badge">${r.base ? "edited" : "new"}</span>` : ""}</summary>
    <div class="aug-rl-body">
      <label class="aug-rl-field"><span>What the reminder says in chat</span>
        <textarea name="text" rows="3" placeholder="e.g. Allies within 10 feet can't be frightened while you're conscious.">${esc(r.text)}</textarea></label>
      <div class="aug-rl-tags"><span>Labels</span>${[...TAGS, ...(r.tags ?? []).filter(t => !TAGS.includes(t))].map(t => `<label class="aug-rl-chip small"><input type="checkbox" name="tag" value="${esc(t)}" ${tags.has(t) ? "checked" : ""}><span>${esc(t)}</span></label>`).join("")}</div>
      ${momentHTML(r.moment, { reminder: true })}
      <div class="aug-rl-actions">
        <button type="button" data-rl="rem-up" ${i === 0 ? "disabled" : ""} data-tooltip="Move up"><i class="fas fa-arrow-up" inert></i></button>
        <button type="button" data-rl="rem-down" ${i === count - 1 ? "disabled" : ""} data-tooltip="Move down"><i class="fas fa-arrow-down" inert></i></button>
        <button type="button" data-rl="rem-del"><i class="fas fa-trash" inert></i> Remove</button>
        ${r.base && editedRem(r) ? `<button type="button" data-rl="rem-revert"><i class="fas fa-rotate-left" inert></i> Back to what the text says</button>` : ""}
      </div>
    </div>
  </details>`;
}

const count = n => (n ? ` <span class="aug-rl-count">${n} changed</span>` : "");

/** The whole "Edit rules" panel. open: keys of cards to show expanded. */
export function rulesHTML(base, ov, { open = new Set(), textChanged = false, suggestion = null } = {}) {
  const c = current(base, ov);
  const edits = Object.keys(ov ?? {}).length;
  const usesOn = !!c.uses;
  return `<div class="aug-rl">
    <div class="aug-rl-top">
      <p>These are the rules the module runs for this augment. Change any of them here <b>without changing the text</b>.
        Your changes apply to every copy and are kept when the augment is re-imported.</p>
      <div class="aug-rl-topbtns">
        <button type="button" data-rl="suggest-text"><i class="fas fa-pen-fancy" inert></i> Write text from these rules</button>
        ${edits ? `<button type="button" data-rl="reset-all"><i class="fas fa-eraser" inert></i> Undo all rule changes</button>` : ""}
      </div>
      ${textChanged && (ov.activities || ov.effects) ? `<p class="aug-rl-warn"><i class="fas fa-triangle-exclamation" inert></i> You've changed the text too. Rule changes are matched to the rolls by order, so check each roll below still looks right.</p>` : ""}
    </div>
    ${suggestion ?? ""}
    <section><h3><i class="fas fa-battery-half" inert></i> Uses${count(ov.uses ? 1 : 0)}</h3>
      <div class="aug-rl-grid aug-rl-uses">
        <label><span>Limited uses</span><select name="usesOn">${opts({ "": "No limit", on: "Limited" }, usesOn ? "on" : "")}</select></label>
        <label class="u-on" ${usesOn ? "" : "hidden"}><span>How many (PB = proficiency bonus)</span><input type="text" name="usesMax" value="${esc(c.uses?.max ?? "PB")}"></label>
        <label class="u-on" ${usesOn ? "" : "hidden"}><span>Come back after</span><select name="usesPeriod">${opts({ lr: "A long rest", sr: "A short or long rest" }, c.uses?.period ?? "lr")}</select></label>
      </div>
    </section>
    <section><h3><i class="fas fa-dice-d20" inert></i> Rolls and buttons${count(c.acts.filter(editedAct).length)}</h3>
      ${c.acts.map((a, i) => actHTML(a, i, open.has(a.key))).join("") || `<p class="aug-rl-muted">No rolls. Add one if this augment should roll something.</p>`}
      <button type="button" data-rl="add-act"><i class="fas fa-plus" inert></i> Add a roll</button>
    </section>
    ${c.effects.length ? `<section><h3><i class="fas fa-wand-sparkles" inert></i> Effects${count(c.effects.filter(e => e.removed).length)}</h3>
      ${c.effects.map(e => `<label class="aug-rl-eff${e.removed ? " removed" : ""}"><input type="checkbox" name="eff" value="${e.key}" ${e.removed ? "" : "checked"}>
        <img src="${esc(e.effect.img)}" alt=""><span><b>${esc(e.effect.name)}</b><em>${esc(describeChanges(e.effect) || (e.effect.statuses ?? []).join(", ") || e.effect.flags?.[MODULE_ID]?.kind || "")}</em></span></label>`).join("")}
      <p class="aug-rl-muted">Untick an effect to leave it out. To change what an effect does, edit the text.</p></section>` : ""}
    <section><h3><i class="fas fa-scroll" inert></i> Chat reminders${count(c.reminders.filter(editedRem).length + Math.max(0, base.reminders.length - c.reminders.filter(r => r.base).length))}</h3>
      <p class="aug-rl-muted">Rules the module can't roll for are posted as reminders. Change what they say, or make one appear at a moment in play.</p>
      ${c.reminders.map((r, i) => remHTML(r, i, open.has(`r${i}`), c.reminders.length)).join("") || `<p class="aug-rl-muted">No reminders.</p>`}
      <button type="button" data-rl="add-rem"><i class="fas fa-plus" inert></i> Add a reminder</button>
    </section>
  </div>`;
}

/* -------------------------------------------- */
/*  Reading the form                            */
/* -------------------------------------------- */

function readMoment(el) {
  if (!el || el.querySelector('[name="m-mode"]').value !== "moment") return null;
  const kinds = [...el.querySelectorAll('[name="m-kind"]:checked')].map(c => c.value);
  if (!kinds.length) return null;
  const v = n => el.querySelector(`[name="${n}"]`);
  const condType = v("m-cond").value;
  const cond = !condType ? null
    : condType === "keep" ? JSON.parse(el.dataset.cond || "null")
    : condType === "movedAtLeast" || condType === "movedAtMost" ? { type: condType, n: Number(v("m-condn").value) || 0 }
    : condType === "ask" ? { type: "ask", text: v("m-condt").value.trim() || "Only if it applies." }
    : { type: condType };
  const who = whoFor({ kinds, who: v("m-who").value });
  const crit = cond?.type === "crit" && !kinds.includes("attackHit") ? { type: "ask", text: "Only on a critical hit." } : null;
  return {
    kinds, who, side: v("m-side").value, range: who === "self" ? null : Number(v("m-range").value) || null,
    outcome: v("m-outcome").value, often: v("m-often").value, cond: crit ?? cond
  };
}

function readAct(fs) {
  const v = n => fs.querySelector(`[name="${n}"]`);
  const areaType = v("areaType").value;
  const units = v("durUnits").value;
  const moment = readMoment(fs.querySelector("[data-moment]"));
  return {
    spec: {
      name: v("name").value.trim(), activation: v("activation").value, condition: v("condition").value.trim(),
      roll: v("roll").value, ability: v("ability").value, half: v("half").checked,
      damage: v("damage").value.trim(), heal: v("heal").value.trim(), extra: v("extra").value.trim(), extraName: v("extraName").value.trim(),
      area: areaType ? { type: areaType, size: Number(v("areaSize").value) || 5 } : null,
      concentration: v("concentration").checked,
      duration: units ? { value: String(v("durValue").value || "1"), units } : null,
      consume: v("consume").checked,
      triggers: moment?.kinds ?? [], once: !!moment && moment.often !== "always", moment
    },
    removed: v("keep") ? !v("keep").checked : false
  };
}

/** Everything in the form, as hand edits: only what differs from what the text says is kept. */
export function collectRules(panel, base) {
  const out = {};
  const acts = {}, added = [];
  panel.querySelectorAll(".aug-rl-card.act").forEach(fs => {
    const key = fs.dataset.key;
    const { spec, removed } = readAct(fs);
    if (key.startsWith("n")) { added.push(spec); return; }
    const i = Number(key.slice(1));
    if (removed) acts[key] = { removed: true };
    else if (!sameSpec(spec, base.specs[i])) acts[key] = { spec };
  });
  if (Object.keys(acts).length) out.activities = acts;
  if (added.length) out.added = added;

  const on = panel.querySelector('[name="usesOn"]')?.value === "on";
  const uses = on ? { max: panel.querySelector('[name="usesMax"]').value.trim() || "PB", period: panel.querySelector('[name="usesPeriod"]').value } : null;
  if (!same(uses, base.uses)) out.uses = uses ?? { none: true };

  const effs = {};
  panel.querySelectorAll('[name="eff"]').forEach(c => { if (!c.checked) effs[c.value] = { removed: true }; });
  if (Object.keys(effs).length) out.effects = effs;

  const rems = [...panel.querySelectorAll(".aug-rl-card.rem")].map(el => {
    const text = el.querySelector('[name="text"]').value.trim();
    const tags = [...el.querySelectorAll('[name="tag"]:checked')].map(c => c.value);
    const moment = readMoment(el.querySelector("[data-moment]"));
    const b = base.reminders.find(x => x.text === text);
    const r = { tags: sameSet(tags, b?.tags) ? [...b.tags] : tags.length ? tags : ["Rule"], text };
    if (!b || !sameMoment(moment, b.moment)) r.moment = moment;
    if (!b && el.dataset.src) r.src = el.dataset.src;
    return r;
  }).filter(r => r.text);
  const plain = base.reminders.map(r => ({ tags: r.tags, text: r.text }));
  if (!same(rems, plain)) out.reminders = rems;
  return out;
}

/** Reminders as typed, blank ones included (so a just-added card stays on screen). */
export function typedReminders(panel, base) {
  return [...panel.querySelectorAll(".aug-rl-card.rem")].map(el => {
    const text = el.querySelector('[name="text"]').value;
    const b = base.reminders.find(x => x.text === text.trim());
    const moment = readMoment(el.querySelector("[data-moment]"));
    const tags = [...el.querySelectorAll('[name="tag"]:checked')].map(c => c.value);
    const r = { tags: sameSet(tags, b?.tags) ? [...b.tags] : tags, text };
    if (!b || !sameMoment(moment, b.moment)) r.moment = moment;
    if (!b && el.dataset.src) r.src = el.dataset.src;
    return r;
  });
}

/** Show or hide the fields that depend on other choices, and refresh the plain-English lines. */
export function refreshCard(card) {
  const roll = card.querySelector('[name="roll"]')?.value;
  if (roll) card.dataset.roll = roll;
  const areaType = card.querySelector('[name="areaType"]');
  if (areaType) card.querySelector(".f-areasize").hidden = !areaType.value;
  const units = card.querySelector('[name="durUnits"]');
  if (units) card.querySelector('[name="durValue"]').hidden = !units.value;
  card.querySelectorAll("[data-moment]").forEach(m => {
    const on = m.querySelector('[name="m-mode"]').value === "moment";
    m.querySelector(".aug-rl-moment").hidden = !on;
    const kinds = [...m.querySelectorAll('[name="m-kind"]:checked')].map(c => c.value);
    const area = kinds.some(k => TRIGGERS[k]?.area);
    const whoSel = m.querySelector('[name="m-who"]');
    const forced = whoFor({ kinds, who: whoSel.value });
    if (forced !== whoSel.value) whoSel.value = forced;
    const who = whoSel.value;
    const cond = m.querySelector('[name="m-cond"]').value;
    m.querySelector(".m-areanote").hidden = !area;
    m.querySelector(".m-critnote").hidden = !(cond === "crit" && !kinds.includes("attackHit"));
    m.querySelector(".m-who").hidden = area;
    m.querySelector(".m-range").hidden = area || who === "self";
    m.querySelector(".m-side").hidden = !area;
    m.querySelector(".m-outcome").hidden = !kinds.some(k => k === "saveRoll" || k === "checkRoll");
    m.querySelector(".m-condn").hidden = cond !== "movedAtLeast" && cond !== "movedAtMost";
    m.querySelector(".m-condt").hidden = cond !== "ask";
    const moment = readMoment(m);
    m.querySelector(".aug-rl-reads span").textContent = describeMoment(moment) || "Tick a moment above.";
    const line = card.querySelector(".aug-rl-when-line");
    if (line) line.textContent = moment ? describeMoment(moment) : card.classList.contains("rem") ? "On the augment's card when used" : (WHEN[card.querySelector('[name="activation"]')?.value] ?? "");
  });
  const keep = card.querySelector('[name="keep"]');
  if (keep) card.classList.toggle("removed", !keep.checked);
  const nameEl = card.querySelector('.act [name="name"], [name="name"]');
  if (card.classList.contains("act") && nameEl && !card.dataset.tracker) card.querySelector("summary b").textContent = nameEl.value.trim() || "Roll";
}

/* -------------------------------------------- */
/*  Writing text from the rules                 */
/* -------------------------------------------- */

const ARTICLE = w => (/^[aeiou]/i.test(w) ? "an" : "a");
const areaWords = a => (a?.type ? `each creature in ${ARTICLE(String(a.size))} ${a.size}-foot ${a.type === "radius" ? "radius" : a.type}` : "one creature you can see");
const dmgWords = d => String(d ?? "").split(/;\s*/).map(x => x.trim()).filter(Boolean).map(x => `${x} damage`).join(" plus ");

function sentenceFor(s) {
  const lead = s.moment?.kinds?.length ? `${describeMoment(s.moment)}, ` : { action: "As an action, ", bonus: "As a bonus action, ", reaction: "As a reaction, " }[s.activation] ?? (s.condition ? `${cap(s.condition)}, ` : "");
  const who = areaWords(s.area);
  let body = "";
  if (s.roll === "save") {
    body = s.damage
      ? `${who} must make a ${ABILITIES[s.ability] ?? s.ability} saving throw, taking ${dmgWords(s.damage)} on a failed save${s.half ? ", or half as much damage on a successful one" : ""}.`
      : `${who} must succeed on a ${ABILITIES[s.ability] ?? s.ability} saving throw.`;
  } else if (s.roll === "melee" || s.roll === "ranged") {
    body = `make a ${s.roll} attack against ${who === "one creature you can see" ? "one creature" : who}.${s.damage ? ` On a hit, it takes ${dmgWords(s.damage)}.` : ""}`;
  } else if (s.roll === "damage") body = s.damage ? `${who} takes ${dmgWords(s.damage)}.` : "";
  else if (s.roll === "heal") body = `you regain ${s.heal || "1d8"} hit points.`;
  else if (s.roll === "temphp") body = `you gain ${s.heal || "1d8"} temporary hit points.`;
  else if (s.extra) body = `roll ${s.extra}${s.extraName ? ` (${s.extraName.toLowerCase()})` : ""}.`;
  if (!body) return "";
  const text = lead ? `${lead}${body}` : cap(body);
  const dur = s.duration?.units ? ` It lasts ${s.duration.value} ${s.duration.units}${Number(s.duration.value) === 1 ? "" : "s"}${s.concentration ? " (concentration)" : ""}.` : "";
  return cap(text) + dur;
}

const USES_CLAUSE = /(^|[.!?;:]\s*|\n)([^.!?;\n]*\b(?:once|twice|thrice|\d+ times|a number of times|PB|uses?)\b[^.!?;\n]*\b(?:short|long) rest\b[^.!?;\n]*?)(\*{0,2}[.!?]?)(?=\s|$)/i;
const lowerFirst = t => (/^[A-Z][a-z]/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t);
const withMoment = (text, m) => {
  if (!m?.kinds?.length || /^(?:when|whenever|at the|after|if|while|each time|once)\b/i.test(text)) return text;
  return `${describeMoment(m)}, ${lowerFirst(text)}`;
};
const LEADS = { action: /^\**As an action\b/i, bonus: /^\**As a bonus action\b/i, reaction: /^\**As a reaction\b/i };

/** Find `needle` in markdown text, ignoring ** bold markers and spacing. Returns [start, end] or null. */
function findLoose(hay, needle) {
  const n = String(needle ?? "").replace(/\*\*/g, "").trim();
  if (!n) return null;
  const B = "(?:\\*{1,2})?";
  const body = [...n].map(ch => (/\s/.test(ch) ? "\\s+" : ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + B)).join("").replace(/(?:\\s\+)+/g, "\\s+" + B);
  const m = new RegExp(B + body).exec(hay);
  return m ? [m.index, m.index + m[0].length] : null;
}
const sentencesOf = text => String(text ?? "").split(/(?<=[.!?](?:\*\*)?)\s+|\n+/).filter(x => x.trim());

/**
 * The text rewritten to say what the rules do: sentences for reminders you changed or removed are
 * swapped or dropped where they're found, changed rolls and uses rewrite their sentence (or are added
 * at the end), and new rules are added at the end. Everything else stays as it was.
 */
export function textFromRules(base, ov, text = "") {
  const c = current(base, ov);
  let out = String(text ?? "");
  const tail = [];
  const swap = (from, to) => {
    const at = findLoose(out, from);
    if (!at) return false;
    out = out.slice(0, at[0]) + to + out.slice(at[1]);
    return true;
  };
  // Rolls: a changed roll rewrites the sentence it came from; new rolls are added.
  for (const a of c.acts) {
    if (a.tracker || a.removed || !editedAct(a)) continue;
    const t = sentenceFor(a.spec);
    if (!t) continue;
    const note = String(a.base?.condition ?? "").replace(/\.\.\.$/, "").trim();
    const plain = x => x.replace(/\*\*/g, "");
    const from = a.base && (sentencesOf(out).find(x => note && plain(x).includes(note))
      ?? sentencesOf(out).find(x => LEADS[a.base.activation]?.test(x)));
    if (!(from && swap(from, t))) tail.push(t);
  }
  // Reminders: rewritten, given a moment, removed, added.
  const kept = new Set();
  for (const r of c.reminders) {
    const t = String(r.text ?? "").trim();
    if (!t) continue;
    const src = r.src ?? null;
    if (src) kept.add(src);
    const momentChanged = r.base ? !sameMoment(r.moment, r.base.moment) : !!r.moment?.kinds?.length;
    const next = momentChanged ? withMoment(t, r.moment) : t;
    if (src && next === src) continue;
    if (!(src && swap(src, next))) tail.push(next);
  }
  for (const b of base.reminders) if (!kept.has(b.text)) swap(b.text, "");
  // Uses.
  if (!same(c.uses, base.uses)) {
    const usesText = c.uses ? `You can use this ${c.uses.max === "1" ? "once" : c.uses.max === "2" ? "twice" : /^PB$/i.test(c.uses.max) ? "a number of times equal to your Proficiency Bonus" : `${c.uses.max} times`}, regaining all uses when you finish a ${c.uses.period === "sr" ? "Short or Long Rest" : "Long Rest"}.` : "";
    const m = USES_CLAUSE.exec(out);
    if (m) {
      const lead = m[1];
      const words = /;\s*$/.test(lead) ? lowerFirst(usesText).replace(/\.$/, "") + (m[3].replace(/\*/g, "") || "") : usesText;
      out = out.slice(0, m.index) + lead + words + out.slice(m.index + m[0].length);
    } else if (usesText) tail.push(usesText);
  }
  out = out.replace(/\*\*\s*\*\*/g, "").replace(/[ \t]{2,}/g, " ").replace(/ +([.,;])/g, "$1").replace(/;\s*\./g, ".").replace(/\n{3,}/g, "\n\n").trim();
  return [out, ...tail].filter(Boolean).join(" ").trim();
}

/** What a set of rules builds, for comparing (labels only, no wording). */
export function buildLines(result) {
  return (result?.summary ?? []).filter(s => !/^\d+ reminders? in chat$|^Edited by hand$/.test(s)).map(s => s.toLowerCase()).sort();
}
export function withRules(item, text, ov) {
  const seed = item.id ?? item.name;
  const r = analyzeEffect(text, { name: item.name, img: item.img, seed });
  if (ov && Object.keys(ov).length) applyOverride(r, ov, { name: item.name, seed });
  return r;
}

/**
 * Saved rule changes as this editor would save them. Edits made in the audit window (or before
 * moments existed) don't spell out when each roll and reminder happens; this fills that in from
 * what the module actually builds, so opening and closing the editor changes nothing, and what
 * the editor shows is what runs.
 */
export function canonicalRules(item, text, ov) {
  if (!ov || !Object.keys(ov).length) return {};
  const base = rulesBase(item, text);
  const show = clone(ov);
  try {
    const built = withRules(item, text, ov);
    const own = id => built.triggers.find(t => t.activity === id && !t.remind && !t.areaInfo) ?? null;
    // Built activities come in order: the reader's (minus removed), then the added ones.
    const kept = base.specs.map((s, i) => `a${i}`).filter(k => !ov.activities?.[k]?.removed);
    kept.forEach((k, j) => {
      const o = show.activities?.[k];
      if (o?.spec && o.spec.moment === undefined) o.spec.moment = momentOf(own(built.activities[j]?._id));
    });
    (show.added ?? []).forEach((spec, i) => {
      if (spec.moment === undefined) spec.moment = momentOf(own(built.activities[kept.length + i]?._id));
    });
    if (Array.isArray(show.reminders)) for (const r of show.reminders) {
      if (r.moment !== undefined || base.reminders.some(b => b.text === r.text)) continue;
      r.moment = momentOf(built.triggers.find(t => t.remind && t.text === String(r.text ?? "").trim()));
    }
  } catch (err) { /* leave them as they are */ }
  if (typeof document === "undefined") return show;
  const div = document.createElement("div");
  div.innerHTML = rulesHTML(base, show);
  return collectRules(div.firstElementChild, base);
}
