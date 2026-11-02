import { MODULE_ID, isAugment, escapeHTML as esc } from "./core.js";
import { TRIGGERS } from "./automation.js";
import { getBench, benchCopy, clearBench } from "./audit.js";
import { resetTriggerMemory, triggerReport } from "./triggers.js";

/**
 * In-game trigger self-test (GM only, from the audit window).
 * Builds a throwaway scene with the test bench, a friendly ally and a hostile enemy, then for each
 * scenario installs one augment on the bench and makes its moment really happen through Foundry and
 * dnd5e (damage, saves, turns, movement into an area, rests...). It records whether a trigger card
 * appeared, what was on it, every "augments | trigger:" log line and any errors, cleans up, and
 * downloads a report.
 */

const SCENE_NAME = "Augment Self-Test";
const GRID = 100;                         // pixels per 5 ft square
const POS = { bench: { x: 1000, y: 1000 }, ally: { x: 1100, y: 1000 }, enemy: { x: 900, y: 1000 }, far: { x: 2400, y: 1000 } };
const AREA = { x: 1650, y: 1050 };        // centre of test areas, away from everyone
const wait = ms => new Promise(r => setTimeout(r, ms));
/** Never let one stuck roll or dialog freeze a long run. */
function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([Promise.resolve(promise).finally(() => clearTimeout(timer)), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms); })]);
}
let cancelRequested = false;
export function stopSelfTest() { cancelRequested = true; ui.notifications.info("Augment self-test: stopping after the current augment..."); }
const PROGRESS_KEY = `${MODULE_ID}.selftest.partial`;
function saveProgress(report) { try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(report)); } catch (e) { /* too big or blocked */ } }
function unfinishedRun() {
  try {
    const r = JSON.parse(localStorage.getItem(PROGRESS_KEY) ?? "null");
    return r && !r.finished ? r : null;
  } catch (e) { return null; }
}

/** Console helper: Augments.lastSelfTest() downloads the last (possibly unfinished) report. */
export function lastSelfTest() {
  let r = null;
  try { r = JSON.parse(localStorage.getItem(PROGRESS_KEY) ?? "null"); } catch (e) { /* none */ }
  if (!r) return ui.notifications.warn("No saved self-test report in this browser.");
  const save = foundry.utils?.saveDataToFile ?? globalThis.saveDataToFile;
  save(JSON.stringify(r, null, 1), "application/json", "augment-selftest-last.json");
  showReport(r);
  return r;
}

/* -------------------------------------------- */
/*  Capture                                     */
/* -------------------------------------------- */

class Recorder {
  constructor() { this.logs = []; this.errors = []; this.cards = []; }
  start() {
    this.origLog = console.log; this.origWarn = console.warn; this.origErr = console.error;
    const text = args => args.map(a => (typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch (e) { return String(a); } })())).join(" ");
    console.log = (...a) => { const t = text(a); if (t.startsWith(`${MODULE_ID} |`)) this.logs.push(t); this.origLog(...a); };
    console.warn = (...a) => { const t = text(a); if (/augments/i.test(t)) this.errors.push(`warn: ${t}`); this.origWarn(...a); };
    console.error = (...a) => { this.errors.push(`error: ${text(a)}`.slice(0, 600)); this.origErr(...a); };
    this.onErr = e => this.errors.push(`uncaught: ${e?.message ?? e?.reason?.message ?? e}`);
    window.addEventListener("error", this.onErr);
    window.addEventListener("unhandledrejection", this.onErr);
    this.messages = [];
    this.hook = Hooks.on("createChatMessage", msg => {
      this.messages.push(msg.id);
      if (!msg.flags?.[MODULE_ID]?.trigger) return;
      const html = String(msg.content ?? "");
      this.cards.push({
        itemUuid: msg.flags[MODULE_ID].itemUuid,
        title: html.match(/<span>([^<]*)<\/span><\/div><\/header>/)?.[1] ?? "",
        buttons: [...html.matchAll(/aug-trig-label">(.*?)<\/span>/g)].map(m => m[1]),
        condition: html.match(/aug-trig-cond[^>]*>(?:<i[^>]*><\/i>)?\s*(.*?)<\/div>/)?.[1] ?? "",
        targets: html.match(/data-targets="(.*?)"/)?.[1] ?? "",
        messageId: msg.id
      });
    });
  }
  stop() {
    console.log = this.origLog; console.warn = this.origWarn; console.error = this.origErr;
    window.removeEventListener("error", this.onErr);
    window.removeEventListener("unhandledrejection", this.onErr);
    Hooks.off("createChatMessage", this.hook);
  }
  mark() { return { logs: this.logs.length, errors: this.errors.length, cards: this.cards.length }; }
  since(m) { return { logs: this.logs.slice(m.logs), errors: this.errors.slice(m.errors), cards: this.cards.slice(m.cards) }; }
}

/* -------------------------------------------- */
/*  Stage: scene, creatures, helper items       */
/* -------------------------------------------- */

/** An interrupted run leaves its scene, creatures and helper items behind: remove them first. */
async function cleanupLeftovers(bench) {
  const isTest = d => d?.flags?.[MODULE_ID]?.selftest;
  const scenes = game.scenes.filter(sc => isTest(sc) || sc.name === SCENE_NAME);
  if (scenes.some(sc => sc.id === canvas?.scene?.id)) {
    const other = game.scenes.find(sc => !scenes.includes(sc) && sc.active) ?? game.scenes.find(sc => !scenes.includes(sc));
    if (other) await other.view().catch(() => null);
  }
  for (const c of game.combats.filter(c => scenes.some(sc => sc.id === c.scene?.id))) await c.delete().catch(() => null);
  for (const sc of scenes) await sc.delete().catch(() => null);
  for (const a of game.actors.filter(a => isTest(a) && !a.flags?.[MODULE_ID]?.bench)) await a.delete().catch(() => null);
  const ids = bench.items.filter(i => isTest(i)).map(i => i.id);
  if (ids.length) await bench.deleteEmbeddedDocuments("Item", ids).catch(() => null);
  const folder = game.folders.find(f => f.type === "Actor" && f.name === SCENE_NAME);
  if (folder && !folder.contents?.length) await folder.delete().catch(() => null);
  return scenes.length;
}

