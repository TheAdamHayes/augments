import { MODULE_ID, getEffectText } from "./core.js";

/**
 * Reads an augment's effect text and turns recognised phrases into dnd5e data:
 *  - "PB uses per short rest", "Once per long rest", "2 x PB uses..." -> limited uses
 *  - "As a bonus action", "use your reaction", "As an action"         -> an activity with that activation
 *  - "+2d6 damage", "2d8 thunder damage", "damage equal to PB"         -> damage rolls
 *  - "1d6 + PB temporary hit points"                                   -> temp HP roll
 *  - "on a failed Dexterity save"                                      -> save activity (DC 8 + PB + Con)
 *  - "walking speed increases by 5 feet", "+2 to initiative", "+1 AC",
 *    "20-foot climbing speed", "hover", "resistance to fire damage",
 *    "advantage on Dexterity saves", "become invisible"                -> active effects
 * Always-on sentences become a passive effect. Sentences starting with "While/When/After..."
 * become a disabled effect the player can toggle on. Effects inside an activated sentence are
 * applied when the activity is used.
 */

/** Ability used for augment save DCs (8 + PB + this modifier). */
export const SAVE_DC_ABILITY = "con";

const DAMAGE_TYPES = ["acid", "bludgeoning", "cold", "fire", "force", "lightning", "necrotic", "piercing", "poison", "psychic", "radiant", "slashing", "thunder"];
const ABILITIES = { strength: "str", dexterity: "dex", constitution: "con", intelligence: "int", wisdom: "wis", charisma: "cha" };
const MOVEMENT = { climbing: "climb", flying: "fly", swimming: "swim", burrowing: "burrow" };
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5 };

