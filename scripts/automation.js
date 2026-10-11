import { MODULE_ID, getEffectText, equippedBy } from "./core.js";
import { applyStackValue } from "./stacks.js";

/**
 * Reads an augment's effect text and turns recognised phrases into dnd5e data:
 *  - "PB uses per short rest", "Once per long rest", "Usable twice per long rest" -> limited uses
 *  - "As a bonus action", "use your reaction", "As an action"                    -> an activity with that activation
 *  - "+2d6 damage", "add PB acid damage", "damage equal to PB"                    -> damage rolls
 *  - "1d6 + PB temporary hit points"                                              -> temp HP roll
 *  - "on a failed Dexterity save"                                                 -> save activity (DC 8 + PB + Con)
 *  - speed, initiative, AC, climb/fly speeds, hover, resistances, save advantage  -> active effects on the user
 *  - "you gain 1 Redline (maximum 3)" + "per Redline" rules                       -> a stack counter with scaling
 *  - "it gains a 30-foot flying speed", "reduce its AC by 2", "mark a creature"   -> effects to apply to others
 * Anything else becomes a tagged reminder shown in chat when the augment is used.
 */

/** Ability used for augment save DCs (8 + PB + this modifier). */
export const SAVE_DC_ABILITY = "con";

const DAMAGE_TYPES = ["acid", "bludgeoning", "cold", "fire", "force", "lightning", "necrotic", "piercing", "poison", "psychic", "radiant", "slashing", "thunder"];
const ABILITIES = { strength: "str", dexterity: "dex", constitution: "con", intelligence: "int", wisdom: "wis", charisma: "cha" };
const MOVEMENT = { climbing: "climb", flying: "fly", swimming: "swim", burrowing: "burrow" };
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, once: 1, twice: 2, "three times": 3, "four times": 4 };