/** Delete messages a few at a time, so the chat never has to redraw thousands at once. */
async function deleteGently(ids) {
  const Msg = ChatMessage.implementation ?? ChatMessage;
  const live = ids.filter(id => game.messages.has(id));
  for (let k = 0; k < live.length; k += 25) {
    await Msg.deleteDocuments(live.slice(k, k + 25)).catch(() => null);
    await wait(150);
  }
}

async function buildStage() {
  const stage = { previousScene: canvas?.scene ?? null, created: { actors: [], items: [] } };
  const folder = game.folders.find(f => f.type === "Actor" && f.name === SCENE_NAME)
    ?? await Folder.create({ name: SCENE_NAME, type: "Actor" });
  stage.folder = folder;
  const mk = async (name, type, hp, extra = {}) => {
    const a = await Actor.implementation.create({
      name, type, folder: folder.id, img: "icons/svg/mystery-man.svg",
      system: { attributes: { hp: { value: hp, max: hp } }, abilities: Object.fromEntries(["str", "dex", "con", "int", "wis", "cha"].map(k => [k, { value: 12 }])) },
      prototypeToken: { actorLink: true, disposition: extra.disposition ?? 1 }, flags: { [MODULE_ID]: { selftest: true } }
    });
    stage.created.actors.push(a);
    return a;
  };
  stage.bench = await getBench();
  await stage.bench.update({ "system.attributes.hp.max": 40, "system.attributes.hp.value": 40, "prototypeToken.actorLink": true, "prototypeToken.disposition": 1 });
  stage.ally = await mk("Self-Test Ally", "character", 40, { disposition: 1 });
  stage.enemy = await mk("Self-Test Enemy", "npc", 60, { disposition: -1 });

  stage.scene = await Scene.implementation.create({
    name: SCENE_NAME, width: 3000, height: 2000, padding: 0, grid: { size: GRID, distance: 5, units: "ft" },
    flags: { [MODULE_ID]: { selftest: true } }
  });
  await stage.scene.view();
  for (let i = 0; i < 50 && canvas.scene?.id !== stage.scene.id; i++) await wait(100);
  await wait(400);

  const tokenData = async (actor, pos, disposition) => {
    const t = (await actor.getTokenDocument({ x: pos.x, y: pos.y, disposition, actorLink: true })).toObject();
    return { ...t, x: pos.x, y: pos.y, disposition, actorLink: true };
  };
  const [tb, ta, te] = await stage.scene.createEmbeddedDocuments("Token", [
    await tokenData(stage.bench, POS.bench, 1), await tokenData(stage.ally, POS.ally, 1), await tokenData(stage.enemy, POS.enemy, -1)
  ]);
  Object.assign(stage, { tBench: tb, tAlly: ta, tEnemy: te });
  await wait(300);

  // Things to roll with: a strike (attack + damage), a healing touch, a spell, a class for Hit Dice.
  const id = () => foundry.utils.randomID();
  const attack = (bonus, crit = null) => ({
    _id: id(), type: "attack", name: "Strike", activation: { type: "action" },
    attack: { bonus: String(bonus), flat: false, type: { value: "melee", classification: "weapon" }, critical: { threshold: crit } },
    damage: { parts: [{ number: 1, denomination: 6, types: ["slashing"] }] }
  });
  const helperData = [
    { name: "Self-Test Strike", type: "feat", system: { activities: Object.fromEntries([attack("+50")].map(a => [a._id, a])) }, flags: { [MODULE_ID]: { selftest: true } } },
    { name: "Self-Test Critical", type: "feat", system: { activities: Object.fromEntries([attack("+50", 2)].map(a => [a._id, a])) }, flags: { [MODULE_ID]: { selftest: true } } },
    { name: "Self-Test Damage", type: "feat", system: { activities: Object.fromEntries([{ _id: id(), type: "damage", name: "Damage", activation: { type: "action" }, damage: { parts: [{ number: 1, denomination: 6, types: ["fire"] }] } }].map(a => [a._id, a])) }, flags: { [MODULE_ID]: { selftest: true } } },
    { name: "Self-Test Healing", type: "feat", system: { activities: Object.fromEntries([{ _id: id(), type: "heal", name: "Heal", activation: { type: "action" }, healing: { custom: { enabled: true, formula: "1d4" }, types: ["healing"] } }].map(a => [a._id, a])) }, flags: { [MODULE_ID]: { selftest: true } } },
    { name: "Self-Test Spell", type: "spell", system: { level: 1, activities: Object.fromEntries([{ _id: id(), type: "utility", name: "Cast", activation: { type: "action" } }].map(a => [a._id, a])) }, flags: { [MODULE_ID]: { selftest: true } } },
    { name: "Self-Test Class", type: "class", system: { identifier: "selftest", levels: 1, hd: { denomination: "d10", spent: 0 }, hitDice: "d10", hitDiceUsed: 0 }, flags: { [MODULE_ID]: { selftest: true } } }
  ];
  const byName = items => Object.fromEntries(items.map(i => [i.name.replace("Self-Test ", "").toLowerCase(), i]));
  // The bench and the ally both get them, so "when an ally casts / heals / attacks" can be the ally doing it.
  stage.helpers = byName(await stage.bench.createEmbeddedDocuments("Item", helperData));
  stage.allyHelpers = byName(await stage.ally.createEmbeddedDocuments("Item", foundry.utils.deepClone(helperData)));
  const [claw] = await stage.enemy.createEmbeddedDocuments("Item", [
    { name: "Self-Test Claw", type: "feat", system: { activities: Object.fromEntries([attack("-50")].map(a => [a._id, a])) } }
  ]);
  stage.helpers.claw = claw;
  return stage;
}

