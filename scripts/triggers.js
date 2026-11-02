import { MODULE_ID, isAugment, equippedBy, rarityColor, boldMarkdown, change, getEffectText, getRarity, registerSocketHandler, SOCKET, escapeHTML as esc } from "./core.js";
import { TRIGGERS } from "./automation.js";
import { getStack, setStackValue } from "./stacks.js";
import { effectHTML, bindEffectRows, applyEffectToActor } from "./chat.js";

/**
 * Trigger runtime. The reader tags each roll with the moments that should fire it
 * (flags.augments.auto.triggers). This file watches the game for those moments and either
 * posts a prompt card with a one-click Roll button or, in "auto" mode, rolls straight away.
 *
 * Document changes (HP, turns, token movement, combatants) are seen by every client, so only the
 * active GM acts on them. Rolls (saves, damage, Hit Dice, spells) only fire hooks on the roller's
 * client, so those are handled where they happen.
 */

const mode = () => { try { return game.settings.get(MODULE_ID, "triggerMode"); } catch (e) { return "prompt"; } };
/** Console notes on what triggered and why something didn't prompt (setting: Log augment triggers). */
function dbg(...args) {
  try { if (game.settings.get(MODULE_ID, "triggerDebug")) console.log(`${MODULE_ID} | trigger:`, ...args); } catch (e) { /* setting not registered */ }
}
const isActiveGM = () => game.user === game.users.activeGM;
const HEAL_TYPES = new Set(["healing", "temphp"]);

/* -------------------------------------------- */
/*  Who has triggers                            */
/* -------------------------------------------- */

function candidateActors() {
  const out = new Set();
  for (const a of game.actors ?? []) if (a.type === "character" || a.hasPlayerOwner) out.add(a);
  for (const t of canvas?.scene?.tokens ?? []) if (t.actor && !t.actorLink) out.add(t.actor);
  return out;
}

/** Every equipped augment roll listening for one of `kinds`: [{ actor, item, activity, trig, kind }]. */
function listeners(kinds) {
  const want = new Set(kinds);
  const out = [];
  for (const actor of candidateActors()) {
    for (const item of actor.items) {
      const trigs = item.flags?.[MODULE_ID]?.auto?.triggers;
      if (!trigs?.length || !isAugment(item) || equippedBy(item) !== actor) continue;
      for (const trig of trigs) {
        const kind = trig.kinds.find(k => want.has(k));
        if (!kind) continue;
        const activity = trig.activity ? item.system?.activities?.get?.(trig.activity) : null;
        // Rules with nothing to roll still get a card with their text (activity: null).
        if (activity || !trig.activity) out.push({ actor, item, activity, trig, kind });
      }
    }
  }
  return out;
}

/* -------------------------------------------- */
/*  Geometry                                    */
/* -------------------------------------------- */

function tokenOf(actor) {
  return actor?.token?.object ?? actor?.getActiveTokens?.()?.[0] ?? null;
}

function centerOf(token) {
  // Use the document: during a move the token object is still animating from its old spot.
  const doc = token?.document ?? token;
  const size = canvas.grid.size;
  if (doc && Number.isFinite(doc.x) && Number.isFinite(doc.width)) {
    return { x: doc.x + (doc.width * size) / 2, y: doc.y + (doc.height * size) / 2 };
  }
  return (token?.object ?? token)?.center ?? { x: 0, y: 0 };
}

function measure(pa, pb) {
  try {
    const r = canvas.grid.measurePath?.([pa, pb]);
    if (r?.distance != null) return r.distance;
  } catch (e) { /* fall through */ }
  try { return canvas.grid.measureDistance(pa, pb, { gridSpaces: true }); } catch (e) { return 0; }
}

function distance(a, b) {
  if (!a || !b) return Infinity;
  const pa = centerOf(a), pb = centerOf(b);
  try {
    const r = canvas.grid.measurePath?.([pa, pb]);
    if (r?.distance != null) return r.distance;
  } catch (e) { /* fall through */ }
  try { return canvas.grid.measureDistance(pa, pb, { gridSpaces: true }); } catch (e) { return Infinity; }
}

function disposition(token) {
  return (token?.document ?? token)?.disposition ?? 0;
}

/**
 * Does this event (on `subject`) count for this listener?
 * self: the owner's own event. ally: a friendly creature in range. enemy: a hostile creature in range.
 */
function relates(l, subject) {
  const { trig, actor } = l;
  if (!subject) return false;
  if (subject === actor || subject.uuid === actor.uuid) return trig.self !== false;
  if (trig.who === "self") return false;
  const mine = tokenOf(actor), theirs = tokenOf(subject);
  if (!mine || !theirs) {
    dbg(`${l.item.name}: needs ${mine ? subject.name : actor.name} to have a token on this scene to measure range.`);
    return false;
  }
  if (trig.range && distance(mine, theirs) > trig.range + 0.1) {
    dbg(`${l.item.name}: ${subject.name} is ${Math.round(distance(mine, theirs))} ft away (needs ${trig.range} ft).`);
    return false;
  }
  if (trig.who === "ally") return disposition(mine) === disposition(theirs) || (subject.hasPlayerOwner && actor.hasPlayerOwner);
  if (trig.who === "enemy") return relatesEnemy(l, subject);
  return false;
}

/* Areas: dnd5e templates (and v14 Regions) tagged with the activity that placed them. */

function areaDocs() {
  const scene = canvas?.scene;
  if (!scene) return [];
  const docs = [...(scene.templates ?? []), ...(scene.regions ?? [])];
  return docs.map(doc => ({ doc, origin: areaOrigin(doc) })).filter(a => a.origin);
}

function areaOrigin(doc) {
  const mine = doc.flags?.[MODULE_ID]?.area;
  if (mine?.itemUuid) return mine;
  const d = doc.flags?.dnd5e ?? {};
  const ref = d.origin ?? d.activity ?? d.item;
  if (!ref) return null;
  let src = null;
  try { src = fromUuidSync(ref); } catch (e) { return null; }
  const item = src?.documentName === "Item" ? src : src?.item;
  if (!item || !isAugment(item)) return null;
  return { itemUuid: item.uuid, activityId: src?.documentName === "Item" ? null : src?.id };
}

function inArea(doc, token) {
  const tdoc = token?.document ?? token;
  if (doc.documentName === "Region") {
    const p = centerOf(token);
    try {
      const hit = doc.testPoint?.({ ...p, elevation: tdoc.elevation ?? 0 }) ?? doc.object?.testPoint?.(p, tdoc.elevation ?? 0);
      if (hit !== undefined) return !!hit;
    } catch (e) { /* fall back to the region's own token list */ }
    return !!doc.tokens?.has?.(tdoc);
  }
  const shape = doc.object?.shape;
  if (!shape) return false;
  const p = centerOf(token);
  return !!shape.contains(p.x - doc.x, p.y - doc.y);
}

/** Is this creature on the side an area rule is for ("Allies starting...", "An enemy ending...")? */
function sideOk(l, token) {
  const side = l.trig.side ?? (l.trig.hostile ? "enemy" : "any");
  if (side === "any") return true;
  const owner = tokenOf(l.actor);
  const ownerDisp = owner ? disposition(owner) : 1; // no token on the map: assume a friendly character
  const same = disposition(token) === ownerDisp;
  return side === "ally" ? same : !same;
}

function areasHolding(token) {
  return areaDocs().filter(a => inArea(a.doc, token));
}

/* -------------------------------------------- */
/*  Firing                                      */
/* -------------------------------------------- */

const fired = new Map();
const recent = new Map();
function roundStamp() {
  const c = game.combat;
  return c?.started ? `${c.id}.${c.round}` : `t${Math.floor(Date.now() / 6000)}`;
}
function turnStamp() {
  const c = game.combat;
  return c?.started ? `${c.id}.${c.round}.${c.turn}` : `t${Math.floor(Date.now() / 6000)}`;
}

/* What each token has done this turn, for "if you moved at least 20 feet", "if you dealt no damage". */
const turnStats = new Map(); // token id -> { moved, dealt, since }
function statsFor(tokenId) {
  let st = turnStats.get(tokenId);
  if (!st) turnStats.set(tokenId, (st = { moved: 0, dealt: false, since: null }));
  return st;
}
function tokenIdOf(actor) {
  const t = tokenOf(actor);
  return (t?.document ?? t)?.id ?? null;
}

/** Check a rule's condition. ok: true (met), false (not met: don't prompt), null (can't tell: ask). */
function checkCondition(cond, actor, { item = null, stamp = turnStamp() } = {}) {
  if (!cond) return { ok: true, note: "" };
  const tid = tokenIdOf(actor);
  const st = tid ? turnStats.get(tid) : null;
  const tracked = !!(st && st.since && game.combat?.started && st.since === `${game.combat.id}.${game.combat.round}`);
  if (cond.type === "movedAtLeast" || cond.type === "movedAtMost") {
    if (!tracked) return { ok: null, note: `Only if you moved ${cond.type === "movedAtLeast" ? "at least" : "no more than"} ${cond.n} feet this turn (not tracked: no token in combat).` };
    const ok = cond.type === "movedAtLeast" ? st.moved >= cond.n : st.moved <= cond.n;
    return { ok, note: `You moved ${Math.round(st.moved)} ft this turn.` };
  }
  if (cond.type === "noDamage") {
    if (!tracked) return { ok: null, note: "Only if you dealt no damage this turn." };
    return { ok: !st.dealt, note: "You dealt no damage this turn." };
  }
  if (cond.type === "belowHalf") {
    const hp = hpOf(actor);
    if (!hp?.max) return { ok: null, note: "Only while below half your hit points." };
    return { ok: hp.value < hp.max / 2, note: `You're at ${hp.value} / ${hp.max} HP.` };
  }
  if (cond.type === "dealtDamage") {
    if (!tracked) return { ok: null, note: "Only if you damaged an enemy this turn." };
    return { ok: !!st.dealt, note: "You dealt damage this turn." };
  }
  if (cond.type === "usedThisTurn") {
    const used = item?.flags?.[MODULE_ID]?.usedTurn?.[cond.activity];
    if (used === stamp) return { ok: true, note: `You used ${cond.label ?? "the bonus"} this turn.` };
    return { ok: false, note: "" };
  }
  if (cond.type === "crit") return { ok: true, note: "Critical hit." }; // only fired for crits (onAttack)
  if (cond.type === "ask") {
    // "if you took Help, Dodge, Study..." : turns without attacks, so damage dealt means no.
    if (cond.quiet && tracked && st.dealt) return { ok: false, note: "" };
    return { ok: null, note: cond.quiet && tracked ? `${cond.text} (You dealt no damage, so you may have.)` : cond.text, ask: true };
  }
  return { ok: true, note: "" };
}

