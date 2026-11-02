import { MODULE_ID, isAugment, equippedBy, rarityColor, boldMarkdown, escapeHTML as esc } from "./core.js";
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
  if (!mine || !theirs) return false;
  if (trig.range && distance(mine, theirs) > trig.range + 0.1) return false;
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
function checkCondition(cond, actor) {
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
  if (cond.type === "ask") return { ok: null, note: cond.text, ask: true };
  return { ok: true, note: "" };
}

/** One trigger has happened. reason: short sentence. targets: tokens the roll should aim at. */
async function fire(l, { reason, targets = [] } = {}) {
  const { item, activity, trig, actor } = l;
  const targetIds = targets.map(t => (t.document ?? t).uuid).filter(Boolean);
  // Area rolls are once per creature; everything else once per augment.
  const key = `${item.uuid}.${activity?.id ?? trig.kinds.join("+")}.${targetIds.join("+")}`;
  // The same moment can reach us through two hooks (a skill check is also an ability check).
  const recentKey = `${key}.${l.kind}`;
  const last = recent.get(recentKey);
  if (last && Date.now() - last < 1500) return;
  // Conditions the module can check: skip quietly when they aren't met (before anything is recorded).
  const check = checkCondition(trig.cond, actor);
  if (check.ok === false) return;
  recent.set(recentKey, Date.now());
  if (trig.once) {
    const s = trig.onceScope === "round" ? roundStamp() : turnStamp();
    if (fired.get(key) === s) return;
    fired.set(key, s);
  }
  const uses = item.system?.uses;
  const left = uses?.max ? Number(uses.value ?? (uses.max - (uses.spent ?? 0))) : null;
  const spends = !!activity?.consumption?.targets?.length;
  if (left === 0 && spends) return; // nothing left to spend, so don't nag

  const simple = activity && !trig.action && check.ok === true && !trig.areaInfo;
  if (mode() === "auto" && simple && item.isOwner) return useNow(item, activity, targetIds);
  return postPrompt(l, reason, targetIds, check);
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
  return short === item.name ? "Roll" : short;
}