async function teardown(stage, bench) {
  try { for (const c of game.combats.filter(c => c.scene?.id === stage.scene?.id)) await c.delete(); } catch (e) { /* ignore */ }
  try { const ids = bench.items.filter(i => i.flags?.[MODULE_ID]?.selftest).map(i => i.id); if (ids.length) await bench.deleteEmbeddedDocuments("Item", ids); } catch (e) { /* ignore */ }
  try { await clearBench(); } catch (e) { /* ignore */ }
  try { await stripEffects(bench); } catch (e) { /* ignore */ }
  try { await bench.update({ "system.attributes.hp.value": bench.system.attributes.hp.max, "system.attributes.hp.temp": 0, [`flags.${MODULE_ID}.slots`]: [] }); } catch (e) { /* ignore */ }
  if (stage.previousScene) await stage.previousScene.view().catch(() => null);
  try { await stage.scene?.delete(); } catch (e) { /* ignore */ }
  for (const a of stage.created.actors) await a.delete().catch(() => null);
  if (stage.folder && !stage.folder.contents?.length) await stage.folder.delete().catch(() => null);
}

/* -------------------------------------------- */
/*  Resetting between scenarios                 */
/* -------------------------------------------- */

async function stripEffects(actor) {
  const ids = actor.effects.filter(e => e.flags?.[MODULE_ID] || e.statuses?.has?.("concentrating")).map(e => e.id);
  if (ids.length) await actor.deleteEmbeddedDocuments("ActiveEffect", ids).catch(() => null);
}

async function reset(stage) {
  resetTriggerMemory();
  for (const c of game.combats.filter(c => c.scene?.id === stage.scene.id)) await c.delete().catch(() => null);
  for (const t of [...stage.scene.templates ?? [], ...stage.scene.regions ?? []]) await t.delete().catch(() => null);
  for (const [a, t, p] of [[stage.bench, stage.tBench, POS.bench], [stage.ally, stage.tAlly, POS.ally], [stage.enemy, stage.tEnemy, POS.enemy]]) {
    const max = Number(a.system.attributes.hp.max) || 40;
    await a.update({ "system.attributes.hp.value": max, "system.attributes.hp.temp": 0, "system.attributes.death.success": 0, "system.attributes.death.failure": 0 });
    await stripEffects(a);
    if (t.x !== p.x || t.y !== p.y) await t.update({ x: p.x, y: p.y }, { animate: false, teleport: true }).catch(() => null);
  }
  for (const cls of [stage.helpers.class, stage.allyHelpers?.class]) if (cls) await cls.update({ "system.hd.spent": 0, "system.hitDiceUsed": 0 }).catch(() => null);
  game.user.targets.forEach(t => t.setTarget(false, { releaseOthers: false }));
  await wait(150);
}

/* -------------------------------------------- */
/*  Events                                      */
/* -------------------------------------------- */

const dnd = {
  async damage(actor, n) {
    if (typeof actor.applyDamage === "function") return actor.applyDamage(n);
    const hp = actor.system.attributes.hp;
    return actor.update({ "system.attributes.hp.value": Math.max(0, hp.value - n) });
  },
  async setHp(actor, value) { return actor.update({ "system.attributes.hp.value": value }); },
  async save(actor, ability, dc) {
    if (typeof actor.rollSavingThrow === "function" && foundry.utils.isNewerVersion(game.system.version, "4.0.99")) {
      return actor.rollSavingThrow({ ability, target: dc }, { configure: false }, { create: true });
    }
    return actor.rollAbilitySave(ability, { targetValue: dc, fastForward: true });
  },
  async check(actor, ability, dc) {
    if (typeof actor.rollAbilityCheck === "function") return actor.rollAbilityCheck({ ability, target: dc }, { configure: false }, { create: true });
    return actor.rollAbilityTest(ability, { targetValue: dc, fastForward: true });
  },
  async deathSave(actor, wantFail) {
    await actor.update({ "system.attributes.hp.value": 0 });
    for (let i = 0; i < 6; i++) {
      const r = await actor.rollDeathSave({}, { configure: false }, { create: true }).catch(() => actor.rollDeathSave({ fastForward: true }));
      const roll = Array.isArray(r) ? r[0] : r;
      if (!roll) return;
      if ((Number(roll.total) < 10) === wantFail) return;
      await actor.update({ "system.attributes.death.success": 0, "system.attributes.death.failure": 0, "system.attributes.hp.value": 0 });
      await wait(150);
    }
  },
  async hitDie(actor) {
    try { return await actor.rollHitDie({ denomination: "d10" }, { configure: false }, { create: true }); } catch (e) { return actor.rollHitDie("d10"); }
  },
  async rest(actor, long) {
    const cfg = { dialog: false, chat: false, newDay: false };
    return long ? actor.longRest(cfg) : actor.shortRest(cfg);
  },
  activity(item) { return item?.system?.activities?.contents?.[0] ?? null; },
  async rollDamage(item) { return dnd.activity(item)?.rollDamage({}, { configure: false }); },
  async rollAttack(item) { return dnd.activity(item)?.rollAttack({}, { configure: false }); },
  async use(item) { return dnd.activity(item)?.use({ consume: false }, { configure: false }); }
};

function target(tokenDoc) {
  game.user.targets.forEach(t => t.setTarget(false, { releaseOthers: false }));
  tokenDoc?.object?.setTarget(true, { releaseOthers: true });
}

async function startCombat(stage, order) {
  const combat = await Combat.implementation.create({ scene: stage.scene.id, active: true });
  const init = { [stage.tBench.id]: 0, [stage.tAlly.id]: 0, [stage.tEnemy.id]: 0 };
  order.forEach((t, i) => { init[t.id] = 30 - i; });
  await combat.createEmbeddedDocuments("Combatant", [stage.tBench, stage.tAlly, stage.tEnemy].map(t => ({ tokenId: t.id, sceneId: stage.scene.id, actorId: t.actorId, initiative: init[t.id] })));
  await combat.startCombat();
  await wait(300);
  return combat;
}