/** Is the state this rule needs ("Unstarved") on its owner right now? */
function stateOn(actor, name) {
  return !name || actor.effects.some(e => e.name === name && !e.disabled && !e.isSuppressed);
}

/** One trigger has happened. reason: short sentence. targets: tokens the roll should aim at. */
async function fire(l, { reason, targets = [], stamp = turnStamp(), note = "", damageType = null } = {}) {
  const { item, activity, trig, actor } = l;
  if (!stateOn(actor, trig.requires)) return dbg(`${item.name}: skipped, ${trig.requires} isn't active.`);
  const targetIds = targets.map(t => (t.document ?? t).uuid).filter(Boolean);
  // Area rolls are once per creature; everything else once per augment.
  const key = `${item.uuid}.${activity?.id ?? trig.kinds.join("+")}.${targetIds.join("+")}`;
  // The same moment can reach us through two hooks (a skill check is also an ability check).
  const recentKey = `${key}.${l.kind}`;
  const last = recent.get(recentKey);
  if (last && Date.now() - last < 1500) return dbg(`${item.name}: skipped, already prompted for this a moment ago.`);
  // Conditions the module can check: skip quietly when they aren't met (before anything is recorded).
  const check = checkCondition(trig.cond, actor, { item, stamp });
  if (check.ok === false) return dbg(`${item.name}: skipped, condition not met (${trig.cond?.type}).`, check.note);
  if (note) check.note = check.note ? `${note} ${check.note}` : note;
  recent.set(recentKey, Date.now());
  if (trig.once) {
    const s = trig.onceScope === "round" ? roundStamp() : turnStamp();
    if (fired.get(key) === s) return dbg(`${item.name}: skipped, already used its once-per-${trig.onceScope ?? "turn"}.`);
    fired.set(key, s);
  }
  const uses = item.system?.uses;
  const left = uses?.max ? Number(uses.value ?? (uses.max - (uses.spent ?? 0))) : null;
  const spends = !!activity?.consumption?.targets?.length;
  if (left === 0 && spends) return dbg(`${item.name}: skipped, no uses left.`); // nothing left to spend, so don't nag

  const simple = activity && !trig.action && check.ok === true && !trig.areaInfo;
  dbg(`${item.name}: prompting (${l.kind}).`, reason);
  if (mode() === "auto" && simple && item.isOwner) return useNow(item, activity, targetIds);
  return queuePrompt(l, reason, targetIds, check, { damageType });
}

function ownersOf(actor) {
  const players = game.users.filter(u => !u.isGM && u.active && actor.testUserPermission(u, "OWNER"));
  const gms = game.users.filter(u => u.isGM);
  return [...new Set([...players, ...gms])].map(u => u.id);
}

/** "Bishop's Burning Core: End of turn damage" -> "End of turn damage" (the card header has the name). */
function shortName(item, activity) {
  const n = String(activity.name || item.name);
  const short = n.startsWith(`${item.name}: `) ? n.slice(item.name.length + 2) : n;
  if (short !== item.name) return short;
  // Named after the augment itself: say what the button does instead.
  if (activity.type === "heal") return [...(activity.healing?.types ?? [])][0] === "temphp" ? "Temporary HP" : "Healing";
  return { damage: "Damage", save: "Saving throw", attack: "Attack" }[activity.type] ?? (activity.roll?.name || "Use");
}

/** A compact dice summary for the button: "2d8 fire", "DEX save", "1d8 + PB healing". */
function dice(activity) {
  const fmt = f => String(f ?? "").replace(/@attributes\.prof|@prof/g, "PB").replace(/@abilities\.(\w+)\.mod/g, (_, a) => a.toUpperCase()).replace(/@attributes\.spell\.mod/g, "spell mod");
  const parts = (activity.damage?.parts ?? []).map(p => {
    const types = [...(p.types ?? [])];
    const f = p.custom?.enabled ? fmt(p.custom.formula) : p.number ? `${p.number}d${p.denomination}${p.bonus ? ` + ${fmt(p.bonus)}` : ""}` : "";
    return [f, types[0]].filter(Boolean).join(" ");
  }).filter(Boolean);
  if (activity.type === "save") {
    const ab = [...(activity.save?.ability ?? [])][0];
    return [ab ? `${ab.toUpperCase()} save` : "Save", ...parts].join(", ");
  }
  if (activity.type === "heal") {
    const h = activity.healing;
    const f = h?.custom?.enabled ? fmt(h.custom.formula) : h?.number ? `${h.number}d${h.denomination}` : "";
    return f ? `${f} ${[...(h.types ?? [])][0] === "temphp" ? "temp HP" : "healing"}` : "";
  }
  if (activity.roll?.formula) return fmt(activity.roll.formula);
  return parts.join(", ");
}

/** Does this activity roll anything, or is it a plain "use it"? */
function rolls(activity) {
  return !!activity && (["save", "attack", "damage", "heal"].includes(activity.type) || !!activity.roll?.formula);
}

function usesLeft(item) {
  const uses = item.system?.uses;
  if (!uses?.max) return null;
  return { left: Number(uses.value ?? (uses.max - (uses.spent ?? 0))), max: Number(uses.max) };
}

/** How many feet a movement bank can take now: unused movement, the per-turn cap and the room left. */
function bankPreview(item, actor) {
  const stack = getStack(item);
  const per = Number(stack?.bankPer) || 0;
  const room = stack?.max ? Math.max(0, stack.max - stack.value) : Infinity;
  const speed = Number(actor.system?.attributes?.movement?.walk) || 0;
  const tid = tokenIdOf(actor);
  const st = tid ? turnStats.get(tid) : null;
  const tracked = !!(st?.since && game.combat?.started);
  const unused = tracked ? Math.max(0, speed - st.moved) : null;
  const raw = Math.min(per || Infinity, room, unused ?? Infinity);
  const amount = Number.isFinite(raw) ? Math.floor(raw / 5) * 5 : 0;
  const parts = [];
  if (tracked) parts.push(`moved ${Math.round(st.moved)} of ${speed} ft, ${unused} unused`);
  if (stack) parts.push(`${stack.value}${stack.max ? ` / ${stack.max}` : ""} ft stored`);
  return { amount, note: parts.join(" · ") };
}

function buttonHTML(item, actor, activity, trig, extra = {}) {
  let html = mainButtonHTML(item, actor, activity, trig, extra);
  const b = (action, icon, label, note = "", attrs = "") =>
    `<button type="button" data-aug-trigger="${action}" data-activity-id="${esc(activity?.id ?? "")}" ${attrs}><i class="fas ${icon}" inert></i><span class="aug-trig-label">${esc(label)}</span>${note ? `<span class="aug-trig-dice">${esc(note)}</span>` : ""}</button>`;
  if (trig.restoreHd) html += b("restoreHd", "fa-dice-d6", "Restore a Hit Die");
  // "restore one expended use of a Simple or Average augment": one button per augment that has spent uses.
  if (trig.restoreUse?.length) {
    for (const other of actor.items) {
      if (other === item || !isAugment(other) || equippedBy(other) !== actor) continue;
      const u = usesLeft(other);
      if (!u || u.left >= u.max || !trig.restoreUse.includes(getRarity(other))) continue;
      html += b("restoreUse", "fa-rotate-left", `Restore a use: ${other.name}`, `${u.left} / ${u.max}`, `data-target-item="${esc(other.uuid)}"`);
    }
  }
  return html;
}

function mainButtonHTML(item, actor, activity, trig, extra = {}) {
  const sameType = trig.sameType && extra.damageType && activity?.type === "damage" ? extra.damageType : "";
  const b = (action, icon, label, note = "", attrs = "") =>
    `<button type="button" data-aug-trigger="${action}" data-activity-id="${esc(activity?.id ?? "")}" ${sameType ? `data-type="${esc(sameType)}"` : ""} ${attrs}><i class="fas ${icon}" inert></i><span class="aug-trig-label">${esc(label)}</span>${note ? `<span class="aug-trig-dice">${esc(note)}</span>` : ""}</button>`;
  const u = usesLeft(item);
  const usesNote = u && activity?.consumption?.targets?.length ? `${u.left} / ${u.max} left` : "";
  if (trig.action === "hitDie") {
    const hd = actor.system?.attributes?.hd;
    const den = hd?.largestAvailable ?? "";
    return b("hitDie", "fa-heart-pulse", "Spend a Hit Die", [den, usesNote].filter(Boolean).join(" · "));
  }
  if (trig.action === "bankMovement") {
    const p = bankPreview(item, actor);
    return b("bank", "fa-person-running", p.amount ? `Bank ${p.amount} ft` : "Nothing to bank", "", `data-amount="${p.amount}" ${p.amount ? "" : "disabled"}`)
      + (p.note ? `<div class="aug-trig-note">${esc(p.note)}</div>` : "");
  }
  if (trig.action === "bankRoll") {
    const st = getStack(item);
    const banked = st?.value ? `${st.value} already banked` : "";
    return b("bankRoll", "fa-piggy-bank", `Bank ${st?.formula ?? "it"}${st?.name ? ` ${st.name}` : ""}`, [banked, usesNote].filter(Boolean).join(" · "));
  }
  if (trig.action === "gainStack") {
    const st = getStack(item);
    return b("stack", "fa-layer-group", `Gain 1 ${st?.name ?? "stack"}`, st ? `${st.value}${st.max ? ` / ${st.max}` : ""}` : "");
  }
  if (!activity) return "";
  if (rolls(activity)) {
    const d = sameType ? dice(activity).replace(/\s*$/, ` ${sameType}`) : dice(activity);
    return b("use", "fa-dice-d20", shortName(item, activity), [d, usesNote].filter(Boolean).join(" · "), `data-tooltip="${esc(activity.name)}"`);
  }
  return b("use", "fa-hand-pointer", "Use", usesNote, `data-tooltip="${esc(activity.name)}"`);
}