/** A compact dice summary for the button: "2d8 fire", "DEX save", "1d8 + PB healing". */
function dice(activity) {
  const fmt = f => String(f ?? "").replace(/@prof/g, "PB").replace(/@abilities\.(\w+)\.mod/g, (_, a) => a.toUpperCase()).replace(/@attributes\.spell\.mod/g, "spell mod");
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

function buttonHTML(item, actor, activity, trig) {
  const b = (action, icon, label, extra = "", attrs = "") =>
    `<button type="button" data-aug-trigger="${action}" ${attrs}><i class="fas ${icon}" inert></i><span class="aug-trig-label">${esc(label)}</span>${extra ? `<span class="aug-trig-dice">${esc(extra)}</span>` : ""}</button>`;
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
  if (trig.action === "gainStack") {
    const st = getStack(item);
    return b("stack", "fa-layer-group", `Gain 1 ${st?.name ?? "stack"}`, st ? `${st.value}${st.max ? ` / ${st.max}` : ""}` : "");
  }
  if (!activity) return "";
  if (rolls(activity)) return b("use", "fa-dice-d20", shortName(item, activity), [dice(activity), usesNote].filter(Boolean).join(" · "), `data-tooltip="${esc(activity.name)}"`);
  return b("use", "fa-hand-pointer", "Use", usesNote, `data-tooltip="${esc(activity.name)}"`);
}

async function postPrompt({ actor, item, activity, kind, trig }, reason, targetIds, check = { ok: true, note: "" }) {
  const Msg = ChatMessage.implementation ?? ChatMessage;
  const label = TRIGGERS[kind]?.label ?? "Triggered";
  const targetLine = targetIds.length
    ? `<div class="aug-trig-targets">${targetIds.map(u => { try { return esc(fromUuidSync(u)?.name ?? ""); } catch (e) { return ""; } }).filter(Boolean).join(", ")}</div>` : "";
  const condLine = check.note
    ? `<div class="aug-trig-cond ${check.ok === true ? "ok" : "ask"}"><i class="fas ${check.ok === true ? "fa-check" : "fa-circle-question"}" inert></i> ${esc(check.note)}</div>` : "";
  // Effects for others (e.g. "+1 AC for one ally"): drag onto a token, or apply to your targets.
  const linked = new Set((activity?.effects ?? []).map(e => e._id ?? e.id ?? e));
  const forOthers = [...(item.effects ?? [])].filter(e => linked.has(e.id) && e.flags?.[MODULE_ID]?.kind === "target");
  const content = `<div class="aug-trig-card${trig.areaInfo ? " info" : ""}" style="--rarity:${esc(rarityColor(item))}" data-item-uuid="${esc(item.uuid)}" data-activity-id="${esc(activity?.id ?? "")}" data-action="${esc(trig.action ?? "")}" data-targets="${esc(targetIds.join(","))}">
      <header><img src="${esc(item.img)}" alt=""><div><strong>${esc(item.name)}</strong><span>${esc(label[0].toUpperCase() + label.slice(1))}</span></div></header>
      ${reason ? `<p class="aug-trig-reason">${esc(reason)}</p>` : ""}
      ${trig.text ? `<p class="aug-trig-text">${boldMarkdown(trig.text)}</p>` : ""}
      ${condLine}${targetLine}
      ${forOthers.length ? `<div class="aug-trig-effects">${forOthers.map(effectHTML).join("")}</div>` : ""}
      ${buttonHTML(item, actor, activity, trig)}
    </div>`;
  return Msg.create({
    content,
    speaker: Msg.getSpeaker({ actor }),
    whisper: ownersOf(actor),
    flags: { [MODULE_ID]: { trigger: true, itemUuid: item.uuid, activityId: activity?.id ?? null } }
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
  try {
    res = await activity.use({}, { configure });
  } catch (err) {
    console.error(`${MODULE_ID} | Couldn't roll ${item.name}`, err);
    ui.notifications.error(`Couldn't roll ${activity.name}. See the console (F12).`);
  }
  if (res) await applySelfEffects(item, activity);
  return res;
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

async function spendHitDie(item, activity) {
  const actor = item.actor;
  const den = actor?.system?.attributes?.hd?.largestAvailable;
  if (actor?.system?.attributes?.hd && !den) return ui.notifications.warn(`${actor.name} has no Hit Dice left.`);
  if (activity?.consumption?.targets?.length) {
    const used = await activity.use({}, { configure: false }).catch(() => null);
    if (!used) return null;
  }
  let roll = null;
  try { roll = await actor.rollHitDie({ denomination: den }); } catch (e) {
    try { roll = await actor.rollHitDie(den); } catch (err) { console.error(`${MODULE_ID} | Couldn't roll a Hit Die`, err); }
  }
  await applySelfEffects(item, activity);
  return roll ?? true;
}

/** Click handler for prompt cards. */
export function bindTriggerCard(message, html) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  const card = root?.querySelector?.(".aug-trig-card");
  if (!card || card.dataset.bound) return;
  card.dataset.bound = "true";
  const btn = card.querySelector("[data-aug-trigger]");
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
  btn?.addEventListener("click", async event => {
    event.preventDefault();
    event.stopPropagation();
    const item = await fromUuid(card.dataset.itemUuid);
    if (!item) return ui.notifications.warn("That augment no longer exists.");
    if (!item.isOwner) return ui.notifications.warn(`Only ${item.parent?.name ?? "its owner"} can use this.`);
    const activity = card.dataset.activityId ? item.system?.activities?.get?.(card.dataset.activityId) : null;
    const what = btn.dataset.augTrigger;
    btn.disabled = true;
    let res = null;
    if (what === "hitDie") res = await spendHitDie(item, activity);
    else if (what === "bank") {
      const st = getStack(item);
      res = st ? await setStackValue(item, st.value + (Number(btn.dataset.amount) || 0)) : null;
      if (res !== null) ui.notifications.info(`${item.name}: ${res} ft stored.`);
    } else if (what === "stack") {
      const st = getStack(item);
      res = st ? await setStackValue(item, st.value + 1) : null;
      if (res !== null) ui.notifications.info(`${item.name}: ${res} ${st.name}.`);
    } else {
      if (!activity) return ui.notifications.warn("That augment roll no longer exists.");
      const targets = (card.dataset.targets || "").split(",").filter(Boolean);
      res = await useNow(item, activity, targets, { configure: true });
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
  if (prev?.actor) turnEvent(prev, "end");
  // Start counting the new combatant's movement and damage for this turn.
  if (cur?.tokenId) turnStats.set(cur.tokenId, { moved: 0, dealt: false, since: `${combat.id}.${combat.round}` });
  if (cur?.actor) turnEvent(cur, "start");
}

function turnEvent(combatant, when) {
  const subject = combatant.actor;
  const token = combatant.token?.object ?? tokenOf(subject);
  const name = combatant.token?.name ?? subject.name;
  for (const l of listeners([when === "end" ? "turnEnd" : "turnStart"])) {
    if (relates(l, subject)) fire(l, { reason: `${name} ${when === "end" ? "ends" : "starts"} its turn.` });
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
  // Movement this turn, for "if you moved at least 20 feet".
  const from = options?.[MODULE_ID]?.from;
  if (from && game.combat?.started && game.combat.combatant?.tokenId === doc.id) {
    const st = statsFor(doc.id);
    st.since ??= `${game.combat.id}.${game.combat.round}`;
    st.moved += measure(from, centerOf(doc));
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
async function syncAuras() {
  if (!isActiveGM() || !canvas?.scene) return;
  const areas = areaDocs().map(a => {
    let item = null;
    try { item = fromUuidSync(a.origin.itemUuid); } catch (e) { /* gone */ }
    return { ...a, item, auras: item?.flags?.[MODULE_ID]?.auto?.auras ?? [] };
  }).filter(a => a.item && a.auras.length);
  for (const tdoc of canvas.scene.tokens) {
    const actor = tdoc.actor;
    if (!actor) continue;
    const want = new Map();
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
    const have = actor.effects.filter(e => e.flags?.[MODULE_ID]?.aura);
    const remove = have.filter(e => !want.has(e.flags[MODULE_ID].aura)).map(e => e.id);
    const haveKeys = new Set(have.map(e => e.flags[MODULE_ID].aura));
    const add = [...want].filter(([k]) => !haveKeys.has(k)).map(([k, { aura, item }]) => ({
      name: `${item.name}: ${aura.label}`, img: item.img, origin: item.uuid, transfer: false, disabled: false,
      description: aura.text, flags: { [MODULE_ID]: { aura: k } }
    }));
    if (remove.length) await actor.deleteEmbeddedDocuments("ActiveEffect", remove).catch(() => null);
    if (add.length) await actor.createEmbeddedDocuments("ActiveEffect", add).catch(() => null);
  }
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

function onUpdateActor(actor, changes, options) {
  if (!isActiveGM() || mode() === "off") return;
  if (!foundry.utils.hasProperty(changes, "system.attributes.hp")) return;
  const old = options?.[MODULE_ID]?.hp ?? (options?.dnd5e?.hp ? hpOf({ system: { attributes: { hp: options.dnd5e.hp } } }) : null);
  const now = hpOf(actor);
  if (!old || !now) return;
  const name = tokenOf(actor)?.name ?? actor.name;
  const events = [];
  if (now.value + now.temp < old.value + old.temp) events.push(["damaged", ["damaged", "allyDamaged"], `${name} takes damage.`]);
  if (old.value > 0 && now.value <= 0) events.push(["zero", ["zeroHp", "allyZero", "enemyZero"], `${name} drops to 0 hit points.`]);
  const half = Math.floor(now.max / 2);
  if (old.value > half && now.value <= half && now.value > 0) events.push(["bloodied", ["bloodied", "allyBloodied"], `${name} is bloodied.`]);
  if (now.value > old.value) events.push(["heal", ["regainHp"], `${name} regains hit points.`]);
  if (now.temp > old.temp) events.push(["temp", ["gainTemp"], `${name} gains temporary hit points.`]);
  for (const [, kinds, reason] of events) {
    for (const l of listeners(kinds)) {
      const ok = l.kind === "enemyZero" ? relatesEnemy(l, actor) : relates(l, actor);
      // Rolls aimed at the creature that triggered them (e.g. a counterattack) get it targeted.
      const aimed = l.activity.type === "attack" || l.activity.type === "save";
      const hostile = disposition(tokenOf(actor)) * disposition(tokenOf(l.actor)) < 0;
      if (ok) fire(l, { reason, targets: aimed && hostile ? [tokenOf(actor)].filter(Boolean) : [] });
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

function rollEvent(kinds, subject, { reason, outcome = "any", exclude = null } = {}) {
  if (mode() === "off" || !subject) return;
  for (const l of listeners(kinds)) {
    if (exclude && l.item === exclude) continue;
    if (l.trig.outcome && l.trig.outcome !== "any" && outcome !== "any" && l.trig.outcome !== outcome) continue;
    if (relates(l, subject)) fire(l, { reason });
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
  if (healing) return rollEvent(["heal"], actor, { reason: `${actor.name} restores hit points.`, exclude: item });
  rollEvent(["dealDamage"], actor, { reason: `${actor.name} deals damage${item ? ` with ${item.name}` : ""}.`, exclude: item });
}

function onUse(activity) {
  const item = activity?.item;
  const actor = item?.actor;
  if (!actor || !item.isOwner) return;
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
    actor: l.actor.name, augment: l.item.name, roll: l.activity.name, moment: TRIGGERS[l.kind]?.label ?? l.kind
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
  Hooks.on("dnd5e.preUseActivity", onAugmentUsing);
  Hooks.on("dnd5e.postUseActivity", onAugmentUsed);
  Hooks.on("dnd5e.postUseActivity", onUse);
  Hooks.on("dnd5e.restCompleted", onRest);
  // dnd5e 4+ names first, older names after. Each only fires on the client that rolled.
  const modern = foundry.utils.isNewerVersion(game.system?.version ?? "0", "4.0.99");
  if (modern) {
    Hooks.on("dnd5e.rollSavingThrow", onSave);
    Hooks.on("dnd5e.rollAbilityCheck", onCheck);
    Hooks.on("dnd5e.rollSkillV2", onCheck);
    Hooks.on("dnd5e.rollHitDieV2", onHitDie);
    Hooks.on("dnd5e.rollDamageV2", onDamage);
  } else {
    Hooks.on("dnd5e.rollAbilitySave", (actor, roll) => onSave([roll], { subject: actor }));
    Hooks.on("dnd5e.rollAbilityTest", (actor, roll) => onCheck([roll], { subject: actor }));
    Hooks.on("dnd5e.rollSkill", (actor, roll) => onCheck([roll], { subject: actor }));
    Hooks.on("dnd5e.rollHitDie", (actor, roll) => onHitDie([roll], { subject: actor }));
    Hooks.on("dnd5e.rollDamage", (subject, roll) => onDamage([roll].flat(), { subject }));
  }
  Hooks.on("renderChatMessageHTML", bindTriggerCard);
  Hooks.on("renderChatMessage", bindTriggerCard);
}

export const _test = { relates, relatesEnemy, rollOutcome, expiryFor, listeners, inArea, turnStats, checkCondition, syncAuras, bankPreview };