async function placeArea(stage, copy, trig) {
  const act = trig.activity ? copy.system.activities.get(trig.activity) : null;
  const tplAct = act?.target?.template?.size ? act : copy.system.activities.contents.find(a => a.target?.template?.size);
  const size = Number(tplAct?.target?.template?.size) || 15;
  const flags = { [MODULE_ID]: { area: { itemUuid: copy.uuid, activityId: tplAct?.id ?? null, actorUuid: stage.bench.uuid } } };
  try {
    const [t] = await stage.scene.createEmbeddedDocuments("MeasuredTemplate", [{ t: "circle", x: AREA.x, y: AREA.y, distance: size, flags }]);
    await wait(300);
    return t;
  } catch (e) {
    const r = (size / 5) * GRID;
    const [reg] = await stage.scene.createEmbeddedDocuments("Region", [{ name: "Self-Test Area", shapes: [{ type: "ellipse", x: AREA.x, y: AREA.y, radiusX: r, radiusY: r }], flags }]);
    await wait(300);
    return reg;
  }
}

const insideArea = { x: AREA.x - GRID / 2, y: AREA.y - GRID / 2 };
const outsideArea = { x: AREA.x - GRID / 2 - 600, y: AREA.y - GRID / 2 };

/** Who an event should happen to, from the trigger's own scope. */
function subjectFor(stage, trig, kind) {
  if (kind === "enemyZero") return { actor: stage.enemy, token: stage.tEnemy, label: "enemy" };
  if (kind.startsWith("ally") || (trig.who === "ally" && trig.self === false)) return { actor: stage.ally, token: stage.tAlly, label: "ally" };
  if (trig.who === "enemy") return { actor: stage.enemy, token: stage.tEnemy, label: "enemy" };
  return { actor: stage.bench, token: stage.tBench, label: "bench" };
}
function areaCreature(stage, trig) {
  if (trig.side === "ally") return { actor: stage.ally, token: stage.tAlly, label: "ally" };
  return { actor: stage.enemy, token: stage.tEnemy, label: "enemy" };
}

/** Set up anything the rule needs first (its state, low HP...), then make the moment happen. Returns a description. */
async function perform(stage, copy, trig, kind) {
  if (trig.requires) {
    await stage.bench.createEmbeddedDocuments("ActiveEffect", [{ name: trig.requires, img: copy.img, flags: { [MODULE_ID]: { applied: true } } }]);
  }
  if (trig.cond?.type === "belowHalf") await dnd.setHp(stage.bench, 10);
  const who = subjectFor(stage, trig, kind);
  const H = who.label === "ally" ? stage.allyHelpers : stage.helpers;
  const foe = stage.tEnemy;
  switch (kind) {
    case "turnStart": await startCombat(stage, [who.token]); return `${who.label}'s turn starts`;
    case "turnEnd": {
      const c = await startCombat(stage, [who.token]);
      if (trig.cond?.type === "movedAtLeast") await who.token.update({ x: who.token.x + (Math.ceil(trig.cond.n / 5) + 1) * GRID });
      if (trig.cond?.type === "dealtDamage" || trig.cond?.type === "usedThisTurn") { target(stage.tEnemy); await dnd.rollDamage(stage.helpers.damage); }
      await wait(300);
      await c.nextTurn();
      return `${who.label}'s turn ends`;
    }
    case "areaEnter": {
      const c = areaCreature(stage, trig);
      await placeArea(stage, copy, trig);
      await c.token.update(outsideArea, { animate: false, teleport: true });
      await wait(200);
      await c.token.update(insideArea);
      return `${c.label} walks into the area`;
    }
    case "areaStart": case "areaEnd": {
      const c = areaCreature(stage, trig);
      await placeArea(stage, copy, trig);
      await c.token.update(insideArea, { animate: false, teleport: true });
      await wait(200);
      const combat = await startCombat(stage, [c.token]);
      if (kind === "areaEnd") await combat.nextTurn();
      return `${c.label} ${kind === "areaStart" ? "starts" : "ends"} its turn in the area`;
    }
    case "damaged": case "allyDamaged": await dnd.damage(who.actor, 5); return `${who.label} takes 5 damage`;
    case "zeroHp": case "allyZero": case "enemyZero": await dnd.damage(who.actor, 999); return `${who.label} drops to 0`;
    case "bloodied": case "allyBloodied": await dnd.damage(who.actor, Math.ceil(who.actor.system.attributes.hp.max * 0.6)); return `${who.label} becomes bloodied`;
    case "regainHp": await dnd.setHp(who.actor, 10); await wait(150); resetTriggerMemory(); await dnd.setHp(who.actor, 15); return `${who.label} regains 5 HP`;
    case "gainTemp": await who.actor.update({ "system.attributes.hp.temp": 5 }); return `${who.label} gains 5 temp HP`;
    case "saveRoll": {
      if (trig.death) { await dnd.deathSave(who.actor, trig.outcome !== "success"); return `${who.label} rolls a death save`; }
      await dnd.save(who.actor, "dex", trig.outcome === "success" ? 1 : 30);
      return `${who.label} rolls a DEX save (${trig.outcome === "success" ? "DC 1" : "DC 30"})`;
    }
    case "checkRoll": await dnd.check(who.actor, "str", trig.outcome === "success" ? 1 : 30); return `${who.label} rolls a STR check`;
    case "heal": target(who.label === "ally" ? stage.tBench : stage.tAlly); await dnd.rollDamage(H.healing); return `${who.label} rolls healing`;
    case "dealDamage": target(foe); await dnd.rollDamage(H.damage); return `${who.label} rolls damage at the enemy`;
    case "attackHit":
      target(foe);
      await dnd.rollAttack(trig.cond?.type === "crit" ? H.critical : H.strike);
      return trig.cond?.type === "crit" ? `${who.label} attacks (crit on 2+)` : `${who.label} attacks at +50`;
    case "missedBy": target(who.token); await dnd.rollAttack(stage.helpers.claw); return `enemy attacks the ${who.label} at -50`;
    case "castSpell": case "spendResource": await dnd.use(H.spell); return `${who.label} casts a level 1 spell`;
    case "hitDie": await dnd.setHp(who.actor, 10); await dnd.hitDie(who.actor); return `${who.label} spends a Hit Die`;
    case "shortRest": await dnd.rest(who.actor, false); return `${who.label} takes a short rest`;
    case "longRest": await dnd.rest(who.actor, true); return `${who.label} takes a long rest`;
    case "initiative": {
      const combat = await Combat.implementation.create({ scene: stage.scene.id, active: true });
      const [cb] = await combat.createEmbeddedDocuments("Combatant", [{ tokenId: stage.tBench.id, sceneId: stage.scene.id, actorId: stage.bench.id }]);
      await cb.update({ initiative: 15 });
      return "bench's initiative is set";
    }
    default: return null;
  }
}