/* Several rolls answering the same moment ("heal 2d8 or temp HP 2d8") share one card. */
const promptQueue = new Map();
function queuePrompt(l, reason, targetIds, check, extra) {
  const key = `${l.item.uuid}|${l.kind}|${targetIds.join("+")}`;
  let group = promptQueue.get(key);
  if (!group) {
    group = { reason, targetIds, entries: [] };
    promptQueue.set(key, group);
    setTimeout(() => { promptQueue.delete(key); postPrompt(group); }, 60);
  }
  group.entries.push({ l, check, extra });
}

async function postPrompt({ reason, targetIds, entries }) {
  const { actor, item, kind } = entries[0].l;
  const Msg = ChatMessage.implementation ?? ChatMessage;
  const label = TRIGGERS[kind]?.label ?? "Triggered";
  const targetLine = targetIds.length
    ? `<div class="aug-trig-targets">${targetIds.map(u => { try { return esc(fromUuidSync(u)?.name ?? ""); } catch (e) { return ""; } }).filter(Boolean).join(", ")}</div>` : "";
  const texts = [...new Set(entries.map(e => e.l.trig.text).filter(Boolean))];
  const conds = [...new Map(entries.filter(e => e.check.note).map(e => [e.check.note, e.check])).values()];
  const condLine = conds.map(c => `<div class="aug-trig-cond ${c.ok === true ? "ok" : "ask"}"><i class="fas ${c.ok === true ? "fa-check" : "fa-circle-question"}" inert></i> ${esc(c.note)}</div>`).join("");
  // Effects for others (e.g. "+1 AC for one ally"): drag onto a token, or apply to your targets.
  const linked = new Set(entries.flatMap(e => (e.l.activity?.effects ?? []).map(x => x._id ?? x.id ?? x)));
  const forOthers = [...(item.effects ?? [])].filter(e => linked.has(e.id) && e.flags?.[MODULE_ID]?.kind === "target");
  const info = entries.every(e => e.l.trig.areaInfo);
  const content = `<div class="aug-trig-card${info ? " info" : ""}" style="--rarity:${esc(rarityColor(item))}" data-item-uuid="${esc(item.uuid)}" data-activity-id="${esc(entries[0].l.activity?.id ?? "")}" data-targets="${esc(targetIds.join(","))}">
      <header><img src="${esc(item.img)}" alt=""><div><strong>${esc(item.name)}</strong><span>${esc(label[0].toUpperCase() + label.slice(1))}</span></div></header>
      ${reason ? `<p class="aug-trig-reason">${esc(reason)}</p>` : ""}
      ${texts.map(t => `<p class="aug-trig-text">${boldMarkdown(t)}</p>`).join("")}
      ${condLine}${targetLine}
      ${forOthers.length ? `<div class="aug-trig-effects">${forOthers.map(effectHTML).join("")}</div>` : ""}
      ${entries.map(e => buttonHTML(item, actor, e.l.activity, e.l.trig, e.extra)).join("")}
    </div>`;
  return Msg.create({
    content,
    speaker: Msg.getSpeaker({ actor }),
    whisper: ownersOf(actor),
    flags: { [MODULE_ID]: { trigger: true, itemUuid: item.uuid } }
  });
}

async function setTargets(uuids) {
  if (!uuids.length || !canvas?.tokens) return;
  const tokens = uuids.map(u => { try { return fromUuidSync(u)?.object; } catch (e) { return null; } }).filter(Boolean);
  try {
    if (canvas.tokens.setTargets) return canvas.tokens.setTargets(tokens.map(t => t.id));
  } catch (e) { /* older API below */ }
  for (const t of game.user.targets) t.setTarget(false, { releaseOthers: false, groupSelection: true });
  tokens.forEach((t, i) => t.setTarget(true, { releaseOthers: i === 0, groupSelection: true }));
}

async function useNow(item, activity, targetIds, { configure = mode() !== "auto" } = {}) {
  await setTargets(targetIds);
  let res = null;
  // Damage, healing and plain rolls: spend the use and roll at once (one click, one result).
  // Saves and attacks keep dnd5e's card, which is where targets roll their saves and attacks resolve.
  const direct = ["damage", "heal"].includes(activity.type) || (activity.type === "utility" && !!activity.roll?.formula);
  try {
    if (direct && typeof activity.rollDamage === "function" || direct && typeof activity.rollFormula === "function") {
      const used = await activity.use({}, { configure: false }, { create: false });
      if (!used) return null; // cancelled, or no uses left
      const rolled = activity.type === "utility"
        ? await activity.rollFormula?.({}, { configure: false })
        : await activity.rollDamage?.({}, { configure: false });
      res = rolled ?? used;
      if (activity.type === "heal" && rolled) await applyHealing(item, activity, [rolled].flat(), targetIds);
    } else {
      res = await activity.use({}, { configure });
    }
  } catch (err) {
    console.error(`${MODULE_ID} | Couldn't roll ${item.name}`, err);
    ui.notifications.error(`Couldn't roll ${activity.name}. See the console (F12).`);
  }
  if (res) {
    await applySelfEffects(item, activity);
    await markUsed(item, activity);
  }
  return res;
}

/** Did the text give this healing to its user ("you regain 1d4", "gain PB temporary hit points")? */
function healsSelf(item, activity) {
  const text = String(getEffectText(item) ?? "").replace(/\*\*/g, "");
  const f = String(activity.healing?.custom?.formula ?? "");
  const die = f.match(/\d+d\d+/)?.[0];
  const sentence = text.split(/(?<=[.;])\s+/).find(x => (die ? x.includes(die) : /\bPB\b/.test(x)) && /\b(?:regain|gain|heal|restore)/i.test(x)) ?? "";
  if (!sentence) return false;
  if (/\b(?:it|ally|allies|creature|target|recipient|each|they|that creature)\s+(?:regains?|gains?)\b|\bto (?:it|an ally|a creature|that creature|each)\b|\bgrant\b/i.test(sentence)) return false;
  return /\byou (?:regain|gain|heal)\b|\b(?:regain|gain|heal) (?:\d+d\d+|PB)/i.test(sentence) || /^(?:[^.]*\b)?(?:regain|gain)\b/i.test(sentence);
}

/** Put a healing or temp HP roll onto who it's for: the card's targets, or its user when the text says so. */
async function applyHealing(item, activity, rolls, targetIds = []) {
  const total = rolls.reduce((n, r) => n + (Number(r?.total) || 0), 0);
  if (!total) return;
  const kind = [...(activity.healing?.types ?? [])][0] === "temphp" ? "temphp" : "healing";
  let actors = targetIds.map(u => { try { return fromUuidSync(u)?.actor; } catch (e) { return null; } }).filter(Boolean);
  if (!actors.length && healsSelf(item, activity) && item.actor) actors = [item.actor];
  if (!actors.length) return;
  for (const a of actors) await healActor(a, total, kind, item);
  const Msg = ChatMessage.implementation ?? ChatMessage;
  await Msg.create({ speaker: Msg.getSpeaker({ actor: item.actor }), whisper: ownersOf(item.actor),
    content: `<p><strong>${esc(item.name)}</strong>: ${total} ${kind === "temphp" ? "temporary hit points" : "healing"} applied to ${actors.map(a => esc(a.name)).join(", ")}.</p>` });
}

async function healActor(actor, amount, kind, item) {
  if (!actor.isOwner) {
    if (!game.users.activeGM) return ui.notifications.warn(`A GM needs to be online to heal ${actor.name}.`);
    game.socket.emit(SOCKET, { action: "augHeal", userId: game.user.id, itemUuid: item.uuid, actorUuid: actor.uuid, amount, kind });
    return;
  }
  const hp = actor.system?.attributes?.hp;
  if (!hp) return;
  if (kind === "temphp") await actor.update({ "system.attributes.hp.temp": Math.max(Number(hp.temp) || 0, amount) });
  else await actor.update({ "system.attributes.hp.value": Math.min(Number(hp.effectiveMax ?? hp.max) || 0, (Number(hp.value) || 0) + amount) });
}

/** "and one of its expended Hit Dice": give one back (largest die first). */
async function restoreHitDie(actor, item) {
  if (!actor.isOwner) {
    if (!game.users.activeGM) return ui.notifications.warn(`A GM needs to be online to restore ${actor.name}'s Hit Die.`);
    game.socket.emit(SOCKET, { action: "augRestoreHd", userId: game.user.id, itemUuid: item.uuid, actorUuid: actor.uuid });
    return true;
  }
  const classes = actor.items.filter(i => i.type === "class" && Number(i.system?.hd?.spent ?? i.system?.hitDiceUsed) > 0)
    .sort((a, b) => Number(String(b.system?.hd?.denomination ?? b.system?.hitDice ?? "d0").slice(1)) - Number(String(a.system?.hd?.denomination ?? a.system?.hitDice ?? "d0").slice(1)));
  const cls = classes[0];
  if (!cls) { ui.notifications.info(`${actor.name} has no spent Hit Dice.`); return false; }
  if (cls.system?.hd?.spent !== undefined) await cls.update({ "system.hd.spent": Number(cls.system.hd.spent) - 1 });
  else await cls.update({ "system.hitDiceUsed": Number(cls.system.hitDiceUsed) - 1 });
  ui.notifications.info(`${actor.name} regains a Hit Die.`);
  return true;
}