const ACTIVATIONS = [
  [/\b(?:as a bonus action|use your bonus action)\b/i, "bonus"],
  [/\b(?:use your reaction|as a reaction)\b/i, "reaction"],
  [/\b(?:as an action|use your action)\b/i, "action"],
  [/\bat the end of another creature's turn\b/i, "special"]
];
const USES_ONLY_RE = /^(?:\d+\s*[x×*]\s*)?PB uses per (?:short|long) rest|^once per (?:short|long) rest\.?$|^usable (?:once|twice|three times|four times|\d+ times)\b/i;

/** Reminder tags: what a player has to handle by hand. Order = display order. */
const MANUAL_TAGS = [
  ["Movement", /\b(?:move|teleport|leap|propel|pull yourself|rise|ascend|descend|swap places|fly up to|stop instantly|glide)\b/i],
  ["Opportunity attacks", /\bopportunity attacks?\b/i],
  ["Forced movement", /\b(?:push(?:ed)?|pull(?:ed)?|knocked prone|tether(?:ed)?|forced movement|forcibly moved)\b/i],
  ["Target", /\b(?:its|their) (?:AC|speed)\b|\bprevent (?:the target|it)\b|\b(?:it|the target) (?:cannot|can't)\b|\bprime\b|\bmark\b/i],
  ["Allies", /\ball(?:y|ies)\b/i],
  ["Damage rules", /\bignores?\b|\bis ignored\b|\bimmunity\b|\bdoubled\b|\bchange (?:that|one attack's|the) damage|\breduce (?:it|that|the triggering|falling damage)\b|\btwice that amount\b/i],
  ["Advantage", /\b(?:dis)?advantage\b/i],
  ["Stealth", /\bHide\b|\bdecoy\b|\bhidden\b/],
  ["Cover", /\bcover\b/i],
  ["Resource", /\bregain\b|\bexpend\b|\bHit Dice\b/i]
];

function modes() {
  return globalThis.CONST?.ACTIVE_EFFECT_MODES ?? { ADD: 2, UPGRADE: 4, OVERRIDE: 5 };
}

function rid() {
  if (globalThis.foundry?.utils?.randomID) return foundry.utils.randomID();
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  return Array.from({ length: 16 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

const pb = s => String(s).replace(/\bPB\b/g, "@prof").replace(/\s*[x×]\s*/g, " * ");
const escapeRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Tidy whitespace, drop **bold** markers and turn "20 ft." into "20 feet". */
function normalize(text) {
  return String(text ?? "").replace(/\*\*/g, "").replace(/\s+/g, " ").trim()
    .replace(/(\d+)\s*ft\.(?=\s+[A-Z]|\s*$)/g, "$1 feet.")
    .replace(/(\d+)\s*ft\.?/g, "$1 feet");
}

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
  m = text.match(/\b(once|twice|three times|four times|(\d+) times) per (short or long|short|long) rest/i);
  if (m) return { max: String(m[2] ?? NUMBER_WORDS[m[1].toLowerCase()]), period: /^short/i.test(m[3]) ? "sr" : "lr" };
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
  for (const mm of text.matchAll(/(?:\badd|\bdeals?|\btakes?|\+)\s*PB (?:(\w+) )?damage\b/gi)) {
    const type = mm[1]?.toLowerCase();
    parts.push({ number: null, denomination: null, bonus: "", types: DAMAGE_TYPES.includes(type) ? [type] : [], custom: { enabled: true, formula: "@prof" } });
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
  return /\b(ally|allies|it gains|each gains|they gain|carried creature|the target gains)\b/i.test(s) && !/\byou and\b/i.test(s);
}

/** Stacking rules with no named resource we can track stay as reminders. */
function isStacking(s) {
  return /\bfor each\b|\bper (?!turn\b|round\b|short\b|long\b|day\b|rest\b)[a-z]+\b(?! of)/i.test(s) && !/\bper (?:short|long) rest\b/i.test(s);
}

function isConditional(s) {
  return /^(while|when|whenever|after|if|once per turn|the first time|until|during|at the (?:start|end))\b/i.test(s) || /\bwhile\b/i.test(s);
}

function conditionLabel(s) {
  const clause = s.split(/,/)[0].trim().replace(/\.$/, "");
  return clause.length > 48 ? `${clause.slice(0, 45)}...` : clause;
}

function manualTags(s) {
  // "advantage on Dexterity saves" is automated, so it isn't a reminder.
  const t = s.replace(/advantage on (?:strength|dexterity|constitution|intelligence|wisdom|charisma) sav(?:es|ing throws)/gi, "");
  return MANUAL_TAGS.filter(([, re]) => re.test(t)).map(([tag]) => tag);
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

  if ((m = s.match(/(?:walking )?speed increases by (\d+) feet/i))) add("system.attributes.movement.walk", M.ADD, m[1]);
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

export function describeChanges({ changes = [], statuses = [] }) {
  const out = changes.map(c => {
    const k = c.key;
    const v = String(c.value);
    if (k.endsWith("movement.walk")) return v === "0" ? "speed 0" : `${v.startsWith("-") ? v : `+${v}`} ft speed`;
    if (k.includes("movement.hover")) return "hover";
    const mv = k.match(/movement\.(\w+)$/);
    if (mv) return `${v} ft ${mv[1]}`;
    if (k.endsWith("init.bonus")) return `+${v} initiative`;
    if (k.endsWith("ac.bonus")) return `${v.startsWith("-") || v.startsWith("+") ? v : `+${v}`} AC`;
    if (k.endsWith("dr.value")) return `${v} resistance`;
    const sv = k.match(/abilities\.(\w+)\.save/);
    if (sv) return `adv. ${sv[1].toUpperCase()} saves`;
    if (k.includes("powerfulBuild")) return "powerful build";
    return k;
  });
  return out.concat(statuses).join(", ");
}

/** Effects for other creatures: allies gaining things, enemies losing things, or a plain marker. */
function extractTargetEffect(s) {
  const M = modes();
  const ext = { changes: [], statuses: [] };
  let label = null;
  let m;

  const ally = /\b(?:it|each|they|the carried creature)\s+(?:gains?|has|have)\b/i.test(s)
    || /\ballies\b[^.]*\bgain\b/i.test(s) || /\byou and allies\b/i.test(s);
  if (ally) {
    const e = extractChanges(s);
    ext.changes.push(...e.changes.filter(c => !c.key.endsWith("movement.walk") || c.value !== "0"));
    ext.statuses.push(...e.statuses);
    if (ext.changes.length || ext.statuses.length) label = "for allies";
  }
  if ((m = s.match(/(?:its|their) AC (?:is )?reduced by (\d+)|reduce (?:its|their) AC by (\d+)|AC is reduced by (\d+)/i))) {
    const n = m[1] ?? m[2] ?? m[3];
    ext.changes.push({ key: "system.attributes.ac.bonus", mode: M.ADD, value: `-${n}`, priority: null });
    label = `-${n} AC`;
  }
  if ((m = s.match(/reduce (?:its|their) speed by (\d+) feet|(?:its|their) speed (?:is )?reduced by (\d+) feet/i))) {
    const n = m[1] ?? m[2];
    ext.changes.push({ key: "system.attributes.movement.walk", mode: M.ADD, value: `-${n}`, priority: null });
    label ??= `-${n} ft speed`;
  }
  if (/\bknocked prone\b/i.test(s) && !/\bagainst being\b/i.test(s)) {
    ext.statuses.push("prone");
    label ??= "Prone";
  }

  let marker = null;
  if (/\b(?:it|the target|they) (?:cannot|can't) make opportunity attacks/i.test(s)) marker = "No opportunity attacks";
  else if (/\bprevent (?:the target|it) from regaining hit points/i.test(s)) marker = "Can't regain hit points";
  else if (/\btether\b/i.test(s)) marker = "Tethered";
  else if (/\bmark (?:a|the|one) (?:\w+ )?creature\b/i.test(s)) marker = "Marked";
  else if (/\bprime it\b/i.test(s)) marker = "Primed";
  else if (/\blink up to\b/i.test(s)) marker = "Linked";

  if (!label && !marker) return null;
  return { ext, label: label ?? marker };
}

/* -------------------------------------------- */
/*  Stacks ("you gain 1 Redline (maximum 3)")   */
/* -------------------------------------------- */

function detectStack(sentences) {
  for (const s of sentences) {
    const m = s.match(/\bgain (?:1|one|a) ([A-Z][A-Za-z'-]+)\b(?: (?:stack|charge|point)s?)?(?:\s*\((?:to a )?max(?:imum)?\.?\s*(?:of )?(\d+|PB)\))?/);
    if (!m) continue;
    const timing = /\bat the end of your turn\b/i.test(s) ? "end" : /\bat the start of your turn\b/i.test(s) ? "start" : "manual";
    return { name: m[1], max: m[2] ? (m[2] === "PB" ? "@prof" : m[2]) : null, timing, gainText: s };
  }
  return null;
}

function buildStack(stack, stackSentences, { name, img }) {
  const N = escapeRe(stack.name);
  const covered = new Set();
  let effect = null;
  let activity = null;
  for (const s of stackSentences) {
    let m = s.match(new RegExp(`for each ${N}, your (?:walking )?speed increases by (\\d+) feet`, "i"))
      ?? s.match(new RegExp(`speed increases by (\\d+) feet (?:for each|per) ${N}`, "i"));
    if (m) {
      stack.speedPer = Number(m[1]);
      covered.add(s);
    }
    m = s.match(new RegExp(`(\\d+)d(\\d+) (?:extra |additional )?(?:(\\w+) )?damage (?:per|for each) ${N}`, "i"));
    if (m) {
      const type = m[3]?.toLowerCase();
      stack.damage = { number: Number(m[1]), denomination: Number(m[2]), type: DAMAGE_TYPES.includes(type) ? type : null };
      stack.damageCondition = conditionLabel(s);
      covered.add(s);
    }
    if (new RegExp(`\\blose all ${N}\\b`, "i").test(s)) stack.loseText = s;
  }
  if (stack.speedPer) {
    const M = modes();
    effect = makeEffect(`${name} (${stack.name})`,
      { changes: [{ key: "system.attributes.movement.walk", mode: M.ADD, value: "0", priority: null }], statuses: [] },
      { transfer: true, disabled: true, img, kind: "stack", description: `+${stack.speedPer} ft speed per ${stack.name}` });
    stack.effectId = effect._id;
  }
  if (stack.damage) {
    activity = makeActivity({
      name: `${name}: ${stack.name} damage`, activation: "special", condition: stack.damageCondition,
      parts: [{ number: null, denomination: null, bonus: "", types: stack.damage.type ? [stack.damage.type] : [], custom: { enabled: true, formula: "0" } }]
    });
    stack.activityId = activity._id;
  }
  return { covered, effect, activity };
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

/**
 * kind: "passive" (always on while socketed), "toggle" (player switches on), "self" (applied by an
 * activity to the user), "target" (dragged or applied onto others), "stack" (scales with stacks).
 */
function makeEffect(name, ext, { transfer, disabled = false, img, description = "", duration = null, kind = "passive" }) {
  return {
    _id: rid(), name, img: img || "icons/svg/aura.svg", transfer, disabled,
    changes: ext.changes, statuses: ext.statuses, description,
    duration: durationSeconds(duration), flags: { [MODULE_ID]: { auto: true, kind } }
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
    const dice = act.damage.parts.map(p => p.custom?.enabled ? p.custom.formula.replace("@prof", "PB") : `${p.number}d${p.denomination}${p.types[0] ? ` ${p.types[0]}` : ""}`);
    if (act.type === "save") what = `${act.save.ability[0].toUpperCase()} save`;
    if (dice.length) what += `${what ? ", " : ""}${dice.join(" + ")}`;
  } else if (act.type === "heal") what = `${act.healing.custom.formula.replace("@prof", "PB")} temp HP`;
  return what ? `${when} (${what})` : when;
}

/* -------------------------------------------- */
/*  Public API                                  */
/* -------------------------------------------- */

/** Analyse effect text. Returns plain data plus a summary and the reminders shown in chat. */
export function analyzeEffect(text, { name = "Augment", img = null } = {}) {
  const clean = normalize(text);
  const result = { uses: null, activities: [], effects: [], summary: [], reminders: [], stack: null };
  if (!clean) return result;

  const allSentences = splitSentences(clean);
  let sentences = allSentences;
  result.uses = parseUses(clean);
  const isUsesSentence = s => USES_ONLY_RE.test(s);
  const produced = new Set();
  const handledTags = new Map(); // sentence -> tags already handled by automation
  const markHandled = (s, tags) => handledTags.set(s, [...(handledTags.get(s) ?? []), ...tags]);

  // Stacks
  let stackParts = null;
  let stackSentences = [];
  const stack = detectStack(sentences);
  if (stack) {
    const nameRe = new RegExp(`\\b${escapeRe(stack.name)}\\b`);
    stackSentences = sentences.filter(s => nameRe.test(s));
    sentences = sentences.filter(s => !nameRe.test(s));
    stackParts = buildStack(stack, stackSentences, { name, img });
    for (const s of stackParts.covered) produced.add(s);
    result.stack = stack;
    const bits = [`Stacks: ${stack.name}${stack.max ? ` (max ${stack.max.replace("@prof", "PB")})` : ""}`];
    if (stack.speedPer) bits.push(`+${stack.speedPer} ft speed each`);
    if (stack.damage) bits.push(`${stack.damage.number}d${stack.damage.denomination} damage each`);
    result.summary.push(bits.join(", "));
  }

  const actIndex = sentences.findIndex(s => detectActivation(s));
  const before = actIndex < 0 ? sentences : sentences.slice(0, actIndex);
  const block = actIndex < 0 ? [] : sentences.slice(actIndex).filter(s => !isUsesSentence(s));

  const passive = { changes: [], statuses: [] };
  const riders = [];
  const targetEffects = [];
  let lastCondition = null;

  const addToggle = (s, ext) => {
    const label = (/^until\b/i.test(s) && lastCondition) ? lastCondition : conditionLabel(s);
    result.effects.push(makeEffect(`${name} (${label})`, ext, { transfer: true, disabled: true, img, description: s, kind: "toggle" }));
    result.summary.push(`Toggle "${label}": ${describeChanges(ext)}`);
  };
  const addTarget = (s, fallbackDuration = null) => {
    const t = extractTargetEffect(s);
    if (!t) return;
    const eff = makeEffect(`${name}: ${t.label}`, t.ext, {
      transfer: false, img, description: s, duration: parseDuration(s) ?? fallbackDuration, kind: "target"
    });
    targetEffects.push(eff);
    result.effects.push(eff);
    const detail = describeChanges(t.ext);
    result.summary.push(`For others: ${t.label}${detail && detail.toLowerCase() !== t.label.toLowerCase() ? ` (${detail})` : ""}`);
    produced.add(s);
    markHandled(s, ["Allies", "Target"]);
  };

  for (const s of before) {
    if (isUsesSentence(s)) { produced.add(s); continue; }
    if (isStacking(s)) continue;
    const ext = targetsOthers(s) ? { changes: [], statuses: [] } : extractChanges(s);
    if (ext.changes.length || ext.statuses.length) {
      produced.add(s);
      if (isConditional(s)) addToggle(s, ext);
      else {
        passive.changes.push(...ext.changes);
        passive.statuses.push(...ext.statuses);
      }
    }
    if (isConditional(s) && !/^until\b/i.test(s)) lastCondition = conditionLabel(s);
    const parts = parseDamage(s);
    const temphp = parseTempHP(s);
    if (parts.length || temphp) {
      produced.add(s);
      riders.push(makeActivity({
        name: parts.length ? `${name}: Bonus damage` : `${name}: Temporary HP`,
        activation: "special", condition: conditionLabel(s), parts, temphp
      }));
    }
    addTarget(s);
  }

  if (passive.changes.length || passive.statuses.length) {
    result.effects.unshift(makeEffect(name, passive, { transfer: true, img, kind: "passive" }));
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
    if (/^while\b/i.test(block[0]) && (ext.changes.length || ext.statuses.length)) {
      addToggle(block[0], ext);
    } else if (ext.changes.length || ext.statuses.length) {
      const eff = makeEffect(name, ext, { transfer: false, img, duration, description: text, kind: "self" });
      result.effects.push(eff);
      main.effects = [{ _id: eff._id }];
    }
    produced.add(block[0]);
    for (const s of block) {
      if (parseDamage(s).length || parseTempHP(s) || parseSave(s)) produced.add(s);
      const e = targetsOthers(s) ? { changes: [] } : extractChanges(s);
      if (e.changes.length || e.statuses?.length) produced.add(s);
      addTarget(s, duration);
    }
    result.activities.push(main);
    result.summary.push(`${describeActivity(main)}${main.effects ? `, applies ${describeChanges(ext)}` : ""}`);
  }

  for (const r of riders) {
    result.activities.push(r);
    result.summary.push(describeActivity(r));
  }
  if (stackParts?.activity) result.activities.push(stackParts.activity);
  if (stackParts?.effect) result.effects.push(stackParts.effect);

  // Limited uses with no activated ability: riders spend the uses, or add a tracker activity.
  let tracker = null;
  if (result.uses && !main) {
    if (riders.length) {
      riders[0].consumption.targets = [{ type: "itemUses", target: "", value: "1", scaling: {} }];
    } else {
      tracker = makeActivity({ name, activation: "special", condition: conditionLabel(allSentences[0]), consume: true });
      result.activities.push(tracker);
      result.summary.push("Use tracker");
    }
  }

  if (result.uses) {
    const max = result.uses.max.replace("@prof", "PB");
    result.summary.unshift(`Uses: ${max} per ${result.uses.period === "sr" ? "short" : "long"} rest`);
  }

  // Reminders for everything a player still has to handle, in the order the text gives it.
  for (const s of allSentences) {
    if (isUsesSentence(s)) continue;
    const isStackSentence = stackSentences.includes(s);
    const handled = handledTags.get(s) ?? [];
    let tags = manualTags(s).filter(t => !handled.includes(t));
    if (isStackSentence && (s === stack.gainText || s === stack.loseText)) tags.unshift("Stacks");
    // "Choose an ally within 30 feet" is covered by the effect for others that follows it.
    if (targetEffects.length && /\bchoose (?:an? (?:willing )?ally|up to PB)\b/i.test(s)) tags = tags.filter(t => t !== "Allies");
    if (!produced.has(s) && !tags.length) tags = ["Rule"];
    if (tags.length) result.reminders.push({ tags: [...new Set(tags)], text: s });
  }

  // Make sure there's something to click: text-only augments get a reminder activity.
  let host = main ?? riders[0] ?? stackParts?.activity ?? tracker;
  if (!host && (result.reminders.length || targetEffects.length)) {
    host = makeActivity({ name, activation: "special", condition: conditionLabel(allSentences[0]) });
    result.activities.push(host);
  }
  if (host && targetEffects.length) host.effects = [...(host.effects ?? []), ...targetEffects.map(e => ({ _id: e._id }))];
  if (result.reminders.length) result.summary.push(`${result.reminders.length} reminder${result.reminders.length === 1 ? "" : "s"} in chat`);

  return result;
}

/** Convert an analysis into item data (system fields + embedded effects + bookkeeping flag). */
export function automationData(result, itemType = "feat") {
  const supportsActivities = ["feat", "equipment", "consumable", "weapon", "tool"].includes(itemType);
  const system = {};
  const activities = supportsActivities ? result.activities : [];
  if (supportsActivities && result.uses) {
    system.uses = { max: result.uses.max, spent: 0, recovery: [{ period: result.uses.period, type: "recoverAll" }] };
  }
  if (activities.length) system.activities = Object.fromEntries(activities.map(a => [a._id, a]));
  return {
    system,
    effects: result.effects,
    flag: {
      activities: activities.map(a => a._id),
      effects: result.effects.map(e => e._id),
      summary: result.summary,
      reminders: result.reminders,
      stack: result.stack ?? null,
      usesAuto: !!(supportsActivities && result.uses)
    }
  };
}

/** Starting enabled state for a transferred effect, given where the item is. */
function initialDisabled(effect, { onActor, socketed }) {
  if (!effect.transfer) return effect.disabled;
  const kind = effect.flags?.[MODULE_ID]?.kind;
  if (kind === "toggle" || kind === "stack") return true;
  return onActor ? !socketed : false;
}

/**
 * (Re)build automation on an existing item. Only replaces what this module generated before.
 * Unsocketed augments on a character keep their activities in storage (see syncSocketState).
 */
export async function applyAutomation(item, text = null, { quiet = false } = {}) {
  const effectText = text ?? getEffectText(item);
  const result = analyzeEffect(effectText, { name: item.name, img: item.img });
  const data = automationData(result, item.type);
  const F = item.flags?.[MODULE_ID] ?? {};
  const prev = F.auto ?? {};
  const prevActs = new Set(prev.activities ?? []);
  const onActor = item.parent?.documentName === "Actor";
  const socketed = onActor && !!equippedBy(item);
  const opts = { [MODULE_ID]: true };
  const newActs = Object.values(data.system.activities ?? {});

  const update = { [`flags.${MODULE_ID}.auto`]: data.flag };
  if (data.system.uses) {
    data.system.uses.spent = Number(item.system.uses?.spent) || 0;
    update["system.uses"] = data.system.uses;
  } else if (prev.usesAuto && item.system?.uses) {
    update["system.uses.max"] = "";
    update["system.uses.recovery"] = [];
  }

  const acts = item.system?.activities;
  if (acts !== undefined) {
    const stashed = (Array.isArray(F.stashedActivities) ? F.stashedActivities : []).filter(a => !prevActs.has(a._id));
    if (onActor && !socketed) {
      const fromSystem = acts.contents.filter(a => !prevActs.has(a.id)).map(a => a.toObject());
      update[`flags.${MODULE_ID}.stashedActivities`] = [...stashed, ...fromSystem, ...newActs];
      for (const a of [...acts.contents]) await a.delete?.();
    } else {
      for (const id of prevActs) await acts.get(id)?.delete?.();
      for (const a of stashed) update[`system.activities.${a._id}`] = a;
      if (F.stashedActivities?.length) update[`flags.${MODULE_ID}.stashedActivities`] = [];
      for (const a of newActs) update[`system.activities.${a._id}`] = a;
    }
  }
  await item.update(update, opts);

  const oldEffects = (prev.effects ?? []).filter(id => item.effects.has(id));
  if (oldEffects.length) await item.deleteEmbeddedDocuments("ActiveEffect", oldEffects, opts);
  const effects = data.effects.map(e => ({ ...e, disabled: initialDisabled(e, { onActor, socketed }) }));
  if (effects.length) await item.createEmbeddedDocuments("ActiveEffect", effects, { keepId: true, ...opts });
  if (result.stack && socketed) await applyStackValue(item, Number(F.stackValue) || 0);

  if (quiet) return result;
  ui.notifications.info(result.summary.length
    ? `${item.name}: ${result.summary.join("; ")}`
    : `${item.name}: nothing in the effect text could be automated.`);
  return result;
}