/* -------------------------------------------- */
/*  Scenarios                                   */
/* -------------------------------------------- */

/** One augment per trigger type (prefers ones with a roll), or every augment's every trigger. */
function pickScenarios(all) {
  const augs = game.items.filter(i => isAugment(i) && i.flags?.[MODULE_ID]?.auto?.triggers?.length);
  const list = [];
  for (const item of augs) {
    for (const trig of item.flags[MODULE_ID].auto.triggers) {
      const kind = trig.kinds[0];
      if (!TRIGGERS[kind]) continue;
      list.push({ item, trig, kind, score: (trig.activity ? 2 : 0) + (trig.cond ? 0 : 1) + (trig.requires ? 0 : 1) });
    }
  }
  if (all) return list;
  const best = new Map();
  for (const s of list) {
    const k = `${s.kind}${s.trig.death ? "/death" : ""}${s.trig.who === "ally" && s.trig.self === false ? "/ally" : ""}`;
    if (!best.has(k) || best.get(k).score < s.score) best.set(k, s);
  }
  return [...best.values()];
}

async function runScenario(stage, rec, s) {
  const result = { kind: s.kind, label: TRIGGERS[s.kind]?.label ?? s.kind, augment: s.item.name, scope: `${s.trig.who}${s.trig.range ? ` ${s.trig.range} ft` : ""}`, condition: s.trig.cond?.type ?? null, requires: s.trig.requires ?? null };
  await reset(stage);
  let copy;
  try {
    copy = await benchCopy(s.item);
    // Only this augment installed, so cards come from it alone.
    await stage.bench.setFlag(MODULE_ID, "slots", [copy.id]);
  } catch (e) {
    return { ...result, status: "setup failed", detail: `Couldn't put ${s.item.name} on the bench: ${e.message}` };
  }
  const m = rec.mark();
  let event = null;
  try {
    event = await perform(stage, copy, s.trig, s.kind);
  } catch (e) {
    const got = rec.since(m);
    return { ...result, status: "setup failed", detail: `Couldn't make the moment happen: ${e.message}`, logs: got.logs, errors: got.errors };
  }
  if (!event) return { ...result, status: "skipped", detail: "No automatic scenario for this trigger type." };
  await wait(900);
  const got = rec.since(m);
  const mine = got.cards.filter(c => c.itemUuid === copy.uuid);
  const status = mine.length ? "pass" : "no card";
  return { ...result, event, status, cards: mine, otherCards: got.cards.length - mine.length, logs: got.logs, errors: got.errors };
}

/* -------------------------------------------- */
/*  Full sweep: every augment, every part       */
/* -------------------------------------------- */

const readKey = (actor, key) => {
  const v = foundry.utils.getProperty(actor, key);
  return v instanceof Set ? JSON.stringify([...v].sort()) : JSON.stringify(v ?? null);
};

/** Use one ability the way a player would (no dialogs, no template placement), and roll what it rolls. */
async function tryActivity(stage, copy, act) {
  const out = { name: act.name, type: act.type };
  try {
    if (act.type === "heal") target(stage.tAlly); else target(stage.tEnemy);
    const usage = { consume: false, create: { measuredTemplate: false }, concentration: { begin: false } };
    await withTimeout(act.use(usage, { configure: false }, { create: true }), 8000, "Using it");
    if (act.type === "attack") await withTimeout(act.rollAttack({}, { configure: false }), 8000, "The attack roll");
    if (["attack", "damage", "save"].includes(act.type) && act.damage?.parts?.length) await withTimeout(act.rollDamage({}, { configure: false }), 8000, "The damage roll");
    if (act.type === "heal") await withTimeout(act.rollDamage({}, { configure: false }), 8000, "The healing roll");
    if (act.type === "utility" && act.roll?.formula) await withTimeout(act.rollFormula({}, { configure: false }), 8000, "The roll");
    out.ok = true;
  } catch (e) {
    out.ok = false;
    out.error = e.message;
  }
  return out;
}