/* The GM does it when the player doesn't own the creature. */
registerSocketHandler("augHeal", async msg => {
  if (game.user !== game.users.activeGM) return;
  const user = game.users.get(msg.userId);
  const item = await fromUuid(msg.itemUuid);
  const actor = await fromUuid(msg.actorUuid);
  if (!user || !actor || (!user.isGM && !item?.testUserPermission?.(user, "OWNER"))) return;
  await healActor(actor, Number(msg.amount) || 0, msg.kind, item);
});
registerSocketHandler("augRestoreHd", async msg => {
  if (game.user !== game.users.activeGM) return;
  const user = game.users.get(msg.userId);
  const item = await fromUuid(msg.itemUuid);
  const actor = await fromUuid(msg.actorUuid);
  if (!user || !actor || (!user.isGM && !item?.testUserPermission?.(user, "OWNER"))) return;
  await restoreHitDie(actor, item);
});

/** After an augment's main ability: offer the parts that follow it ("On a hit ... and regain 1d4"). */
function onFollowUps(activity) {
  const item = activity?.item;
  if (!isAugment(item) || !item.isOwner || !["action", "bonus", "reaction"].includes(activity.activation?.type)) return;
  const triggered = new Set((item.flags?.[MODULE_ID]?.auto?.triggers ?? []).map(t => t.activity));
  const extras = (item.system?.activities?.contents ?? []).filter(a => a.id !== activity.id && !triggered.has(a.id)
    && a.activation?.type === "special" && (a.type === "heal" || (a.type === "utility" && a.roll?.formula)));
  if (!extras.length) return;
  const Msg = ChatMessage.implementation ?? ChatMessage;
  const buttons = extras.map(a => `<button type="button" data-aug-trigger="use" data-activity-id="${esc(a.id)}"><i class="fas fa-dice-d20" inert></i><span class="aug-trig-label">${esc(shortName(item, a))}</span><span class="aug-trig-dice">${esc(dice(a))}</span></button>`).join("");
  Msg.create({
    content: `<div class="aug-trig-card" style="--rarity:${esc(rarityColor(item))}" data-item-uuid="${esc(item.uuid)}" data-activity-id="" data-targets="">
      <header><img src="${esc(item.img)}" alt=""><div><strong>${esc(item.name)}</strong><span>Also part of this ability</span></div></header>
      ${extras.map(a => a.activation?.condition ? `<p class="aug-trig-reason">${esc(a.activation.condition)}</p>` : "").join("")}${buttons}</div>`,
    speaker: Msg.getSpeaker({ actor: item.actor }), whisper: ownersOf(item.actor), flags: { [MODULE_ID]: { trigger: true, itemUuid: item.uuid } }
  });
}

/** "+1d6 damage of its type": roll the bonus with the triggering attack's damage type. */
async function rollAsType(item, activity, type) {
  const parts = activity.damage?.parts ?? [];
  const formula = parts.map(p => p.custom?.enabled ? p.custom.formula : `${p.number}d${p.denomination}${p.bonus ? ` + ${p.bonus}` : ""}`).filter(Boolean).join(" + ") || "0";
  const Damage = CONFIG.Dice?.DamageRoll ?? Roll;
  const roll = await new Damage(formula, item.getRollData?.() ?? item.actor?.getRollData?.() ?? {}, { type }).evaluate();
  await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: item.actor }), flavor: `${activity.name} (${type})` });
  const uses = item.system?.uses;
  if (uses?.max && activity.consumption?.targets?.length) await item.update({ "system.uses.spent": (Number(uses.spent) || 0) + 1 });
  await markUsed(item, activity);
  return roll;
}

/** Effects meant for the creature the card is aimed at ("can't regain hit points") go straight onto it. */
async function applyTargetEffects(item, activity, targetUuids) {
  if (!targetUuids?.length) return;
  const linked = new Set((activity?.effects ?? []).map(e => e._id ?? e.id ?? e));
  const effects = [...(item.effects ?? [])].filter(e => linked.has(e.id) && e.flags?.[MODULE_ID]?.kind === "target");
  for (const u of targetUuids) {
    let actor = null;
    try { actor = fromUuidSync(u)?.actor; } catch (e) { /* gone */ }
    if (actor) for (const e of effects) await applyEffectToActor(e.uuid, actor);
  }
}

/* "Gain proficiency in Nature or herbalism kits": ask the owner once the augment is installed. */
const choicePosted = new Set();
async function offerChoices(actor) {
  if (!isActiveGM() || !actor) return;
  for (const item of actor.items) {
    const ch = item.flags?.[MODULE_ID]?.auto?.choice;
    if (!ch?.options?.length || item.flags[MODULE_ID].choiceMade || equippedBy(item) !== actor || choicePosted.has(item.uuid)) continue;
    choicePosted.add(item.uuid);
    const Msg = ChatMessage.implementation ?? ChatMessage;
    const buttons = ch.options.map(o => {
      const current = Number(foundry.utils.getProperty(actor, o.key)) || 0;
      const what = current >= 1 && ch.expertise ? `Expertise in ${o.label}` : `Proficiency in ${o.label}`;
      return `<button type="button" data-aug-trigger="choose" data-key="${esc(o.key)}" data-label="${esc(what)}"><i class="fas fa-graduation-cap" inert></i><span class="aug-trig-label">${esc(what)}</span></button>`;
    }).join("");
    await Msg.create({
      content: `<div class="aug-trig-card" style="--rarity:${esc(rarityColor(item))}" data-item-uuid="${esc(item.uuid)}" data-activity-id="" data-targets="">
        <header><img src="${esc(item.img)}" alt=""><div><strong>${esc(item.name)}</strong><span>Choose a proficiency</span></div></header>
        <p class="aug-trig-text">${boldMarkdown(ch.text)}</p>${buttons}</div>`,
      speaker: Msg.getSpeaker({ actor }), whisper: ownersOf(actor), flags: { [MODULE_ID]: { trigger: true, itemUuid: item.uuid } }
    });
  }
}

async function chooseProficiency(item, key, label) {
  if (!key) return null;
  // Adding 1 gives proficiency, or expertise when the character already has it.
  await item.createEmbeddedDocuments("ActiveEffect", [{
    name: `${item.name}: ${label}`, img: item.img, transfer: true, disabled: !equippedBy(item),
    changes: [change(key, "add", 1)], flags: { [MODULE_ID]: { choice: true } }
  }]);
  await item.update({ [`flags.${MODULE_ID}.choiceMade`]: key }, { [MODULE_ID]: true });
  ui.notifications.info(`${item.name}: ${label}.`);
  return true;
}

async function remindGM(actor, name) {
  const fx = actor.effects.filter(e => (e.flags?.[MODULE_ID]?.applied || e.flags?.[MODULE_ID]?.aura) && !e.disabled);
  if (!fx.length) return;
  const Msg = ChatMessage.implementation ?? ChatMessage;
  const rows = fx.map(e => `<li><strong>${esc(e.name)}</strong>${e.description ? `: ${esc(String(e.description).replace(/<[^>]+>/g, ""))}` : ""}</li>`).join("");
  await Msg.create({
    content: `<div class="aug-trig-card info"><header><div><strong>${esc(name)}</strong><span>Augment effects on it this turn</span></div></header><ul class="aug-trig-list">${rows}</ul></div>`,
    speaker: { alias: "Augments" }, whisper: game.users.filter(u => u.isGM).map(u => u.id)
  });
}

/** Remember that this roll was used this turn, if a later rule asks "if you used it". */
async function markUsed(item, activity) {
  const watched = (item.flags?.[MODULE_ID]?.auto?.triggers ?? []).some(t => t.cond?.type === "usedThisTurn" && t.cond.activity === activity?.id);
  if (watched && item.isOwner) await item.update({ [`flags.${MODULE_ID}.usedTurn.${activity.id}`]: turnStamp() }, { [MODULE_ID]: true }).catch(() => null);
}

/* Banked totals ("bank 2d8 nourishment"): roll it, keep the total, offer it on the next roll it can join. */
async function bankRoll(item, activity) {
  const st = getStack(item);
  if (!st?.formula) return null;
  if (st.value && st.banked === "total") {
    ui.notifications.warn(`${item.name}: you already have ${st.value} ${st.name} banked (one bank at a time).`);
    return null;
  }
  const roll = await new Roll(st.formula).evaluate();
  await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: item.actor }), flavor: `${item.name}: banked ${st.name}` });
  const uses = item.system?.uses;
  const update = { [`flags.${MODULE_ID}.bankedAt`]: game.combat?.started ? `${game.combat.id}.${game.combat.round}` : null };
  if (uses?.max && activity?.consumption?.targets?.length) update["system.uses.spent"] = (Number(uses.spent) || 0) + 1;
  await item.update(update, { [MODULE_ID]: true });
  await setStackValue(item, roll.total);
  return roll;
}

/** Post a banked amount as a healing or damage roll, then empty the bank. */
async function spendBank(item, kind) {
  const st = getStack(item);
  if (!st?.value) return null;
  const Damage = CONFIG.Dice?.DamageRoll ?? Roll;
  const roll = await new Damage(String(st.value), {}, { type: kind === "heal" ? "healing" : undefined }).evaluate();
  await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: item.actor }), flavor: `${item.name}: +${st.value} ${kind === "heal" ? "healing" : "damage"} (${st.name})` });
  await setStackValue(item, 0);
  return roll;
}

function bankedAugments(actor) {
  return actor.items.filter(i => i.flags?.[MODULE_ID]?.auto?.stack?.banked && equippedBy(i) === actor && Number(i.flags[MODULE_ID].stackValue) > 0);
}