const ACTIVATIONS = [
  [/\bas a bonus action\b/i, "bonus"],
  [/\b(?:use your reaction|as a reaction)\b/i, "reaction"],
  [/\bas an action\b/i, "action"],
  [/\bat the end of another creature's turn\b/i, "special"]
];
const USES_ONLY_RE = /^(?:\d+\s*[x×*]\s*)?PB uses per (?:short|long) rest|^once per (?:short|long) rest\.?$/i;

function modes() {
  return globalThis.CONST?.ACTIVE_EFFECT_MODES ?? { ADD: 2, UPGRADE: 4, OVERRIDE: 5 };
}

function rid() {
  if (globalThis.foundry?.utils?.randomID) return foundry.utils.randomID();
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  return Array.from({ length: 16 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

const pb = s => String(s).replace(/\bPB\b/g, "@prof").replace(/\s*[x×]\s*/g, " * ");

function splitSentences(text) {
  return text.split(/(?<=[.!?])\s+(?=[A-Z])/).map(s => s.trim()).filter(Boolean);
}

/* -------------------------------------------- */
/*  Phrase parsers                              */
/* -------------------------------------------- */

function parseUses(text) {
  let m = text.match(/(?:(\d+)\s*[x×*]\s*)?PB uses per (short|long) rest/i);
  if (m) return { max: m[1] ? `${m[1]} * @prof` : "@prof", period: m[2].toLowerCase() === "short" ? "sr" : "lr" };
  m = text.match(/\bonce per (short|long) rest/i);
  if (m) return { max: "1", period: m[1].toLowerCase() === "short" ? "sr" : "lr" };
  m = text.match(/\b(\d+|one|two|three|four|five) (?:times|uses) per (short|long) rest/i);
  if (m) return { max: String(NUMBER_WORDS[m[1].toLowerCase()] ?? m[1]), period: m[2].toLowerCase() === "short" ? "sr" : "lr" };
  if (/\bonce per day\b/i.test(text)) return { max: "1", period: "lr" };
  return null;
}

function detectActivation(sentence) {
  for (const [re, type] of ACTIVATIONS) if (re.test(sentence)) return type;
  return null;
}

function parseDamage(text) {
  const parts = [];
  const re = /\+?(\d+)d(\d+)(\s*\+\s*PB)?\s+(?:(\w+)\s+)?damage/gi;
  let m;
  while ((m = re.exec(text))) {
    const type = m[4]?.toLowerCase();
    parts.push({
      number: Number(m[1]), denomination: Number(m[2]), bonus: m[3] ? "@prof" : "",
      types: DAMAGE_TYPES.includes(type) ? [type] : [], custom: { enabled: false, formula: "" }
    });
  }
  if (/damage equal to (?:your )?PB\b/i.test(text)) {
    parts.push({ number: null, denomination: null, bonus: "", types: [], custom: { enabled: true, formula: "@prof" } });
  }
  return parts;
}

function parseTempHP(text) {
  const m = text.match(/(\d+d\d+(?:\s*\+\s*PB)?|PB)\s+temporary hit points/i);
  return m ? pb(m[1]) : null;
}

function parseSave(text) {
  const m = text.match(/(strength|dexterity|constitution|intelligence|wisdom|charisma) sav(?:e|ing throw)/i);
  if (!m || /advantage on/i.test(text.slice(Math.max(0, m.index - 20), m.index))) return null;
  return ABILITIES[m[1].toLowerCase()];
}

function parseRange(text) {
  const m = text.match(/within (\d+) feet/i);
  return m ? { units: "ft", value: m[1] } : null;
}

function parseDuration(text) {
  let m = text.match(/\bfor (\d+) (minute|hour|round)s?\b/i);
  if (m) return { units: m[2].toLowerCase(), value: m[1] };
  if (/until (?:the start of )?your next turn/i.test(text)) return { units: "round", value: "1" };
  if (/until the end of (?:your|the|that) turn|for that turn/i.test(text)) return { units: "turn", value: "1" };
  return null;
}

function parseTarget(text) {
  if (/up to PB (?:willing )?creatures/i.test(text)) return { affects: { type: "creature", count: "@prof" } };
  if (/\b(?:choose|one) (?:willing )?ally\b|\ban ally within\b/i.test(text)) return { affects: { type: "ally", count: "1" } };
  if (/\b(?:a|one) willing creature\b/i.test(text)) return { affects: { type: "willing", count: "1" } };
  if (/\b(?:mark|tether|choose) an? (?:\w+ )?(?:or smaller )?creature\b/i.test(text)) return { affects: { type: "creature", count: "1" } };
  return null;
}

/** Sentences about allies or other creatures shouldn't give the wearer effects. */
function targetsOthers(s) {
  return /\b(ally|allies|it gains|each gains|carried creature|the target gains)\b/i.test(s) && !/\byou and\b/i.test(s);
}

function isConditional(s) {
  return /^(while|when|whenever|after|if|once per turn|the first time|until|during|at the (?:start|end))\b/i.test(s) || /\bwhile\b/i.test(s);
}

function conditionLabel(s) {
  const clause = s.split(/,/)[0].trim().replace(/\.$/, "");
  return clause.length > 48 ? `${clause.slice(0, 45)}...` : clause;
}

/* -------------------------------------------- */
/*  Active effect changes                       */
/* -------------------------------------------- */

function extractChanges(s) {
  const M = modes();
  const changes = [];
  const statuses = [];
  const add = (key, mode, value) => changes.push({ key, mode, value: String(value), priority: null });
  let m;

  if ((m = s.match(/walking speed increases by (\d+) feet/i))) add("system.attributes.movement.walk", M.ADD, m[1]);
  else if ((m = s.match(/\+(\d+) feet (?:of )?(?:walking )?speed/i))) add("system.attributes.movement.walk", M.ADD, m[1]);

  for (const mm of s.matchAll(/(\d+)-foot (climbing|flying|swimming|burrowing) speed/gi)) {
    add(`system.attributes.movement.${MOVEMENT[mm[2].toLowerCase()]}`, M.UPGRADE, mm[1]);
  }
  if ((m = s.match(/\+(\d+) (?:bonus )?to initiative/i))) add("system.attributes.init.bonus", M.ADD, m[1]);
  if ((m = s.match(/\+(\d+) (?:bonus to )?AC\b/i))) add("system.attributes.ac.bonus", M.ADD, `+${m[1]}`);
  for (const mm of s.matchAll(/resistance to (\w+) damage/gi)) {
    const type = mm[1].toLowerCase();
    if (DAMAGE_TYPES.includes(type)) add("system.traits.dr.value", M.ADD, type);
  }
  for (const mm of s.matchAll(/advantage on (strength|dexterity|constitution|intelligence|wisdom|charisma) sav(?:es|ing throws)/gi)) {
    add(`system.abilities.${ABILITIES[mm[1].toLowerCase()]}.save.roll.mode`, M.ADD, 1);
  }
  if (/\bhover\b/i.test(s)) add("system.attributes.movement.hover", M.OVERRIDE, true);
  if (/speed becomes 0/i.test(s)) add("system.attributes.movement.walk", M.OVERRIDE, 0);
  if (/count as one size larger for (?:lifting|carrying)/i.test(s)) add("flags.dnd5e.powerfulBuild", M.OVERRIDE, true);
  if (/\bbecomes? invisible\b/i.test(s)) statuses.push("invisible");

  return { changes, statuses };
}

function describeChanges({ changes, statuses }) {
  const out = changes.map(c => {
    const k = c.key;
    if (k.endsWith("movement.walk")) return c.value === "0" ? "speed 0" : `+${c.value} ft speed`;
    if (k.includes("movement.hover")) return "hover";
    const mv = k.match(/movement\.(\w+)$/);
    if (mv) return `${c.value} ft ${mv[1]}`;
    if (k.endsWith("init.bonus")) return `+${c.value} initiative`;
    if (k.endsWith("ac.bonus")) return `${c.value} AC`;
    if (k.endsWith("dr.value")) return `${c.value} resistance`;
    const sv = k.match(/abilities\.(\w+)\.save/);
    if (sv) return `adv. ${sv[1].toUpperCase()} saves`;
    if (k.includes("powerfulBuild")) return "powerful build";
    return k;
  });
  return out.concat(statuses).join(", ");
}

/* -------------------------------------------- */
/*  Builders                                    */
/* -------------------------------------------- */

function durationSeconds(d) {
  if (!d) return {};
  const v = Number(d.value) || 1;
  if (d.units === "minute") return { seconds: v * 60 };
  if (d.units === "hour") return { seconds: v * 3600 };
  if (d.units === "round") return { rounds: v };
  if (d.units === "turn") return { turns: v };
  return {};
}

function makeEffect(name, ext, { transfer, disabled = false, img, description = "", duration = null }) {
  return {
    _id: rid(), name, img: img || "icons/svg/aura.svg", transfer, disabled,
    changes: ext.changes, statuses: ext.statuses, description,
    duration: durationSeconds(duration), flags: { [MODULE_ID]: { auto: true } }
  };
}

function makeActivity({ name, activation, condition = "", parts = [], temphp = null, save = null, range = null, duration = null, target = null, consume = false }) {
  const type = save ? "save" : temphp ? "heal" : parts.length ? "damage" : "utility";
  const act = {
    _id: rid(), type, name,
    activation: { type: activation, value: ["action", "bonus", "reaction"].includes(activation) ? 1 : null, condition, override: false },
    consumption: { targets: consume ? [{ type: "itemUses", target: "", value: "1", scaling: {} }] : [], scaling: { allowed: false, max: "" } }
  };
  if (duration) act.duration = { ...duration, concentration: false, override: false };
  if (range) act.range = { ...range, override: false };
  if (target) act.target = { ...target, override: false };
  if (type === "save") {
    act.save = { ability: [save], dc: { calculation: SAVE_DC_ABILITY, formula: "" } };
    act.damage = { onSave: "none", parts };
  } else if (type === "heal") {
    act.healing = { number: null, denomination: null, bonus: "", types: ["temphp"], custom: { enabled: true, formula: temphp } };
  } else if (type === "damage") {
    act.damage = { critical: { allow: true }, parts };
  }
  return act;
}

function describeActivity(act) {
  const when = { bonus: "Bonus action", reaction: "Reaction", action: "Action", special: "Triggered" }[act.activation.type] ?? "Activity";
  let what = "";
  if (act.type === "damage" || act.type === "save") {
    const dice = act.damage.parts.map(p => p.custom?.enabled ? "PB" : `${p.number}d${p.denomination}${p.types[0] ? ` ${p.types[0]}` : ""}`);
    if (act.type === "save") what = `${act.save.ability[0].toUpperCase()} save`;
    if (dice.length) what += `${what ? ", " : ""}${dice.join(" + ")}`;
  } else if (act.type === "heal") what = `${act.healing.custom.formula.replace("@prof", "PB")} temp HP`;
  return what ? `${when} (${what})` : when;
}

/* -------------------------------------------- */
/*  Public API                                  */
/* -------------------------------------------- */

/** Analyse effect text. Returns plain data plus a human-readable summary of what was automated. */
export function analyzeEffect(text, { name = "Augment", img = null } = {}) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  const result = { uses: null, activities: [], effects: [], summary: [] };
  if (!clean) return result;

  const sentences = splitSentences(clean);
  result.uses = parseUses(clean);
  const isUsesSentence = s => USES_ONLY_RE.test(s);
  const actIndex = sentences.findIndex(s => detectActivation(s));
  const before = actIndex < 0 ? sentences : sentences.slice(0, actIndex);
  const block = actIndex < 0 ? [] : sentences.slice(actIndex).filter(s => !isUsesSentence(s));

  const passive = { changes: [], statuses: [] };
  const riders = [];
  let lastCondition = null;

  const addToggle = (s, ext) => {
    // "After moving 20 feet... Until your next turn, gain +1 AC": label with the trigger, not "Until..."
    const label = (/^until\b/i.test(s) && lastCondition) ? lastCondition : conditionLabel(s);
    result.effects.push(makeEffect(`${name} (${label})`, ext, { transfer: true, disabled: true, img, description: s }));
    result.summary.push(`Toggle "${label}": ${describeChanges(ext)}`);
  };

  for (const s of before) {
    if (isUsesSentence(s)) continue;
    const ext = targetsOthers(s) ? { changes: [], statuses: [] } : extractChanges(s);
    if (ext.changes.length || ext.statuses.length) {
      if (isConditional(s)) {
        addToggle(s, ext);
      } else {
        passive.changes.push(...ext.changes);
        passive.statuses.push(...ext.statuses);
      }
    }
    if (isConditional(s) && !/^until\b/i.test(s)) lastCondition = conditionLabel(s);
    const parts = parseDamage(s);
    const temphp = parseTempHP(s);
    if (parts.length || temphp) {
      riders.push(makeActivity({
        name: parts.length ? `${name}: Bonus damage` : `${name}: Temporary HP`,
        activation: "special", condition: conditionLabel(s), parts, temphp
      }));
    }
  }

  if (passive.changes.length || passive.statuses.length) {
    result.effects.unshift(makeEffect(name, passive, { transfer: true, img }));
    result.summary.unshift(`Passive: ${describeChanges(passive)}`);
  }

  let main = null;
  if (block.length) {
    const text = block.join(" ");
    const duration = parseDuration(text);
    main = makeActivity({
      name, activation: detectActivation(block[0]),
      parts: parseDamage(text), temphp: parseTempHP(text), save: parseSave(text),
      range: parseRange(text), duration, target: parseTarget(text), consume: !!result.uses
    });
    const ext = extractChanges(block.filter(s => !targetsOthers(s)).join(" "));
    // "While airborne, gain +10 feet speed... and may use your reaction": the bonuses are a
    // persistent state, so they become a toggle rather than something the reaction applies.
    if (/^while\b/i.test(block[0]) && (ext.changes.length || ext.statuses.length)) {
      addToggle(block[0], ext);
    } else if (ext.changes.length || ext.statuses.length) {
      const eff = makeEffect(name, ext, { transfer: false, img, duration, description: text });
      result.effects.push(eff);
      main.effects = [{ _id: eff._id }];
    }
    result.activities.push(main);
    result.summary.push(`${describeActivity(main)}${main.effects ? `, applies ${describeChanges(ext)}` : ""}`);
  }

  for (const r of riders) {
    result.activities.push(r);
    result.summary.push(describeActivity(r));
  }

  // Limited uses with no activated ability: riders spend the uses, or add a tracker activity.
  if (result.uses && !main) {
    if (riders.length) {
      for (const r of riders) r.consumption.targets = [{ type: "itemUses", target: "", value: "1", scaling: {} }];
    } else {
      const tracker = makeActivity({ name, activation: "special", condition: conditionLabel(sentences[0]), consume: true });
      result.activities.push(tracker);
      result.summary.push("Use tracker");
    }
  }

  if (result.uses) {
    const max = result.uses.max.replace("@prof", "PB");
    result.summary.unshift(`Uses: ${max} per ${result.uses.period === "sr" ? "short" : "long"} rest`);
  }
  return result;
}

/** Convert an analysis into item creation data (system fields + embedded effects + bookkeeping flag). */
export function automationData(result, itemType = "equipment") {
  const supportsActivities = ["equipment", "consumable", "weapon", "tool"].includes(itemType);
  const system = {};
  const activities = supportsActivities ? result.activities : [];
  if (supportsActivities && result.uses) {
    system.uses = { max: result.uses.max, spent: 0, recovery: [{ period: result.uses.period, type: "recoverAll" }] };
  }
  if (activities.length) system.activities = Object.fromEntries(activities.map(a => [a._id, a]));
  return {
    system,
    effects: result.effects,
    flag: { activities: activities.map(a => a._id), effects: result.effects.map(e => e._id), summary: result.summary }
  };
}

/** (Re)build automation on an existing item. Only replaces things this module generated before. */
export async function applyAutomation(item, text = null) {
  const effectText = text ?? getEffectText(item);
  const result = analyzeEffect(effectText, { name: item.name, img: item.img });
  const data = automationData(result, item.type);
  const prev = item.flags?.[MODULE_ID]?.auto ?? {};

  for (const id of prev.activities ?? []) {
    const activity = item.system.activities?.get?.(id);
    if (activity?.delete) await activity.delete();
  }
  const oldEffects = (prev.effects ?? []).filter(id => item.effects.has(id));
  if (oldEffects.length) await item.deleteEmbeddedDocuments("ActiveEffect", oldEffects);

  const update = { [`flags.${MODULE_ID}.auto`]: data.flag };
  if (data.system.uses) update["system.uses"] = data.system.uses;
  for (const [id, act] of Object.entries(data.system.activities ?? {})) update[`system.activities.${id}`] = act;
  await item.update(update);
  if (data.effects.length) await item.createEmbeddedDocuments("ActiveEffect", data.effects, { keepId: true });

  ui.notifications.info(result.summary.length
    ? `${item.name}: ${result.summary.join("; ")}`
    : `${item.name}: nothing in the effect text could be automated.`);
  return result;
}