async function sweepAugment(stage, rec, item) {
  const auto = item.flags?.[MODULE_ID]?.auto ?? {};
  const res = { augment: item.name, rarity: item.flags?.[MODULE_ID]?.rarity ?? "", builds: auto.summary ?? [], problems: [] };
  if (!auto.summary) res.problems.push("Never automated (run Update all augments).");
  await reset(stage);
  const m = rec.mark();
  // 1. Install it and check its always-on effects change the sheet.
  const passives = item.effects.filter(e => e.transfer && (e.flags?.[MODULE_ID]?.kind ?? "passive") === "passive" && e.changes?.length);
  const keys = [...new Set(passives.flatMap(e => e.changes.map(c => c.key)))];
  const before = Object.fromEntries(keys.map(k => [k, readKey(stage.bench, k)]));
  let copy = null;
  try {
    copy = await withTimeout(benchCopy(item), 10000, "Putting it on the bench");
    await stage.bench.setFlag(MODULE_ID, "slots", [copy.id]);
    await wait(250);
  } catch (e) {
    res.problems.push(`Couldn't install: ${e.message}`);
    return { ...res, ...rec.since(m) };
  }
  res.effects = keys.map(k => ({ key: k, before: before[k], after: readKey(stage.bench, k) }));
  for (const e of res.effects) if (e.before === e.after) res.problems.push(`Always-on effect didn't change the sheet: ${e.key}`);
  const offWhileOn = copy.effects.filter(e => e.transfer && (e.flags?.[MODULE_ID]?.kind ?? "passive") === "passive" && e.disabled);
  for (const e of offWhileOn) res.problems.push(`Always-on effect is switched off while installed: ${e.name}`);
  if (auto.choice) {
    await wait(600);
    if (!rec.since(m).cards.some(c => c.itemUuid === copy.uuid)) res.problems.push("Proficiency choice card didn't appear when installed.");
  }
  // 2. Use every ability it has.
  res.activities = [];
  for (const act of copy.system?.activities?.contents ?? []) {
    const r = await tryActivity(stage, copy, act);
    res.activities.push(r);
    if (!r.ok) res.problems.push(`Ability "${act.name}" failed: ${r.error}`);
  }
  // 3. Each moment it reacts to.
  res.triggers = [];
  for (const trig of auto.triggers ?? []) {
    const kind = trig.kinds?.[0];
    if (!TRIGGERS[kind]) continue;
    let r;
    try { r = await withTimeout(runScenario(stage, rec, { item, trig, kind }), 20000, "The trigger scenario"); } catch (e) { r = { status: "setup failed", detail: e.message }; }
    res.triggers.push({ kind, label: TRIGGERS[kind].label, status: r.status, event: r.event, buttons: r.cards?.[0]?.buttons ?? [], detail: r.detail ?? null, logs: r.logs ?? [] });
    if (r.status === "no card") res.problems.push(`No card ${TRIGGERS[kind].label} (${r.event ?? "event"}).`);
    else if (r.status === "setup failed") res.problems.push(`Couldn't test "${TRIGGERS[kind].label}": ${r.detail}`);
  }
  const got = rec.since(m);
  res.errors = got.errors;
  for (const e of got.errors) if (/augments/i.test(e)) res.problems.push(`Error: ${e.slice(0, 200)}`);
  res.status = res.problems.length ? "problems" : "ok";
  return res;
}

/* -------------------------------------------- */
/*  Runner                                      */
/* -------------------------------------------- */

export async function runSelfTest({ mode = "types", chat = "trim", resume = false } = {}) {
  if (!game.user.isGM) return ui.notifications.warn("Only the GM can run the self-test.");
  const rec = new Recorder();
  const settings = {};
  for (const k of ["triggerMode", "triggerDebug", "autoTargetAreas"]) { try { settings[k] = game.settings.get(MODULE_ID, k); } catch (e) { /* missing */ } }
  const sweep = mode === "everything";
  const augments = game.items.filter(isAugment).sort((a, b) => a.name.localeCompare(b.name));
  const scenarios = sweep ? [] : pickScenarios(mode === "triggers");
  const total = sweep ? augments.length : scenarios.length;
  if (!total) return ui.notifications.warn("Nothing to test. Import augments and run Update all augments first.");
  cancelRequested = false;
  let note = null;
  try { note = ui.notifications.info(`Augment self-test: setting up (${total} to test)...`, { progress: true }); } catch (e) { /* older Foundry */ }
  const stopBtn = showStopButton();
  let report = {
    created: new Date().toISOString(), foundry: game.version, system: `${game.system.id} ${game.system.version}`,
    module: game.modules.get(MODULE_ID)?.version, mode, settings, results: [], augments: [], finished: false
  };
  // Continue an unfinished run of the same kind: keep its results and skip what it already did.
  const saved = resume ? unfinishedRun() : null;
  if (saved?.mode === mode) report = { ...saved, resumed: (saved.resumed ?? 0) + 1, finished: false };
  const done = new Set(sweep ? report.augments.map(a => a.augment) : report.results.map(r => `${r.augment}|${r.kind}`));
  let stage = null;
  const bench = await getBench();
  const t0 = Date.now();
  const leftovers = await cleanupLeftovers(bench);
  if (leftovers) report.cleanedLeftovers = leftovers;
  rec.start();
  try {
    await game.settings.set(MODULE_ID, "triggerDebug", true);
    await game.settings.set(MODULE_ID, "triggerMode", "prompt");
    stage = await buildStage();
    report.stage = {
      bench: { disposition: stage.tBench.disposition, linked: stage.tBench.actorLink }, ally: { disposition: stage.tAlly.disposition }, enemy: { disposition: stage.tEnemy.disposition },
      canvasScene: canvas.scene?.name, gridDistance: canvas.scene?.grid?.distance,
      templates: !!CONFIG.MeasuredTemplate?.documentClass, regions: !!CONFIG.Region?.documentClass,
      hooks: { rollDamageV2: !!Hooks.events["dnd5e.rollDamageV2"], rollSavingThrow: !!Hooks.events["dnd5e.rollSavingThrow"], moveToken: !!Hooks.events.moveToken }
    };
    let ran = 0;
    for (let i = 0; i < total; i++) {
      if (cancelRequested) { report.stopped = `Stopped by the GM after ${i} of ${total}. Start it again with "Continue the unfinished run" to pick up here.`; break; }
      const key = sweep ? augments[i].name : `${scenarios[i].item.name}|${scenarios[i].kind}`;
      if (done.has(key)) continue;
      ran++;
      const name = sweep ? augments[i].name : `${scenarios[i].item.name} (${TRIGGERS[scenarios[i].kind]?.label ?? scenarios[i].kind})`;
      const eta = ran > 1 ? Math.round(((Date.now() - t0) / ran) * (total - i) / 60000) : null;
      try { note?.update?.({ pct: i / total, message: `Augment self-test: ${name}, ${i + 1} / ${total}${eta !== null ? ` (about ${eta} min left)` : ""}` }); } catch (e) { /* ignore */ }
      try {
        if (sweep) report.augments.push(await sweepAugment(stage, rec, augments[i]));
        else report.results.push(await runScenario(stage, rec, scenarios[i]));
      } catch (e) {
        (sweep ? report.augments : report.results).push({ augment: name, status: "setup failed", problems: [`Test crashed: ${e.message}`], detail: e.message });
      }
      if (ran % 10 === 0) {
        saveProgress(report);
        // Keep the chat light: only the latest cards stay while it runs.
        if (chat !== "keep" && rec.messages.length > 40) {
          const old = rec.messages.splice(0, rec.messages.length - 30);
          await deleteGently(old);
        }
      }
    }
    if (!report.stopped) report.finished = true;
    try { report.listening = triggerReport()?.rolls?.length ?? null; } catch (e) { /* ignore */ }
  } catch (e) {
    report.fatal = `${e.message}\n${e.stack ?? ""}`;
  } finally {
    rec.stop();
    stopBtn.remove();
    for (const [k, v] of Object.entries(settings)) await game.settings.set(MODULE_ID, k, v).catch(() => null);
    if (stage) await teardown(stage, bench);
    // "Delete all" also removes the last few kept for reading.
    if (chat === "delete" && rec.messages.length) await deleteGently(rec.messages);
    try { note?.update?.({ pct: 1, message: "Augment self-test: done" }); } catch (e) { /* ignore */ }
  }
  report.minutes = Math.round((Date.now() - t0) / 6000) / 10;
  report.summary = sweep ? {
    total: report.augments.length,
    ok: report.augments.filter(r => r.status === "ok").length,
    problems: report.augments.filter(r => r.status !== "ok").length,
    triggerPass: report.augments.flatMap(r => r.triggers ?? []).filter(t => t.status === "pass").length,
    triggerFail: report.augments.flatMap(r => r.triggers ?? []).filter(t => t.status !== "pass").length,
    abilityFail: report.augments.flatMap(r => r.activities ?? []).filter(a => !a.ok).length
  } : {
    total: report.results.length,
    pass: report.results.filter(r => r.status === "pass").length,
    noCard: report.results.filter(r => r.status === "no card").length,
    setupFailed: report.results.filter(r => r.status === "setup failed").length,
    skipped: report.results.filter(r => r.status === "skipped").length
  };
  saveProgress(report);
  downloadReport(report);
  showReport(report);
  return report;
}