/** Card offering a banked amount ("9 nourishment: add to healing / add to damage"). */
async function postBankCard(item, reason, { expired = false } = {}) {
  const st = getStack(item);
  if (!st?.value) return;
  const Msg = ChatMessage.implementation ?? ChatMessage;
  const buttons = expired ? "" : (st.spendOn?.length ? st.spendOn : ["heal", "damage"]).map(k =>
    `<button type="button" data-aug-trigger="spend-${k}"><i class="fas ${k === "heal" ? "fa-heart" : "fa-burst"}" inert></i><span class="aug-trig-label">Add ${st.value} to ${k === "heal" ? "a healing roll" : "a damage roll"}</span></button>`).join("");
  const content = `<div class="aug-trig-card" style="--rarity:${esc(rarityColor(item))}" data-item-uuid="${esc(item.uuid)}" data-activity-id="" data-targets="">
      <header><img src="${esc(item.img)}" alt=""><div><strong>${esc(item.name)}</strong><span>${expired ? "Bank expired" : `${st.value} ${esc(st.name)} banked`}</span></div></header>
      ${reason ? `<p class="aug-trig-reason">${esc(reason)}</p>` : ""}
      ${st.spendText ? `<p class="aug-trig-text">${boldMarkdown(st.spendText)}</p>` : ""}
      ${buttons}
    </div>`;
  if (expired) await setStackValue(item, 0);
  return Msg.create({ content, speaker: Msg.getSpeaker({ actor: item.actor }), whisper: ownersOf(item.actor), flags: { [MODULE_ID]: { trigger: true, itemUuid: item.uuid } } });
}

/** "You gain +1 AC until your next turn": put the activity's own effects on its user. */
async function applySelfEffects(item, activity) {
  const actor = item.actor;
  if (!actor) return;
  const linked = new Set((activity?.effects ?? []).map(e => e._id ?? e.id ?? e));
  for (const e of item.effects ?? []) {
    if (!linked.has(e.id) || e.flags?.[MODULE_ID]?.kind !== "self") continue;
    const already = actor.effects.some(x => x.origin === item.uuid && x.name === e.name && !x.disabled);
    if (!already) await applyEffectToActor(e.uuid, actor);
  }
}

async function spendHitDie(item, activity, text = "") {
  const actor = item.actor;
  const den = actor?.system?.attributes?.hd?.largestAvailable;
  if (actor?.system?.attributes?.hd && !den) { ui.notifications.warn(`${actor.name} has no Hit Dice left.`); return null; }
  if (activity?.consumption?.targets?.length) {
    const used = await activity.use({}, { configure: false }).catch(() => null);
    if (!used) return null;
  }
  const before = hpOf(actor);
  let roll = null;
  try { roll = await actor.rollHitDie({ denomination: den }); } catch (e) {
    try { roll = await actor.rollHitDie(den); } catch (err) { console.error(`${MODULE_ID} | Couldn't roll a Hit Die`, err); }
  }
  const r = Array.isArray(roll) ? roll[0] : roll;
  if (!r) return null;
  // dnd5e normally heals from the Hit Die itself; if it didn't, heal here. Then add any bonus.
  const after = hpOf(actor);
  let heal = 0;
  if (after && before && after.value === before.value) heal += Math.max(0, Number(r.total) || 0);
  const bonusText = String(text).match(/\badd (PB|\d+) to (?:its|that die['’]s|the) healing\b/i)?.[1];
  const bonus = !bonusText ? 0 : /pb/i.test(bonusText) ? Number(actor.system?.attributes?.prof) || 0 : Number(bonusText);
  heal += bonus;
  if (heal > 0 && after) {
    const value = Math.min(after.max, after.value + heal);
    await actor.update({ "system.attributes.hp.value": value });
    const Msg = ChatMessage.implementation ?? ChatMessage;
    await Msg.create({ speaker: Msg.getSpeaker({ actor }), content: `<p><strong>${esc(item.name)}</strong>: ${esc(actor.name)} heals ${heal}${bonus ? ` (including +${bonus})` : ""} from a Hit Die (${after.value} → ${value} HP).</p>` });
  }
  await applySelfEffects(item, activity);
  return r;
}

/** Click handler for prompt cards. */
export function bindTriggerCard(message, html) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  const card = root?.querySelector?.(".aug-trig-card");
  if (!card || card.dataset.bound) return;
  card.dataset.bound = "true";
  const buttons = [...card.querySelectorAll("[data-aug-trigger]")];
  const btn = buttons[0];
  // Cards posted before the short label existed: redraw the button in the current style.
  if (btn && !btn.querySelector(".aug-trig-label")) {
    try {
      const item = fromUuidSync(card.dataset.itemUuid);
      const activity = item?.system?.activities?.get?.(card.dataset.activityId);
      if (activity) {
        const d = dice(activity);
        btn.dataset.tooltip = activity.name;
        btn.innerHTML = `<i class="fas fa-dice-d20" inert></i><span class="aug-trig-label">${esc(shortName(item, activity))}</span>${d ? `<span class="aug-trig-dice">${esc(d)}</span>` : ""}`;
      }
    } catch (e) { /* leave the old button as it is */ }
  }
  bindEffectRows(card);
  for (const btn of buttons) btn.addEventListener("click", async event => {
    event.preventDefault();
    event.stopPropagation();
    const item = await fromUuid(card.dataset.itemUuid);
    if (!item) return ui.notifications.warn("That augment no longer exists.");
    if (!item.isOwner) return ui.notifications.warn(`Only ${item.parent?.name ?? "its owner"} can use this.`);
    const actId = btn.dataset.activityId || card.dataset.activityId;
    const activity = actId ? item.system?.activities?.get?.(actId) : null;
    const what = btn.dataset.augTrigger;
    btn.disabled = true;
    let res = null;
    if (what === "hitDie") res = await spendHitDie(item, activity, card.querySelector(".aug-trig-text")?.textContent ?? "");
    else if (what === "bankRoll") res = await bankRoll(item, activity);
    else if (what === "spend-heal" || what === "spend-damage") {
      res = await spendBank(item, what === "spend-heal" ? "heal" : "damage");
      card.querySelectorAll("[data-aug-trigger]").forEach(x => { x.disabled = true; });
    }
    else if (what === "bank") {
      const st = getStack(item);
      res = st ? await setStackValue(item, st.value + (Number(btn.dataset.amount) || 0)) : null;
      if (res !== null) ui.notifications.info(`${item.name}: ${res} ft stored.`);
    } else if (what === "stack") {
      const st = getStack(item);
      res = st ? await setStackValue(item, st.value + 1) : null;
      if (res !== null) ui.notifications.info(`${item.name}: ${res} ${st.name}.`);
    } else if (what === "restoreHd") {
      const targets = (card.dataset.targets || "").split(",").filter(Boolean).map(u => { try { return fromUuidSync(u)?.actor; } catch (e) { return null; } }).filter(Boolean);
      for (const a of (targets.length ? targets : [item.actor])) res = await restoreHitDie(a, item);
    } else if (what === "restoreUse") {
      const other = await fromUuid(btn.dataset.targetItem);
      const spent = Number(other?.system?.uses?.spent) || 0;
      if (other && spent > 0) { await other.update({ "system.uses.spent": spent - 1 }); res = true; ui.notifications.info(`${other.name} regains a use.`); }
    } else if (what === "choose") {
      res = await chooseProficiency(item, btn.dataset.key, btn.dataset.label);
      if (res) card.querySelectorAll("[data-aug-trigger]").forEach(x => { x.disabled = true; });
    } else {
      if (!activity) return ui.notifications.warn("That augment roll no longer exists.");
      const targets = (card.dataset.targets || "").split(",").filter(Boolean);
      res = btn.dataset.type ? await rollAsType(item, activity, btn.dataset.type) : await useNow(item, activity, targets, { configure: true });
      if (res) await applyTargetEffects(item, activity, targets);
    }
    if (res !== null && res !== undefined && res !== false) btn.classList.add("done"); else btn.disabled = false;
  });
}

/* -------------------------------------------- */
/*  Turns and areas                             */
/* -------------------------------------------- */

function onTurn(combat, changes) {
  if (!isActiveGM() || mode() === "off") return;
  if (!("turn" in changes) && !("round" in changes)) return;
  const prev = combat.previous?.combatantId ? combat.combatants.get(combat.previous.combatantId) : null;
  const cur = combat.combatant;
  const prevStamp = combat.previous ? `${combat.id}.${combat.previous.round}.${combat.previous.turn}` : null;
  if (prev?.actor) turnEvent(prev, "end", prevStamp);
  // Start counting the new combatant's movement and damage for this turn.
  if (cur?.tokenId) {
    const tdoc = cur.token ?? canvas?.scene?.tokens?.get?.(cur.tokenId);
    turnStats.set(cur.tokenId, { moved: 0, dealt: false, since: `${combat.id}.${combat.round}`, start: tdoc ? centerOf(tdoc) : null, viaMove: 0 });
  }
  if (cur?.actor) turnEvent(cur, "start");
}

function turnEvent(combatant, when, stamp = turnStamp()) {
  const subject = combatant.actor;
  const token = combatant.token?.object ?? tokenOf(subject);
  const name = combatant.token?.name ?? subject.name;
  for (const l of listeners([when === "end" ? "turnEnd" : "turnStart"])) {
    if (relates(l, subject)) fire(l, { reason: `${name} ${when === "end" ? "ends" : "starts"} its turn.`, stamp });
  }
  // GM reminder: augment effects sitting on a creature the GM runs ("can't regain hit points").
  if (when === "start" && !subject.hasPlayerOwner) remindGM(subject, name);
  // Banked amounts: remind at the start of your turn, expire at the end of the turn after banking.
  const round = game.combat ? `${game.combat.id}.${game.combat.round}` : null;
  for (const item of bankedAugments(subject)) {
    const at = item.flags[MODULE_ID].bankedAt;
    if (when === "start") postBankCard(item, `${name} starts its turn with ${getStack(item).value} ${getStack(item).name} banked.`);
    else if (item.flags[MODULE_ID].auto.stack.expires === "nextTurnEnd" && at && round && at !== round) postBankCard(item, "It wasn't used before the end of this turn.", { expired: true });
  }
  if (!token) return;
  const kind = when === "end" ? "areaEnd" : "areaStart";
  for (const { doc, origin } of areasHolding(token)) {
    for (const l of listeners([kind])) {
      if (l.item.uuid !== origin.itemUuid || !sideOk(l, token)) continue;
      fire(l, { reason: `${name} ${when === "end" ? "ends" : "starts"} its turn in ${l.item.name}'s area.`, targets: [token] });
    }
  }
}

/* Remember where tokens were so we can tell when one walks into an area. */
function onPreUpdateToken(doc, changes, options) {
  if (!("x" in changes) && !("y" in changes)) return;
  options[MODULE_ID] = { before: areaDocs().filter(a => inArea(a.doc, doc)).map(a => a.doc.id), from: centerOf(doc) };
}

function onUpdateToken(doc, changes, options) {
  if (!isActiveGM()) return;
  if (!("x" in changes) && !("y" in changes)) return;
  // Movement this turn, for "if you moved at least 20 feet". Three sources, use the largest:
  // each step measured (when the move's start point reaches us), Foundry's own movement record
  // (v13+), and at least the straight line from where the turn started.
  if (game.combat?.started && game.combat.combatant?.tokenId === doc.id) {
    const st = statsFor(doc.id);
    st.since ??= `${game.combat.id}.${game.combat.round}`;
    const from = options?.[MODULE_ID]?.from;
    if (from) st.stepped = (st.stepped ?? 0) + measure(from, centerOf(doc));
    const straight = st.start ? measure(st.start, centerOf(doc)) : 0;
    st.moved = Math.max(st.stepped ?? 0, st.viaMove ?? 0, straight, st.moved ?? 0);
    dbg(`${doc.name} has moved ${Math.round(st.moved)} ft this turn.`);
  }
  queueAuras();
  if (mode() === "off") return;
  const before = new Set(options?.[MODULE_ID]?.before ?? []);
  // Wait for the move animation to settle so the token's position matches its document.
  setTimeout(() => {
    for (const { doc: area, origin } of areaDocs()) {
      if (before.has(area.id) || !inArea(area, doc)) continue;
      for (const l of listeners(["areaEnter"])) {
        if (l.item.uuid !== origin.itemUuid || !sideOk(l, doc)) continue;
        fire(l, { reason: `${doc.name} enters ${l.item.name}'s area.`, targets: l.trig.areaInfo ? [] : [doc] });
      }
    }
  }, 120);
}

/** Foundry v13+: the move's own measured distance. */
function onMoveToken(doc, movement) {
  if (!isActiveGM() || !game.combat?.started || game.combat.combatant?.tokenId !== doc.id) return;
  const d = Number(movement?.passed?.distance ?? movement?.distance) || 0;
  if (!d) return;
  const st = statsFor(doc.id);
  st.since ??= `${game.combat.id}.${game.combat.round}`;
  st.viaMove = (st.viaMove ?? 0) + d;
  st.moved = Math.max(st.moved ?? 0, st.viaMove);
}

/* Damage rolled by the creature whose turn it is, for "if you dealt no damage". */
function onChatMessage(message) {
  if (!isActiveGM() || !game.combat?.started) return;
  const tokenId = message.speaker?.token;
  if (!tokenId || game.combat.combatant?.tokenId !== tokenId) return;
  const type = message.flags?.dnd5e?.roll?.type ?? message.flags?.dnd5e?.messageType;
  const damage = (message.rolls ?? []).filter(r => /DamageRoll/.test(r?.constructor?.name ?? "") || r?.options?.type);
  const real = damage.filter(r => !HEAL_TYPES.has(r?.options?.type));
  if (type === "damage" ? real.length || !damage.length : real.length) statsFor(tokenId).dealt = true;
}

/* -------------------------------------------- */
/*  Markers on creatures inside augment areas   */
/* -------------------------------------------- */

/**
 * "Enemies inside have disadvantage on ranged attacks", "enemies treat it as difficult terrain":
 * creatures inside get a labelled effect while they're in the area, removed when they leave.
 */
let syncing = false, syncAgain = false;
const ourDeletes = new Set();
async function syncAuras() {
  if (!isActiveGM() || !canvas?.scene) return;
  // One at a time: overlapping runs could each see a half-finished state.
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  try { await syncAurasOnce(); } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; queueAuras(); }
  }
}

async function syncAurasOnce() {
  const areas = areaDocs().map(a => {
    let item = null;
    try { item = fromUuidSync(a.origin.itemUuid); } catch (e) { /* gone */ }
    return { ...a, item, auras: item?.flags?.[MODULE_ID]?.auto?.auras ?? [] };
  }).filter(a => a.item && a.auras.length);
  // Auras around a creature: "you and allies within 10 feet gain +1 to Wisdom saves".
  const around = [];
  const unsure = new Set(); // auras whose holder we can't see right now: leave them alone
  for (const owner of candidateActors()) {
    for (const item of owner.items) {
      const list = item.flags?.[MODULE_ID]?.auto?.ownerAuras;
      if (!list?.length || !isAugment(item) || equippedBy(item) !== owner) continue;
      const ownTok = canvas.scene.tokens.find(t => t.actor === owner || t.actor?.uuid === owner.uuid || (t.actorLink && t.actorId === owner.id));
      if (!ownTok) { list.forEach((_, i) => unsure.add(`own:${item.uuid}:${i}`)); continue; }
      around.push({ owner, ownTok, item, list });
    }
  }
  // Group tokens by the creature they show: two tokens of one linked character share its effects,
  // so what one token's position adds must not be removed because of where another stands.
  const byActor = new Map();
  for (const tdoc of canvas.scene.tokens) {
    const actor = tdoc.actor;
    if (!actor) continue;
    const key = actor.uuid;
    if (!byActor.has(key)) byActor.set(key, { actor, tokens: [] });
    byActor.get(key).tokens.push(tdoc);
  }
  for (const { actor, tokens } of byActor.values()) {
    const want = new Map();
    for (const tdoc of tokens) {
      for (const a of areas) {
        if (!inArea(a.doc, tdoc)) continue;
        const owner = tokenOf(a.item.actor);
        const ownerDisp = owner ? disposition(owner) : 1;
        const same = disposition(tdoc) === ownerDisp;
        a.auras.forEach((aura, i) => {
          if (aura.who === "enemy" && same) return;
          if (aura.who === "ally" && !same) return;
          want.set(`${a.doc.id}:${i}`, { aura, item: a.item });
        });
      }
      for (const src of around) {
        if (src.owner === actor || src.owner.uuid === actor.uuid) continue; // the owner has it as a passive already
        if (disposition(tdoc) !== disposition(src.ownTok)) continue;
        src.list.forEach((aura, i) => {
          if (distance(src.ownTok, tdoc) <= aura.range + 0.1) want.set(`own:${src.item.uuid}:${i}`, { aura, item: src.item, from: src.owner });
        });
      }
    }
    const have = actor.effects.filter(e => e.flags?.[MODULE_ID]?.aura);
    const remove = have.filter(e => !want.has(e.flags[MODULE_ID].aura) && !unsure.has(e.flags[MODULE_ID].aura)).map(e => e.id);
    if (remove.length) dbg(`aura: removing ${remove.length} from ${actor.name} (out of range or area gone).`);
    remove.forEach(id => ourDeletes.add(id));
    const haveKeys = new Set(have.map(e => e.flags[MODULE_ID].aura));
    const add = [...want].filter(([k]) => !haveKeys.has(k)).map(([k, { aura, item, from }]) => ({
      name: from ? `${item.name} (${from.name})` : `${item.name}: ${aura.label}`, img: item.img, origin: item.uuid,
      transfer: false, disabled: false, description: aura.text,
      changes: aura.changes ?? [], statuses: aura.statuses ?? [],
      flags: { [MODULE_ID]: { aura: k } }
    }));
    if (remove.length) await actor.deleteEmbeddedDocuments("ActiveEffect", remove).catch(() => null);
    if (add.length) {
      dbg(`aura: adding ${add.map(a => a.name).join(", ")} to ${actor.name}.`);
      await actor.createEmbeddedDocuments("ActiveEffect", add).catch(err => console.warn(`${MODULE_ID} | Couldn't add an aura effect`, err));
    }
  }
}

/** Someone other than this module removed an aura effect: say who, to help track it down. */
function onAuraDeleted(effect, options, userId) {
  if (!effect.flags?.[MODULE_ID]?.aura) return;
  if (ourDeletes.delete(effect.id)) return;
  dbg(`aura: "${effect.name}" on ${effect.parent?.name} was deleted by ${game.users.get(userId)?.name ?? userId}, not by this module.`, options);
}
const queueAuras = foundry.utils.debounce(() => syncAuras(), 200);

/* -------------------------------------------- */
/*  Hit points                                  */
/* -------------------------------------------- */

function hpOf(actor) {
  const hp = actor?.system?.attributes?.hp;
  return hp ? { value: Number(hp.value) || 0, temp: Number(hp.temp) || 0, max: Number(hp.effectiveMax ?? hp.max) || 0 } : null;
}

function onPreUpdateActor(actor, changes, options) {
  if (!foundry.utils.hasProperty(changes, "system.attributes.hp")) return;
  const hp = hpOf(actor);
  if (hp) options[MODULE_ID] = { ...(options[MODULE_ID] ?? {}), hp };
}