function downloadReport(report) {
  const save = foundry.utils?.saveDataToFile ?? globalThis.saveDataToFile;
  save(JSON.stringify(report, null, 1), "application/json", `augment-selftest-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json`);
}

function showStopButton() {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "aug-selftest-stop";
  el.innerHTML = `<i class="fas fa-stop" inert></i> Stop self-test`;
  el.addEventListener("click", () => { el.disabled = true; stopSelfTest(); });
  document.body.append(el);
  return el;
}

/* -------------------------------------------- */
/*  Report window                               */
/* -------------------------------------------- */

/** Plain text of the problems (or everything), short enough to paste into a chat. */
function reportText(report, { problemsOnly = true } = {}) {
  const lines = [`Augment self-test (${report.mode}) ${report.created}`, `Foundry ${report.foundry}, ${report.system}, module ${report.module}`, `Summary: ${JSON.stringify(report.summary)}`];
  if (report.stage) lines.push(`Stage: ${JSON.stringify(report.stage)}`);
  if (report.fatal) lines.push(`FATAL: ${report.fatal}`);
  if (report.stopped) lines.push(report.stopped);
  lines.push("");
  if (report.mode === "everything") {
    for (const a of report.augments) {
      if (problemsOnly && a.status === "ok") continue;
      lines.push(`## ${a.augment} [${a.status}]`);
      for (const p of a.problems ?? []) lines.push(`- ${p}`);
      for (const t of a.triggers ?? []) if (t.status !== "pass") lines.push(...(t.logs ?? []).slice(-6).map(l => `    ${l}`));
      if (!problemsOnly) lines.push(`  builds: ${(a.builds ?? []).join("; ")}`);
    }
  } else {
    for (const r of report.results) {
      if (problemsOnly && r.status === "pass") continue;
      lines.push(`## ${r.label} | ${r.augment} [${r.status}] ${r.event ?? ""} ${r.detail ?? ""}`.trim());
      if (r.cards?.length) lines.push(`  card buttons: ${r.cards[0].buttons.join(" / ")}`);
      for (const l of (r.logs ?? []).slice(-8)) lines.push(`    ${l}`);
      for (const e of (r.errors ?? []).slice(0, 3)) lines.push(`    ${e}`);
    }
  }
  return lines.join("\n");
}

function reportRows(report) {
  if (report.mode === "everything") {
    return report.augments.map(a => ({
      ok: a.status === "ok", cells: [a.augment, a.status, (a.problems ?? []).join(" · ") || `${(a.activities ?? []).length} abilities, ${(a.triggers ?? []).length} moments OK`]
    }));
  }
  return report.results.map(r => ({
    ok: r.status === "pass", cells: [`${r.label ?? ""}`, r.augment, r.status, r.cards?.[0]?.buttons?.join(" / ") ?? r.detail ?? ""]
  }));
}