/* Last known HP per creature, so a change can always be compared (whoever made it, however it was sent). */
const hpCache = new Map();
function onUpdateActor(actor, changes, options) {
  if (!isActiveGM()) return;
  if (!foundry.utils.hasProperty(changes, "system.attributes.hp")) return;
  const now = hpOf(actor);
  const old = options?.[MODULE_ID]?.hp ?? (options?.dnd5e?.hp ? hpOf({ system: { attributes: { hp: options.dnd5e.hp } } }) : null) ?? hpCache.get(actor.uuid);
  if (now) hpCache.set(actor.uuid, now);
  if (mode() === "off") return;
  if (!old || !now) return dbg(`${actor.name}: HP changed but its previous HP wasn't known.`);
  dbg(`${actor.name}: HP ${old.value}+${old.temp} → ${now.value}+${now.temp}.`);
  const name = tokenOf(actor)?.name ?? actor.name;
  const events = [];
  if (now.value + now.temp < old.value + old.temp) events.push(["damaged", ["damaged", "allyDamaged"], `${name} takes damage.`]);
  if (old.value > 0 && now.value <= 0) events.push(["zero", ["zeroHp", "allyZero", "enemyZero"], `${name} drops to 0 hit points.`]);
  const half = Math.floor(now.max / 2);
  if (old.value > half && now.value <= half) events.push(["bloodied", ["bloodied", "allyBloodied"], `${name} is bloodied.`]);
  if (now.value > old.value) events.push(["heal", ["regainHp"], `${name} regains hit points.`]);
  if (now.temp > old.temp) events.push(["temp", ["gainTemp"], `${name} gains temporary hit points.`]);
  for (const [, kinds, reason] of events) {
    for (const l of listeners(kinds)) {
      const ok = l.kind === "enemyZero" ? relatesEnemy(l, actor) : relates(l, actor);
      // Rolls aimed at the creature that triggered them (e.g. a counterattack) get it targeted.
      const aimed = l.activity?.type === "attack" || l.activity?.type === "save";
      const hostile = disposition(tokenOf(actor)) * disposition(tokenOf(l.actor)) < 0;
      // Healing for someone else ("restore 4d8 hit points to it") is aimed at that creature.
      const forThem = l.activity?.type === "heal" && actor !== l.actor && actor.uuid !== l.actor.uuid && !hostile;
      if (ok) fire(l, { reason, targets: (aimed && hostile) || forThem ? [tokenOf(actor)].filter(Boolean) : [] });
    }
  }
}

function relatesEnemy(l, subject) {
  if (subject === l.actor) return false;
  const mine = tokenOf(l.actor), theirs = tokenOf(subject);
  if (!mine || !theirs) return false;
  if (l.trig.range && distance(mine, theirs) > l.trig.range + 0.1) return false;
  return disposition(mine) * disposition(theirs) < 0 || (!subject.hasPlayerOwner && disposition(theirs) !== disposition(mine));
}

/* -------------------------------------------- */
/*  Rolls, rests, spells (fire on the roller)   */
/* -------------------------------------------- */

function subjectActor(x) {
  return x?.actor ?? (x?.documentName === "Actor" ? x : null) ?? x?.parent?.actor ?? null;
}

function rollOutcome(rolls) {
  const r = Array.isArray(rolls) ? rolls[0] : rolls;
  if (!r) return "any";
  if (r.isSuccess === true || r.isCritical === true && r.options?.target != null) return "success";
  if (r.isFailure === true) return "fail";
  return "any";
}

function rollEvent(kinds, subject, { reason, outcome = "any", exclude = null, damageType = null, recipients = null } = {}) {
  if (mode() === "off" || !subject) return;
  dbg(`${subject.name}: ${kinds.join("/")} (${outcome}).`);
  for (const l of listeners(kinds)) {
    if (exclude && l.item === exclude) continue;
    if (l.trig.outcome && l.trig.outcome !== "any" && outcome !== "any" && l.trig.outcome !== outcome) {
      dbg(`${l.item.name}: skipped, it needs a ${l.trig.outcome === "fail" ? "failure" : "success"}.`);
      continue;
    }
    if (!relates(l, subject)) continue;
    // Roll with no DC: whether it failed is unknown, so say it's a reminder.
    const note = l.trig.outcome && l.trig.outcome !== "any" && outcome === "any"
      ? `No DC was set, so this is a reminder: use it only if the roll ${l.trig.outcome === "fail" ? "failed" : "succeeded"}.` : "";
    // Healing for someone else goes to them: the creature that rolled, or whoever the healer targeted.
    let targets = [];
    if (l.activity?.type === "heal") {
      if (recipients?.length) targets = recipients;
      else if (subject !== l.actor && subject.uuid !== l.actor.uuid) targets = [tokenOf(subject)].filter(Boolean);
    }
    fire(l, { reason, damageType, note, targets });
  }
}

function onSave(rolls, data) {
  const actor = subjectActor(data?.subject);
  const o = rollOutcome(rolls);
  rollEvent(["saveRoll"], actor, { reason: `${actor?.name} ${o === "fail" ? "fails" : o === "success" ? "succeeds on" : "makes"} a saving throw.`, outcome: o });
}
function onCheck(rolls, data) {
  const actor = subjectActor(data?.subject);
  const o = rollOutcome(rolls);
  rollEvent(["checkRoll"], actor, { reason: `${actor?.name} ${o === "fail" ? "fails" : "makes"} an ability check.`, outcome: o });
}
function onHitDie(rolls, data) {
  const actor = subjectActor(data?.subject);
  rollEvent(["hitDie"], actor, { reason: `${actor?.name} spends a Hit Die.` });
}

function onDamage(rolls, data) {
  const activity = data?.subject;
  const item = activity?.item ?? (activity?.documentName === "Item" ? activity : null);
  const actor = subjectActor(item ?? activity);
  if (!actor) return;
  const list = Array.isArray(rolls) ? rolls : [rolls];
  const types = list.map(r => r?.options?.type).filter(Boolean);
  const healing = types.length && types.every(t => HEAL_TYPES.has(t));
  offerBanks(actor, healing ? "heal" : "damage", item);
  if (healing) return rollEvent(["heal"], actor, { reason: `${actor.name} restores hit points.`, exclude: item, recipients: [...(game.user?.targets ?? [])] });
  rollEvent(["dealDamage"], actor, { reason: `${actor.name} deals damage${item ? ` with ${item.name}` : ""}.`, exclude: item, damageType: types[0] ?? null });
}

/** Someone rolled healing or damage: offer any bank that can join that roll. */
function offerBanks(roller, kind, rolledWith) {
  for (const owner of candidateActors()) {
    for (const item of bankedAugments(owner)) {
      if (item === rolledWith) continue;
      const st = getStack(item);
      if (st.spendOn?.length && !st.spendOn.includes(kind)) continue;
      const self = roller === owner || roller?.uuid === owner.uuid;
      // "one healing roll or one ally's damage roll within 30 feet"
      if (!self) {
        if (!(st.allies || kind === "damage")) continue;
        const a = tokenOf(owner), b = tokenOf(roller);
        if (!a || !b || disposition(a) !== disposition(b)) continue;
        if (st.range && distance(a, b) > st.range + 0.1) continue;
      } else if (kind === "damage" && st.allies) continue;
      postBankCard(item, `${roller.name} rolls ${kind === "heal" ? "healing" : "damage"}.`);
    }
  }
}

/* An attack roll: "after a melee hit", "when you hit". Hits fire; misses don't; unknown asks. */
function onAttack(rolls, data) {
  const activity = data?.subject;
  const item = activity?.item ?? null;
  const actor = subjectActor(item ?? activity);
  if (!actor || mode() === "off") return;
  const r = Array.isArray(rolls) ? rolls[0] : rolls;
  const hit = r?.isSuccess === true || r?.isCritical === true ? true : r?.isFailure === true ? false : null;
  const crit = r?.isCritical === true;
  // "when an enemy misses you": the roller's targets that it missed.
  if (hit === false || r?.isFumble === true) {
    const attackerTok = tokenOf(actor);
    for (const t of game.user?.targets ?? []) {
      const victim = t.actor;
      if (!victim) continue;
      for (const l of listeners(["missedBy"])) {
        if (!relates(l, victim)) continue;
        if (/\bmelee\b/i.test(l.trig.text ?? "") && ranged(activity)) continue;
        fire(l, { reason: `${actor.name} misses ${victim.name}.`, targets: attackerTok ? [attackerTok] : [] });
      }
    }
    return;
  }
  const isRanged = ranged(activity);
  const target = [...(game.user?.targets ?? [])][0];
  for (const l of listeners(["attackHit"])) {
    if (l.item === item || !relates(l, actor)) continue;
    if (l.trig.cond?.type === "crit" && !crit) continue;
    if (/\bmelee\b/i.test(l.trig.text ?? "") && isRanged) continue;
    if (/\branged\b/i.test(l.trig.text ?? "") && !/\bmelee\b/i.test(l.trig.text ?? "") && !isRanged) continue;
    const aimed = l.activity && ["attack", "save", "damage"].includes(l.activity.type);
    const dtype = [...(activity?.damage?.parts?.[0]?.types ?? [])][0] ?? null;
    fire(l, { reason: `${actor.name} ${hit ? "hits" : "attacks"}${target ? ` ${target.name}` : ""}${item ? ` with ${item.name}` : ""}.`, note: hit ? "" : "If it hits:", targets: aimed && target ? [target] : [], damageType: dtype });
  }
}

function ranged(activity) {
  return activity?.attack?.type?.value === "ranged" || /\branged\b/i.test(activity?.actionType ?? "");
}

function onUse(activity) {
  const item = activity?.item;
  const actor = item?.actor;
  if (!actor || !item.isOwner) return;
  if (isAugment(item)) markUsed(item, activity);
  if (item.type === "spell") {
    rollEvent(["castSpell"], actor, { reason: `${actor.name} casts ${item.name}.`, exclude: item });
    if ((item.system?.level ?? 0) > 0) rollEvent(["spendResource"], actor, { reason: `${actor.name} spends a spell slot.`, exclude: item });
  } else if (!isAugment(item) && item.type === "feat" && item.system?.uses?.max) {
    rollEvent(["spendResource"], actor, { reason: `${actor.name} uses ${item.name}.`, exclude: item });
  }
}

function onRest(actor, result) {
  if (!actor?.isOwner) return;
  const long = !!(result?.longRest ?? result?.type === "long");
  // "Clear the reserve after a short or long rest."
  for (const item of actor.items) {
    const st = item.flags?.[MODULE_ID]?.auto?.stack;
    if (st?.clearOnRest && Number(item.flags[MODULE_ID].stackValue) > 0 && equippedBy(item) === actor) setStackValue(item, 0);
  }
  rollEvent([long ? "longRest" : "shortRest"], actor, { reason: `${actor.name} finishes a ${long ? "long" : "short"} rest.` });
}

function onCombatant(combatant, changes) {
  if (!isActiveGM() || mode() === "off" || !("initiative" in changes) || changes.initiative == null) return;
  const actor = combatant.actor;
  rollEvent(["initiative"], actor, { reason: `${actor?.name} rolls initiative.` });
}