function showReport(report) {
  const sweep = report.mode === "everything";
  const s = report.summary ?? {};
  const head = sweep ? ["Augment", "Result", "Details"] : ["Moment", "Augment", "Result", "Card buttons / detail"];
  const rows = reportRows(report).map(r => `<tr class="${r.ok ? "st-ok" : "st-bad"}">${r.cells.map(c => `<td>${esc(c)}</td>`).join("")}</tr>`).join("");
  const line = sweep
    ? `<strong>${s.ok ?? 0}</strong> of ${s.total ?? 0} augments had no problems. Moments: ${s.triggerPass ?? 0} prompted, ${s.triggerFail ?? 0} didn't. Abilities that failed to roll: ${s.abilityFail ?? 0}.`
    : `<strong>${s.pass ?? 0}</strong> passed, <strong>${s.noCard ?? 0}</strong> gave no card, <strong>${s.setupFailed ?? 0}</strong> couldn't be set up${s.skipped ? `, ${s.skipped} skipped` : ""}.`;
  const content = `<div class="aug-selftest">
      <p>${line}${report.minutes ? ` Took ${report.minutes} min.` : ""}</p>
      ${report.fatal ? `<p class="st-fatal">The run stopped early: ${esc(report.fatal.split("\n")[0])}</p>` : ""}
      ${report.stopped ? `<p class="st-fatal">${esc(report.stopped)}</p>` : ""}
      <div class="st-tools">
        <label><input type="checkbox" data-st="filter" checked> Problems only</label>
        <span class="st-spacer"></span>
        <button type="button" data-st="copy"><i class="fas fa-copy" inert></i> Copy problems</button>
        <button type="button" data-st="copy-all"><i class="fas fa-clipboard" inert></i> Copy everything</button>
        <button type="button" data-st="download"><i class="fas fa-download" inert></i> Download report</button>
      </div>
      <div class="st-scroll"><table><thead><tr>${head.map(h => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>
    </div>`;
  const DialogV2 = foundry.applications?.api?.DialogV2;
  const bind = root => {
    const table = root.querySelector(".st-scroll");
    const filter = root.querySelector('[data-st="filter"]');
    const apply = () => table.classList.toggle("problems-only", filter.checked);
    filter.addEventListener("change", apply);
    apply();
    const copy = async text => {
      try { await navigator.clipboard.writeText(text); ui.notifications.info("Copied. Paste it into the chat."); }
      catch (e) {
        const ta = document.createElement("textarea");
        ta.value = text; document.body.append(ta); ta.select(); document.execCommand("copy"); ta.remove();
        ui.notifications.info("Copied.");
      }
    };
    root.querySelector('[data-st="copy"]').addEventListener("click", () => copy(reportText(report, { problemsOnly: true })));
    root.querySelector('[data-st="copy-all"]').addEventListener("click", () => copy(reportText(report, { problemsOnly: false })));
    root.querySelector('[data-st="download"]').addEventListener("click", () => downloadReport(report));
  };
  if (DialogV2) {
    const dlg = new DialogV2({
      window: { title: "Augment self-test report", resizable: true }, position: { width: 860, height: 680 },
      content, buttons: [{ action: "close", label: "Close", default: true }], rejectClose: false
    });
    dlg.render({ force: true }).then(() => bind(dlg.element));
  } else {
    new Dialog({ title: "Augment self-test report", content, buttons: { ok: { label: "Close" } }, render: html => bind(html[0] ?? html) }, { width: 860, height: 680, resizable: true }).render(true);
  }
}

/** Ask which run, then go. */
export async function openSelfTest() {
  if (!game.user.isGM) return ui.notifications.warn("Only the GM can run the self-test.");
  const unfinished = unfinishedRun();
  const content = `<p>This builds a temporary scene with the test bench, a friendly ally and a hostile enemy, makes augment
    moments really happen (damage, saves, turns, movement into areas, rests...) and checks what each augment does.
    Everything it creates is deleted afterwards, and a report is downloaded.</p>
    <p>It changes the active scene while it runs. Run it when players aren't in a session. A Stop button appears at the bottom of the screen.</p>
    <div class="form-group"><label><input type="radio" name="scope" value="types" checked> Quick: one augment per kind of moment (about a minute)</label></div>
    <div class="form-group"><label><input type="radio" name="scope" value="triggers"> Moments: every augment's every moment (several minutes)</label></div>
    <div class="form-group"><label><input type="radio" name="scope" value="everything"> Full sweep: every augment, installed, its effects checked, every ability rolled and every moment tested (can take an hour)</label></div>
    <p><strong>Chat:</strong></p>
    <div class="form-group"><label><input type="radio" name="chat" value="trim" checked> Keep the latest 30 cards to read, tidying older ones as it goes (recommended for long runs)</label></div>
    <div class="form-group"><label><input type="radio" name="chat" value="keep"> Keep every card (fine for Quick; long runs may slow the browser)</label></div>
    <div class="form-group"><label><input type="radio" name="chat" value="delete"> Delete all its cards, a few at a time, as it goes and at the end</label></div>
    ${unfinished ? `<div class="form-group"><label><input type="checkbox" name="resume" checked> Continue the unfinished ${esc(unfinished.mode === "everything" ? "full sweep" : unfinished.mode === "triggers" ? "moments run" : "quick run")} (${(unfinished.augments?.length || unfinished.results?.length) ?? 0} already done)</label></div>` : ""}`;
  const DialogV2 = foundry.applications?.api?.DialogV2;
  let choice = null;
  const read = root => ({
    // Continuing uses the unfinished run's own mode.
    mode: root.querySelector('[name="resume"]')?.checked ? unfinished.mode : root.querySelector('[name="scope"]:checked')?.value,
    chat: root.querySelector('[name="chat"]:checked')?.value ?? "trim",
    resume: !!root.querySelector('[name="resume"]')?.checked
  });
  if (DialogV2) {
    choice = await DialogV2.prompt({
      window: { title: "Augment self-test" }, content, rejectClose: false,
      ok: { label: "Run", icon: "fas fa-play", callback: (event, button) => read(button.form) }
    });
  } else {
    choice = await Dialog.prompt({ title: "Augment self-test", content, rejectClose: false, callback: html => read(html[0] ?? html) });
  }
  if (choice?.mode) return runSelfTest(choice);
}