/* -------------------------------------------- */
/*  Areas: tag, auto-target, expire             */
/* -------------------------------------------- */

let pendingArea = null;

function rememberArea(activity) {
  const item = activity?.item;
  if (!isAugment(item) || !activity.target?.template?.type) return false;
  pendingArea = { itemUuid: item.uuid, activityId: activity.id, at: Date.now(), expires: expiryFor(activity), concentration: !!activity.duration?.concentration, actorUuid: item.actor?.uuid };
  return true;
}

/** preUseActivity: the area gets placed before the use finishes, so note the augment up front. */
function onAugmentUsing(activity) {
  rememberArea(activity);
}

/** postUseActivity: tag any areas dnd5e hands back (in case the create hook missed them). */
function onAugmentUsed(activity, usage, results) {
  if (!rememberArea(activity)) return;
  for (const t of results?.templates ?? []) tagArea(t?.document ?? t);
}

/**
 * Console helper: Augments.triggerReport(). Lists the augment areas on this scene, who is inside each,
 * and every installed augment roll that is listening for a moment.
 */
export function triggerReport() {
  const areas = areaDocs().map(({ doc, origin }) => ({
    area: `${doc.documentName} ${doc.id}`,
    augment: (() => { try { return fromUuidSync(origin.itemUuid)?.name; } catch (e) { return origin.itemUuid; } })(),
    inside: (canvas.tokens?.placeables ?? []).filter(t => inArea(doc, t)).map(t => t.name).join(", ") || "nobody"
  }));
  const rolls = listeners(Object.keys(TRIGGERS)).map(l => ({
    actor: l.actor.name, augment: l.item.name, roll: l.activity?.name ?? "(reminder card)", moment: TRIGGERS[l.kind]?.label ?? l.kind
  }));
  const untagged = [...(canvas?.scene?.templates ?? []), ...(canvas?.scene?.regions ?? [])].length - areas.length;
  console.log(`${MODULE_ID} | Trigger mode: ${mode()}. Augment areas on this scene:`);
  console.table(areas);
  if (untagged > 0) console.log(`${MODULE_ID} | ${untagged} other template(s)/region(s) on this scene aren't linked to an augment.`);
  console.log(`${MODULE_ID} | Installed augment rolls listening for a moment:`);
  console.table(rolls);
  if (!rolls.length) console.warn(`${MODULE_ID} | Nothing is listening. Run Update all augments so installed augments get their triggers.`);
  return { areas, rolls };
}

function expiryFor(activity) {
  const d = activity.duration ?? {};
  const v = Number(d.value) || 0;
  const per = { turn: 6, round: 6, minute: 60, hour: 3600, day: 86400 }[d.units];
  if (!v || !per) return null;
  const c = game.combat;
  return { worldTime: game.time.worldTime + v * per, round: c?.started ? c.round + Math.max(1, Math.round((v * per) / 6)) : null, combat: c?.started ? c.id : null };
}

async function tagArea(doc) {
  if (!doc || !pendingArea || Date.now() - pendingArea.at > 120000) return;
  if (doc.flags?.[MODULE_ID]?.area) return;
  const area = { ...pendingArea };
  try { await doc.update({ [`flags.${MODULE_ID}.area`]: area }); } catch (e) { /* not ours to tag */ }
  autoTarget(doc, area);
}

function onAreaCreated(doc, options, userId) {
  if (userId !== game.user.id) return;
  if (pendingArea && Date.now() - pendingArea.at < 120000) tagArea(doc);
}

function autoTarget(doc, area) {
  if (!game.settings.get(MODULE_ID, "autoTargetAreas")) return;
  setTimeout(() => {
    const ownerToken = area.actorUuid ? tokenOf(fromUuidSync(area.actorUuid)) : null;
    const inside = (canvas.tokens?.placeables ?? []).filter(t => t !== ownerToken && t.visible !== false && inArea(doc, t));
    if (inside.length) setTargets(inside.map(t => t.document.uuid));
  }, 150);
}

/** Delete applied augment effects and augment areas whose time is up. Active GM only. */
async function sweepExpired() {
  if (!isActiveGM() || !game.settings.get(MODULE_ID, "expireEffects")) return;
  const actors = new Set();
  for (const c of game.combat?.combatants ?? []) if (c.actor) actors.add(c.actor);
  for (const t of canvas?.scene?.tokens ?? []) if (t.actor) actors.add(t.actor);
  for (const actor of actors) {
    const dead = actor.effects.filter(e => {
      const f = e.flags?.[MODULE_ID];
      if (!f || !(f.applied || f.kind === "self" || f.kind === "target")) return false;
      if (e.isExpired === true) return true;
      const rem = e.duration?.remaining;
      return typeof rem === "number" && rem <= 0 && (e.duration?.seconds || e.duration?.rounds || e.duration?.turns);
    }).map(e => e.id);
    if (dead.length) await actor.deleteEmbeddedDocuments("ActiveEffect", dead).catch(() => null);
  }
  const scene = canvas?.scene;
  if (!scene) return;
  const now = game.time.worldTime, c = game.combat;
  for (const doc of [...(scene.templates ?? []), ...(scene.regions ?? [])]) {
    const ex = doc.flags?.[MODULE_ID]?.area?.expires;
    if (!ex) continue;
    const byRound = ex.combat && c?.id === ex.combat && ex.round != null && c.round >= ex.round;
    const byTime = !ex.combat && now >= ex.worldTime;
    if (byRound || byTime) await doc.delete().catch(() => null);
  }
}

/** Concentration ended: remove the augment areas it was holding up. */
async function onEffectDeleted(effect) {
  if (!isActiveGM() || !effect.statuses?.has?.("concentrating")) return;
  const actor = effect.parent;
  const scene = canvas?.scene;
  if (!actor || !scene) return;
  for (const doc of [...(scene.templates ?? []), ...(scene.regions ?? [])]) {
    const a = doc.flags?.[MODULE_ID]?.area;
    if (a?.concentration && a.actorUuid === actor.uuid) await doc.delete().catch(() => null);
  }
}

/* -------------------------------------------- */

export function registerTriggers() {
  Hooks.on("updateCombat", onTurn);
  Hooks.on("updateCombat", () => sweepExpired());
  Hooks.on("updateWorldTime", () => sweepExpired());
  Hooks.on("updateCombatant", onCombatant);
  Hooks.on("preUpdateToken", onPreUpdateToken);
  Hooks.on("updateToken", onUpdateToken);
  Hooks.on("preUpdateActor", onPreUpdateActor);
  Hooks.on("updateActor", onUpdateActor);
  Hooks.on("deleteActiveEffect", onEffectDeleted);
  Hooks.on("createMeasuredTemplate", onAreaCreated);
  Hooks.on("createRegion", onAreaCreated);
  for (const h of ["createMeasuredTemplate", "updateMeasuredTemplate", "deleteMeasuredTemplate", "createRegion", "updateRegion", "deleteRegion", "canvasReady", "updateCombat"]) {
    Hooks.on(h, () => queueAuras());
  }
  Hooks.on("createChatMessage", onChatMessage);
  Hooks.on("moveToken", onMoveToken);
  Hooks.on("canvasReady", () => { for (const t of canvas.scene?.tokens ?? []) if (t.actor) { const hp = hpOf(t.actor); if (hp) hpCache.set(t.actor.uuid, hp); } });
  Hooks.on("deleteActiveEffect", onAuraDeleted);
  // Equipping or removing an augment can add or remove an aura around its owner.
  for (const h of ["updateActor", "createItem", "deleteItem", "updateItem"]) Hooks.on(h, () => queueAuras());
  // Installing an augment with a proficiency choice asks the owner which one.
  Hooks.on("updateActor", (actor, changes) => { if (foundry.utils.hasProperty(changes, `flags.${MODULE_ID}`)) offerChoices(actor); });
  Hooks.on("updateItem", item => { if (item.parent?.documentName === "Actor" && item.flags?.[MODULE_ID]?.auto?.choice) offerChoices(item.parent); });
  Hooks.on("dnd5e.preUseActivity", onAugmentUsing);
  Hooks.on("dnd5e.postUseActivity", onAugmentUsed);
  Hooks.on("dnd5e.postUseActivity", onUse);
  Hooks.on("dnd5e.postUseActivity", onFollowUps);
  Hooks.on("dnd5e.restCompleted", onRest);
  // dnd5e 4+ names first, older names after. Each only fires on the client that rolled.
  const modern = foundry.utils.isNewerVersion(game.system?.version ?? "0", "4.0.99");
  if (modern) {
    Hooks.on("dnd5e.rollSavingThrow", onSave);
    Hooks.on("dnd5e.rollAbilityCheck", onCheck);
    Hooks.on("dnd5e.rollSkillV2", onCheck);
    Hooks.on("dnd5e.rollHitDieV2", onHitDie);
    Hooks.on("dnd5e.rollDamageV2", onDamage);
    Hooks.on("dnd5e.rollAttackV2", onAttack);
  } else {
    Hooks.on("dnd5e.rollAttack", (subject, roll) => onAttack([roll].flat(), { subject }));
    Hooks.on("dnd5e.rollAbilitySave", (actor, roll) => onSave([roll], { subject: actor }));
    Hooks.on("dnd5e.rollAbilityTest", (actor, roll) => onCheck([roll], { subject: actor }));
    Hooks.on("dnd5e.rollSkill", (actor, roll) => onCheck([roll], { subject: actor }));
    Hooks.on("dnd5e.rollHitDie", (actor, roll) => onHitDie([roll], { subject: actor }));
    Hooks.on("dnd5e.rollDamage", (subject, roll) => onDamage([roll].flat(), { subject }));
  }
  Hooks.on("renderChatMessageHTML", bindTriggerCard);
  Hooks.on("renderChatMessage", bindTriggerCard);
}

export const _test = { healsSelf, relates, relatesEnemy, rollOutcome, expiryFor, listeners, inArea, turnStats, checkCondition, syncAuras, bankPreview };
