import { MODULE_ID, getEffectText, equippedBy, change } from "./core.js";
export { change };
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
const MOVEMENT = { climbing: "climb", flying: "fly", swimming: "swim", burrowing: "burrow", climb: "climb", fly: "fly", swim: "swim", burrow: "burrow" };
const SKILLS = {
  acrobatics: "acr", "animal handling": "ani", arcana: "arc", athletics: "ath", deception: "dec", history: "his",
  insight: "ins", intimidation: "itm", investigation: "inv", medicine: "med", nature: "nat", perception: "prc",
  performance: "prf", persuasion: "per", religion: "rel", "sleight of hand": "slt", stealth: "ste", survival: "sur"
};
const SKILL_RE = Object.keys(SKILLS).join("|");
/** Rest of the clause after a bonus says it only applies sometimes ("against charm", "while flying"). */
const isQualified = rest => /^[^.;]*?\b(?:against|while|when|whenever|if|during|on (?:checks|saves)|to (?:find|detect|resist|track|locate|identify|navigate|avoid))\b/i.test(rest);
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, once: 1, twice: 2, "three times": 3, "four times": 4 };

/**
 * The "augment ability" (module setting): used for augment attacks, augment save DCs and
 * "+ your augment ability modifier". "spellcasting" uses each character's spellcasting ability.
 */
export function augmentAbility() {
  try { return game.settings.get(MODULE_ID, "augmentAbility") || "con"; } catch (e) { return "con"; }
}
function augMod() {
  const a = augmentAbility();
  return a === "spellcasting" ? "@attributes.spell.mod" : `@abilities.${a}.mod`;
}

/** "+ PB", "+ your augment ability modifier", "+ your Strength modifier" after a die. */
const BONUS = String.raw`(?:\s*\+\s*(?:PB|your augment ability modifier|your (?:strength|dexterity|constitution|intelligence|wisdom|charisma) modifier))?`;

/** Text amount ("2d8 + your augment ability modifier") to a roll formula ("2d8 + @abilities.con.mod"). */
function toFormula(text) {
  return String(text)
    .replace(/\byour augment ability modifier\b/gi, augMod())
    .replace(/\byour (strength|dexterity|constitution|intelligence|wisdom|charisma) modifier\b/gi, (_, a) => `@abilities.${ABILITIES[a.toLowerCase()]}.mod`)
    .replace(/\bPB\b/g, "@prof")
    .replace(/(\d|@prof)\s*[x×]\s*(\d|@prof)/g, "$1 * $2")
    .replace(/\s+/g, " ").trim();
}

const ACTIVATIONS = [
  [/\b(?:as a bonus action|use your bonus action)\b/i, "bonus"],
  [/\b(?:use your reaction|as a reaction)\b/i, "reaction"],
  [/\b(?:as an action|use your action|as a magic action|take the magic action|as a utilize action|take the utilize action)\b/i, "action"],
  [/\bat the end of another creature's turn\b/i, "special"]
];
const USES_ONLY_RE = /^(?:\d+\s*[x×*]\s*)?PB uses per (?:short|long) rest|^once per (?:short|long) rest\.?$|^usable (?:once|twice|three times|four times|\d+ times)\b/i;

/** Reminder tags: what a player has to handle by hand. Order = display order. */
const MANUAL_TAGS = [
  ["Movement", /\b(?:move|teleport|leap|propel|pull yourself|rise|ascend|descend|swap places|fly up to|stop instantly|glide)\b/i],
  ["Opportunity attacks", /\bopportunity attacks?\b/i],
  ["Attacks", /\b(?:two|three|four) (?:melee |ranged )?(?:augment )?attacks\b/i],
  ["Forced movement", /\b(?:push(?:ed)?|pull(?:ed)?|knocked prone|tether(?:ed)?|forced movement|forcibly moved)\b/i],
  ["Target", /\b(?:its|their) (?:AC|speed)\b|\bprevent (?:the target|it)\b|\b(?:it|the target) (?:cannot|can't)\b|\bprime\b|\bmark\b/i],
  ["Allies", /\ball(?:y|ies)\b/i],
  ["Damage rules", /\bignores?\b|\bis ignored\b|\bimmunity\b|\bdoubled\b|\bchange (?:that|one attack's|the) damage|\breduce (?:it|that|the triggering|falling damage)\b|\btwice that amount\b/i],
  ["Advantage", /\b(?:dis)?advantage\b/i],
  ["Stealth", /\bHide\b|\bdecoy\b|\bhidden\b/],
  ["Cover", /\bcover\b/i],
  ["Resource", /\bregain\b|\bexpend\b|\bHit Dice\b/i]
];

/** Short stable hash, used for automation signatures and stable ids. */
export function stableHash(str) {
  let h1 = 0x811c9dc5, h2 = 0x9e3779b9;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 2246822519);
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}

const ID_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
function stableId(seed) {
  let out = "";
  for (let i = 0; out.length < 16; i++) {
    let h = 0x811c9dc5;
    const str = `${seed}#${i}`;
    for (let j = 0; j < str.length; j++) h = Math.imul(h ^ str.charCodeAt(j), 16777619);
    out += ID_CHARS[(h >>> 0) % 62];
  }
  return out;
}

/* While analysing an item, ids are derived from the item so rebuilding gives the same ids. */
let idSeed = null;
let idCounter = 0;

function rid() {
  if (idSeed !== null) return stableId(`${idSeed}:${idCounter++}`);
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
  const per = p => (/^short/i.test(p) ? "sr" : "lr");
  // "PB uses per long rest", "PB times per short rest", "PB banks per long rest", "2 x PB uses..."
  let m = text.match(/(?:(\d+)\s*[x×*]\s*)?PB (?:(?!once\b|twice\b)[a-z]+ ){0,5}?per (short or long|short|long) rest/i);
  if (m) return { max: m[1] ? `${m[1]} * @prof` : "@prof", period: per(m[2]) };
  // "Two uses per long rest", "3 times per short rest"
  m = text.match(/\b(\d+|one|two|three|four|five|six) (?:[a-z]+ ){0,2}?(?:uses|times|charges)\b(?: [a-z]+){0,3}? per (short or long|short|long) rest/i);
  if (m) return { max: String(NUMBER_WORDS[m[1].toLowerCase()] ?? m[1]), period: per(m[2]) };
  m = text.match(/\busable (once|twice|three times|four times|(\d+) times) per (short or long|short|long) rest/i);
  if (m) return { max: String(m[2] ?? NUMBER_WORDS[m[1].toLowerCase()]), period: per(m[3]) };
  m = text.match(/\b(once|twice|three times|four times) per (short or long|short|long) rest/i);
  if (m) return { max: String(NUMBER_WORDS[m[1].toLowerCase()]), period: per(m[2]) };
  m = text.match(/\b(?:the first time|once) each (short or long|short|long) rest\b/i);
  if (m) return { max: "1", period: per(m[1]) };
  if (/\bonce per day\b/i.test(text)) return { max: "1", period: "lr" };
  return null;
}

function detectActivation(sentence) {
  for (const [re, type] of ACTIVATIONS) if (re.test(sentence)) return type;
  return null;
}

function parseDamage(text) {
  const parts = [];
  const re = new RegExp(`\\+?(\\d+)d(\\d+)(${BONUS})\\s+(?:extra\\s+|additional\\s+)?(?:(\\w+)(?:\\s+or\\s+\\w+)?\\s+)?damage`, "gi");
  let m;
  while ((m = re.exec(text))) {
    const type = m[4]?.toLowerCase();
    parts.push({
      number: Number(m[1]), denomination: Number(m[2]), bonus: m[3] ? toFormula(m[3].replace(/^\s*\+\s*/, "")) : "",
      types: DAMAGE_TYPES.includes(type) ? [type] : [], custom: { enabled: false, formula: "" }
    });
  }
  if (/damage equal to (?:your )?PB\b/i.test(text)) {
    parts.push({ number: null, denomination: null, bonus: "", types: [], custom: { enabled: true, formula: "@prof" } });
  }
  for (const mm of text.matchAll(/(?:\badd|\bdeals?|\btakes?|\+)\s*PB (?:(\w+) )?damage\b/gi)) {
    if (/\d+d\d+\s*$/.test(text.slice(0, mm.index))) continue; // "2d6 + PB fire damage": PB is part of that roll
    const type = mm[1]?.toLowerCase();
    parts.push({ number: null, denomination: null, bonus: "", types: DAMAGE_TYPES.includes(type) ? [type] : [], custom: { enabled: true, formula: "@prof" } });
  }
  return parts;
}

function parseTempHP(text) {
  let m = text.match(new RegExp(`(\\d+d\\d+${BONUS}|PB)\\s+temporary hit points`, "i"));
  if (!m) m = text.match(new RegExp(`temporary hit points equal to (\\d+d\\d+${BONUS}|PB${BONUS})`, "i"));
  return m ? toFormula(m[1]) : null;
}

/** "restore 4d8 + your augment ability modifier hit points", "regain an extra 1d8 + PB hit points". */
export function parseHeal(text) {
  const m = text.match(new RegExp(`\\b(?:restores?|restoring|regains?|regaining|heals?|recovers?)\\s+(?:an extra |an additional |up to )?(\\d+d\\d+${BONUS})(?=\\s+hit points|\\s*[.;,]|\\s+(?:and|the|when|if|to)\\b|\\s*$)`, "i"))
    ?? text.match(new RegExp(`\\bwith (\\d+d\\d+${BONUS}) hit points`, "i"));
  return m ? toFormula(m[1]) : null;
}

/** "add 1d6 after its roll" (bonus die) or "reduce it by 2d8 + PB" (damage reduction): a rollable die. */
function parseExtraRoll(text) {
  let m = text.match(new RegExp(`\\b(?:adds?|adding) (\\d+d\\d+${BONUS})(?!\\s+(?:extra |additional )?(?:\\w+ )?damage)\\b`, "i"))
    ?? text.match(/(?:with (?:a )?|gains? |gain a )\+(\d+d\d+)(?: bonus)?\b/i);
  if (m) return { formula: toFormula(m[1]), name: "Bonus die" };
  m = text.match(/\bloses? (\d+d\d+) hit points\b/i);
  if (m) return { formula: m[1], name: "Hit point cost" };
  m = text.match(/\bsubtract (\d+d\d+) from\b/i);
  if (m) return { formula: m[1], name: "Penalty die" };
  m = text.match(new RegExp(`\\breduce (?:it|that damage|the damage|the triggering damage|(?:\\w+ )?damage (?:you|it) takes?)? ?by (\\d+d\\d+${BONUS})`, "i"));
  if (m) return { formula: toFormula(m[1]), name: "Damage reduction" };
  return null;
}

/** "make a melee augment attack" -> "melee"; "ranged augment attack" -> "ranged". */
function parseAttack(text) {
  return text.match(/\b(melee|ranged) augment attacks?\b/i)?.[1]?.toLowerCase() ?? null;
}

/** Concentration that's actually required (not "No concentration is required"). */
export function concentrationRequired(text) {
  if (!/\bconcentration\b/i.test(text)) return false;
  return !/\bno concentration\b|\bconcentration is not required\b|\bnot require concentration\b|\bwithout concentration\b|\bsupplies[^.]*concentration|\bcosts?, components?,? and concentration|\bnormal costs[^.]*concentration/i.test(text);
}

/**
 * A save forced on someone else ("each makes a Dexterity save", "on a failed Strength save").
 * Ignores saves you or allies make ("when an ally makes a Constitution save") and save bonuses.
 */
export function parseSave(text) {
  for (const m of text.matchAll(/(strength|dexterity|constitution|intelligence|wisdom|charisma) (?:saving throws?|saves?)\b/gi)) {
    const pre = text.slice(0, m.index);
    if (/\b(?:advantage|disadvantage|bonus|adds?)\b|\+\d+/i.test(pre.slice(-45))) continue;
    const clause = pre.split(/[.;:,]/).pop();
    if (/\b(?:you|your|ally|allies)\b/i.test(clause) && !/\b(?:enem\w*|creatures?|targets?|each|it|they|hostile)\b/i.test(clause)) continue;
    return ABILITIES[m[1].toLowerCase()];
  }
  return null;
}

function parseRange(text) {
  let m = text.match(/\brange (\d+)\/(\d+) feet/i);
  if (m) return { units: "ft", value: m[1], long: m[2] };
  m = text.match(/within (\d+) feet/i);
  return m ? { units: "ft", value: m[1] } : null;
}

function parseDuration(text) {
  let m = text.match(/\bfor (\d+) (minute|hour|round)s?\b/i);
  if (m) return { units: m[2].toLowerCase(), value: m[1] };
  if (/until (?:the start of )?your next turn/i.test(text)) return { units: "round", value: "1" };
  if (/until the end of (?:your|the|that) turn|for that turn/i.test(text)) return { units: "turn", value: "1" };
  return null;
}

/** Area of effect: "15-foot-radius", "30-foot cone", "60-foot line", "10-foot cube"... */
const TEMPLATE_SHAPES = { sphere: "sphere", cube: "cube", cone: "cone", line: "line", cylinder: "cylinder", square: "square", wall: "wall", emanation: "radius", radius: "radius" };
function parseTemplate(text) {
  let m = text.match(/(\d+)-foot(?:-|\s)radius\b(?:\s+(sphere|cylinder))?/i);
  if (m) return makeTemplate(m[2] ? TEMPLATE_SHAPES[m[2].toLowerCase()] : "radius", m[1]);
  m = text.match(/(\d+)-foot(?:-long)?\s+(sphere|cube|cone|line|cylinder|square|wall|emanation)s?\b/i);
  if (m) return makeTemplate(TEMPLATE_SHAPES[m[2].toLowerCase()], m[1]);
  m = text.match(/\b(sphere|cylinder|emanation) (?:of|with) (?:a )?(\d+)-foot radius/i);
  if (m) return makeTemplate(TEMPLATE_SHAPES[m[1].toLowerCase()], m[2]);
  return null;
}
function makeTemplate(type, size) {
  return { count: "1", contiguous: false, type, size: String(size), width: "", height: "", units: "ft" };
}

/** "half on success", "half as much damage on a successful save" -> half; otherwise none. */
function parseOnSave(text) {
  return /\bhalf as much\b|\bhalf (?:the )?(?:damage )?on (?:a )?(?:success|successful|save)\b/i.test(text) ? "half" : "none";
}

function parseTarget(text) {
  const result = parseAffects(text) ?? {};
  const template = parseTemplate(text);
  if (template) {
    result.template = template;
    result.prompt = true;
  }
  return Object.keys(result).length ? result : null;
}

function parseAffects(text) {
  if (/\b(?:chosen|choose|choosing) enemies\b|\benemies of your choice\b/i.test(text)) return { affects: { type: "enemy", choice: true } };
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

/** Clauses describing a later or repeating instance rather than what happens on use. */
const ONGOING_RE = /\b(?:once per (?:turn|round)|each turn|whenever|(?:ending|ends|starting|starts?) (?:its|their) turns?|start of (?:its|their|each|your)|end of (?:its|their)|enters?|entering|the first time|rolls gain|again|before repeating)\b/i;

function followUpLabel(u, heal) {
  const what = heal ? "temp HP" : "damage";
  const entering = /\benters?\b|\bentering\b/i.test(u);
  const starting = /\b(?:starts?|starting) (?:its|their) turns?|start of (?:its|their)/i.test(u);
  if (entering && starting) return `Enter or start turn ${what}`;
  if (/\b(?:ending|ends) (?:its|their) turns?|end of (?:its|their) turn/i.test(u)) return `End of turn ${what}`;
  if (starting) return `Start of turn ${what}`;
  if (entering) return `On entering, ${what}`;
  if (/\bfirst time each turn|once per turn\b/i.test(u)) return `Once per turn ${what}`;
  return heal ? "Temp HP" : "Extra damage";
}

/** "Concentration required; two uses per long rest." is handled by automation, not a reminder. */
function isBookkeeping(s) {
  return s.replace(/\.$/, "").split(/;\s*/).every(u =>
    /^concentration(?: required)?$/i.test(u.trim()) || (parseUses(u) && u.trim().split(/\s+/).length <= 7));
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
  const changes = [];
  const statuses = [];
  const add = (key, type, value) => changes.push(change(key, type, value));
  let m;

  if ((m = s.match(/(?:walking )?speed increases by (\d+) feet/i))) add("system.attributes.movement.walk", "add", m[1]);
  else if ((m = s.match(/\+(\d+) feet (?:of )?(?:walking )?speed/i))) add("system.attributes.movement.walk", "add", m[1]);

  for (const mm of s.matchAll(/(\d+)-foot (climbing|flying|swimming|burrowing|climb|fly|swim|burrow) speed/gi)) {
    add(`system.attributes.movement.${MOVEMENT[mm[2].toLowerCase()]}`, "upgrade", mm[1]);
  }
  if ((m = s.match(/\+(\d+) (?:bonus )?to initiative/i))) add("system.attributes.init.bonus", "add", m[1]);
  if ((m = s.match(/\+(\d+) (?:bonus )?(?:to )?AC\b/i)) && (!/ to AC/i.test(m[0]) || !isQualified(s.slice(m.index + m[0].length)))) {
    add("system.attributes.ac.bonus", "add", `+${m[1]}`);
  }
  // "resistance to fire damage", "resistance to bludgeoning, piercing, and slashing damage"
  for (const mm of s.matchAll(/(?:have|gain|has) resistance to ((?:\w+(?:,\s*|\s+(?:and|or)\s+|,\s*(?:and|or)\s+))*\w+) damage(?! from| you take from)/gi)) {
    if (isQualified(s.slice(mm.index + mm[0].length))) continue;
    for (const type of mm[1].toLowerCase().split(/,\s*|\s+(?:and|or)\s+/).map(t => t.replace(/^(?:and|or)\s+/, "").trim())) {
      if (DAMAGE_TYPES.includes(type)) add("system.traits.dr.value", "add", type);
    }
  }
  // Flat, unconditional bonuses: "+1 to Constitution saving throws", "+2 to Stealth checks"
  for (const mm of s.matchAll(/\+(\d+) (?:bonus )?to (strength|dexterity|constitution|intelligence|wisdom|charisma) sav(?:es|ing throws)/gi)) {
    if (!isQualified(s.slice(mm.index + mm[0].length))) add(`system.abilities.${ABILITIES[mm[2].toLowerCase()]}.bonuses.save`, "add", `+${mm[1]}`);
  }
  for (const mm of s.matchAll(new RegExp(`\\+(\\d+) (?:bonus )?to (${SKILL_RE})(?: \\(\\w+\\))? checks`, "gi"))) {
    if (!isQualified(s.slice(mm.index + mm[0].length))) add(`system.skills.${SKILLS[mm[2].toLowerCase()]}.bonuses.check`, "add", `+${mm[1]}`);
  }
  // "Gain proficiency in Acrobatics, or expertise if already proficient" (one skill, no choice)
  if ((m = s.match(new RegExp(`\\bproficiency in (${SKILL_RE})(?:,| or)? (?:or )?expertise if (?:you are )?already proficient`, "i")))
    || (m = s.match(new RegExp(`\\bproficiency in (${SKILL_RE})\\b(?! or\\b)(?!,? or (?:${SKILL_RE}))`, "i")))) {
    add(`system.skills.${SKILLS[m[1].toLowerCase()]}.value`, "add", 1);
  }
  for (const mm of s.matchAll(/advantage on (strength|dexterity|constitution|intelligence|wisdom|charisma) sav(?:es|ing throws)/gi)) {
    add(`system.abilities.${ABILITIES[mm[1].toLowerCase()]}.save.roll.mode`, "add", 1);
  }
  if (/\bhover\b/i.test(s)) add("system.attributes.movement.hover", "override", true);
  if (/speed becomes 0/i.test(s)) add("system.attributes.movement.walk", "override", 0);
  if (/count as one size larger for (?:lifting|carrying)/i.test(s)) add("flags.dnd5e.powerfulBuild", "override", true);
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
    const sb = k.match(/abilities\.(\w+)\.bonuses\.save/);
    if (sb) return `${v} ${sb[1].toUpperCase()} saves`;
    const sk = k.match(/skills\.(\w+)\.(bonuses\.check|value)/);
    if (sk) return sk[2] === "value" ? `${sk[1]} proficiency` : `${v} ${sk[1]} checks`;
    return k;
  });
  return out.concat(statuses).join(", ");
}

const CONDITION_WORDS = "blinded|charmed|deafened|frightened|grappled|incapacitated|paralyzed|poisoned|prone|restrained|stunned";

/** Conditions this text puts on someone ("save or be frightened", "Failure: the target is stunned"). */
export function imposedConditions(s) {
  const out = new Set();
  const res = [
    new RegExp(`\\b(?:save|saves|saving throws?)\\s+or\\s+(?:is|are|be|become|becomes)\\s+(?:also\\s+)?(${CONDITION_WORDS})\\b`, "gi"),
    new RegExp(`\\b(?:failure:?|on a fail(?:ure|ed save)?,?)[^.]*?\\b(?:is|are|becomes?|be)\\s+(?:also\\s+)?(${CONDITION_WORDS})\\b`, "gi"),
    new RegExp(`\\b(?:the target|failed targets?|each failed target)\\s+(?:is|are|becomes?)\\s+(${CONDITION_WORDS})\\b`, "gi")
  ];
  for (const re of res) for (const m of s.matchAll(re)) out.add(m[1].toLowerCase());
  return [...out];
}

/** Effects for other creatures: allies gaining things, enemies losing things, or a plain marker. */
function extractTargetEffect(s) {
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
    ext.changes.push(change("system.attributes.ac.bonus", "add", `-${n}`));
    label = `-${n} AC`;
  }
  if ((m = s.match(/reduce (?:its|their) speed by (\d+) feet|(?:its|their) speed (?:is )?reduced by (\d+) feet/i))) {
    const n = m[1] ?? m[2];
    ext.changes.push(change("system.attributes.movement.walk", "add", `-${n}`));
    label ??= `-${n} ft speed`;
  }
  if (/\bknocked prone\b/i.test(s) && !/\bagainst being\b/i.test(s)) {
    ext.statuses.push("prone");
    label ??= "Prone";
  }
  for (const c of imposedConditions(s)) {
    if (ext.statuses.includes(c)) continue;
    ext.statuses.push(c);
    label = label ? `${label}, ${c}` : c[0].toUpperCase() + c.slice(1);
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
  const maxOf = v => (v === undefined ? null : /^pb$/i.test(v) ? "@prof" : String(NUMBER_WORDS[v.toLowerCase()] ?? v));
  for (const s of sentences) {
    // "you gain 1 Redline (maximum 3)"
    let m = s.match(/\bgain (?:1|one|a) ([A-Z][A-Za-z'-]+)\b(?: (?:stack|charge|point)s?)?(?:\s*\((?:to a )?max(?:imum)?\.?\s*(?:of )?(\d+|PB|one|two|three|four|five|six)\))?/);
    // "gain one pressure if you moved at least 20 feet, maximum three"
    if (!m) m = s.match(/\bgain (?:1|one|a) ([a-z][a-z'-]+)\b[^.;]*?,?\s*\(?max(?:imum)?\.?\s*(?:of )?(\d+|PB|one|two|three|four|five|six)\b/i);
    if (!m || /^(?:use|turn|reaction|bonus|action|hit|die|level)s?$/i.test(m[1])) continue;
    const timing = /\bat (?:the end of your turn|your turn['’]s end)\b/i.test(s) ? "end" : /\bat (?:the start of your turn|your turn['’]s start)\b/i.test(s) ? "start" : "manual";
    return { name: m[1], max: maxOf(m[2]), timing, gainText: s };
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
      ?? s.match(new RegExp(`speed increases by (\\d+) feet (?:for each|per) ${N}`, "i"))
      ?? s.match(new RegExp(`\\beach ${N} (?:grants|gives) \\+?(\\d+) feet of (?:walking )?speed`, "i"));
    if (m) {
      stack.speedPer = Number(m[1]);
      covered.add(s);
    }
    m = s.match(new RegExp(`(\\d+)d(\\d+) (?:extra |additional )?(?:(\\w+) )?damage (?:per|for each) ${N}`, "i"))
      ?? (new RegExp(`\\bper ${N}\\b`, "i").test(s) ? s.match(/(\d+)d(\d+) (?:extra |additional )?(?:(\w+) )?damage/i) : null);
    if (m) {
      const type = m[3]?.toLowerCase();
      stack.damage = { number: Number(m[1]), denomination: Number(m[2]), type: DAMAGE_TYPES.includes(type) ? type : null };
      stack.damageCondition = conditionLabel(s);
      covered.add(s);
    }
    if (new RegExp(`\\blose all ${N}\\b`, "i").test(s)) stack.loseText = s;
  }
  if (stack.speedPer) {
    effect = makeEffect(`${name} (${stack.name})`,
      { changes: [change("system.attributes.movement.walk", "add", 0)], statuses: [] },
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

function makeActivity({ name, activation, condition = "", parts = [], temphp = null, heal = null, roll = null, attack = null, save = null, onSave = "none", concentration = false, range = null, duration = null, target = null, consume = false }) {
  const type = save ? "save" : attack ? "attack" : parts.length ? "damage" : (heal || temphp) ? "heal" : "utility";
  const act = {
    _id: rid(), type, name,
    activation: { type: activation, value: ["action", "bonus", "reaction"].includes(activation) ? 1 : null, condition, override: false },
    consumption: { targets: consume ? [{ type: "itemUses", target: "", value: "1", scaling: {} }] : [], scaling: { allowed: false, max: "" } }
  };
  if (duration || concentration) act.duration = { units: "minute", value: "1", ...(duration ?? {}), concentration, override: false };
  if (range) act.range = { ...range, override: false };
  if (target) act.target = { ...target, override: false };
  if (type === "save") {
    act.save = { ability: [save], dc: { calculation: augmentAbility(), formula: "" } };
    act.damage = { onSave, parts };
  } else if (type === "attack") {
    act.attack = { ability: augmentAbility(), bonus: "", critical: { threshold: null }, flat: false, type: { value: attack, classification: "weapon" } };
    act.damage = { critical: { bonus: "" }, includeBase: false, parts };
  } else if (type === "heal") {
    act.healing = { number: null, denomination: null, bonus: "", types: [heal ? "healing" : "temphp"], custom: { enabled: true, formula: heal ?? temphp } };
  } else if (type === "damage") {
    act.damage = { critical: { allow: true }, parts };
  } else if (roll) {
    act.roll = { formula: roll.formula, name: roll.name, prompt: false, visible: true };
  }
  return act;
}

/** Everything rollable in a piece of text. */
function payloadOf(text) {
  return { parts: parseDamage(text), temphp: parseTempHP(text), heal: parseHeal(text), roll: parseExtraRoll(text), save: parseSave(text), attack: parseAttack(text) };
}
const hasPayload = p => !!(p.parts.length || p.temphp || p.heal || p.roll || p.save || p.attack);

function payloadLabel(p) {
  if (p.attack) return `${p.attack === "ranged" ? "Ranged" : "Melee"} attack`;
  if (p.save) return `${p.save.toUpperCase()} save`;
  if (p.heal) return "Healing";
  if (p.temphp) return "Temporary HP";
  if (p.parts.length) return "Bonus damage";
  return p.roll?.name ?? "Roll";
}

function describeActivity(act) {
  const when = { bonus: "Bonus action", reaction: "Reaction", action: "Action", special: "Triggered" }[act.activation.type] ?? "Activity";
  const fmt = f => String(f).replace(/@prof/g, "PB").replace(/@abilities\.(\w+)\.mod/g, (_, a) => `${a.toUpperCase()} mod`).replace(/@attributes\.spell\.mod/g, "spell mod");
  const bits = [];
  if (act.type === "attack") bits.push(`${act.attack.type.value} attack`);
  if (act.type === "save") bits.push(`${act.save.ability[0].toUpperCase()} save${act.damage.onSave === "half" ? ", half on success" : ""}`);
  for (const p of act.damage?.parts ?? []) {
    bits.push(p.custom?.enabled ? fmt(p.custom.formula) : `${p.number}d${p.denomination}${p.bonus ? ` + ${fmt(p.bonus)}` : ""}${p.types[0] ? ` ${p.types[0]}` : ""}`);
  }
  if (act.type === "heal") bits.push(`${fmt(act.healing.custom.formula)} ${act.healing.types[0] === "healing" ? "healing" : "temp HP"}`);
  if (act.roll?.formula) bits.push(`${act.roll.name.toLowerCase()} ${fmt(act.roll.formula)}`);
  if (act.target?.template) bits.push(`${act.target.template.size} ft ${act.target.template.type}`);
  if (act.duration?.concentration) bits.push("concentration");
  return bits.length ? `${when} (${bits.join(", ")})` : when;
}

/* -------------------------------------------- */
/*  Public API                                  */
/* -------------------------------------------- */

/**
 * Analyse effect text. Returns plain data plus a summary and the reminders shown in chat.
 * With a seed (the item's id), generated activity and effect ids are the same every rebuild.
 */
export function analyzeEffect(text, { name = "Augment", img = null, seed = null } = {}) {
  idSeed = seed;
  idCounter = 0;
  try {
    return analyzeEffectInner(text, { name, img });
  } finally {
    idSeed = null;
  }
}

function analyzeEffectInner(text, { name, img }) {
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
    stackParts = buildStack(stack, stackSentences, { name, img });
    // Sentences the stack rules handle (gain, lose, per-stack bonuses) leave the normal reader;
    // anything else that merely mentions the resource ("spend pressure to add 1d6") stays in it.
    const stackOwned = new Set([...stackParts.covered, stack.gainText, stack.loseText].filter(Boolean));
    sentences = sentences.filter(s => !stackOwned.has(s));
    for (const s of stackParts.covered) produced.add(s);
    result.stack = stack;
    const bits = [`Stacks: ${stack.name}${stack.max ? ` (max ${stack.max.replace("@prof", "PB")})` : ""}`];
    if (stack.speedPer) bits.push(`+${stack.speedPer} ft speed each`);
    if (stack.damage) bits.push(`${stack.damage.number}d${stack.damage.denomination} damage each`);
    result.summary.push(bits.join(", "));
  }

  // The activated part starts at "As an action / bonus action / reaction". With no such phrase, an
  // imposed save, an area or an augment attack still makes it an ability (triggered, not an action).
  let actIndex = sentences.findIndex(s => detectActivation(s));
  if (actIndex < 0) {
    actIndex = sentences.findIndex(s => !isUsesSentence(s) && (parseSave(s) || parseTemplate(s) || parseAttack(s)));
  }
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
    if (!t || targetEffects.some(e => e.name === `${name}: ${t.label}`)) return;
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
    const p = payloadOf(s);
    if (hasPayload(p)) {
      produced.add(s);
      const rider = makeActivity({
        name: `${name}: ${payloadLabel(p)}`, activation: "special", condition: conditionLabel(s),
        ...p, onSave: parseOnSave(s), range: parseRange(s), target: parseTarget(s)
      });
      riders.push(rider);
      if (p.roll && rider.type !== "utility") {
        riders.push(makeActivity({ name: `${name}: ${p.roll.name}`, activation: "special", condition: conditionLabel(s), roll: p.roll }));
      }
      if ((p.heal || p.temphp) && rider.type !== "heal") {
        riders.push(makeActivity({
          name: `${name}: ${p.heal ? "Healing" : "Temporary HP"}`, activation: "special", condition: conditionLabel(s),
          heal: p.heal, temphp: p.heal ? null : p.temphp
        }));
      }
    }
    addTarget(s);
  }

  if (passive.changes.length || passive.statuses.length) {
    result.effects.unshift(makeEffect(name, passive, { transfer: true, img, kind: "passive" }));
    result.summary.unshift(`Passive: ${describeChanges(passive)}`);
  }

  let main = null;
  const followUps = [];
  if (block.length) {
    const text = block.join(" ");
    const duration = parseDuration(text);
    // Each clause is its own instance: the first save or immediate damage/heal is the ability's
    // main roll; later or ongoing ones ("an enemy ending its turn there takes...") get their own.
    const units = block.flatMap(s => s.split(/;\s*/).map(u => u.trim()).filter(Boolean));
    const mainIdx = units.findIndex(u => {
      const p = payloadOf(u);
      return p.save || p.attack || (hasPayload(p) && !ONGOING_RE.test(u));
    });
    // "On a hit, deal..." / "On a failed save..." belongs to the attack or save before it.
    const mainUnits = [];
    if (mainIdx >= 0) {
      mainUnits.push(units[mainIdx]);
      for (let j = mainIdx + 1; j < units.length && /^on (?:a )?(?:hit|failed save|failure|success|successful save)\b/i.test(units[j]); j++) mainUnits.push(units[j]);
    }
    const mainText = mainUnits.join(" ");
    const mp = mainUnits.length ? payloadOf(mainText) : payloadOf("");
    main = makeActivity({
      name, activation: detectActivation(block[0]) ?? "special",
      condition: detectActivation(block[0]) ? "" : conditionLabel(block[0]),
      ...mp, onSave: parseOnSave(mainText),
      concentration: concentrationRequired(text),
      range: parseRange(text), duration, target: parseTarget(text), consume: !!result.uses
    });
    // Healing or temp HP alongside an attack, save or damage gets its own button.
    if ((mp.heal || mp.temphp) && main.type !== "heal") {
      followUps.push(makeActivity({
        name: `${name}: ${mp.heal ? "Healing" : "Temporary HP"}`, activation: "special",
        condition: conditionLabel(mainText), heal: mp.heal, temphp: mp.heal ? null : mp.temphp
      }));
    }
    // A bonus die on an ability that also rolls something else gets its own button.
    if (mp.roll && main.type !== "utility") {
      followUps.push(makeActivity({ name: `${name}: ${mp.roll.name}`, activation: "special", condition: conditionLabel(mainText), roll: mp.roll }));
    }
    for (const u of units) {
      if (mainUnits.includes(u)) continue;
      const p = payloadOf(u);
      if (!hasPayload(p)) continue;
      const healLike = (p.heal || p.temphp) && !p.parts.length;
      followUps.push(makeActivity({
        name: `${name}: ${p.save || p.attack || p.roll ? payloadLabel(p) : followUpLabel(u, healLike)}`, activation: "special",
        condition: conditionLabel(u), ...p, onSave: parseOnSave(u)
      }));
    }
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
      if (hasPayload(payloadOf(s)) || parseTemplate(s)) produced.add(s);
      const e = targetsOthers(s) ? { changes: [] } : extractChanges(s);
      if (e.changes.length || e.statuses?.length) produced.add(s);
      addTarget(s, duration);
    }
    result.activities.push(main);
    result.summary.push(`${describeActivity(main)}${main.effects ? `, applies ${describeChanges(ext)}` : ""}`);
  }

  for (const r of [...followUps, ...riders]) {
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
    if (isUsesSentence(s) || isBookkeeping(s)) continue;
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
  // No activated ability, but an area or concentration: put them on whatever the player clicks.
  if (host && !main) {
    const tpl = parseTemplate(clean);
    if (tpl && !host.target?.template) host.target = { ...(host.target ?? {}), template: tpl, prompt: true, override: false };
    if (concentrationRequired(clean)) host.duration = { units: "minute", value: "1", ...(parseDuration(clean) ?? {}), ...(host.duration ?? {}), concentration: true, override: false };
  }
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
  const signature = stableHash(JSON.stringify({
    a: activities, u: system.uses ?? null,
    e: result.effects.map(({ disabled, img, ...rest }) => rest)
  }));
  return {
    system,
    effects: result.effects,
    flag: {
      activities: activities.map(a => a._id),
      effects: result.effects.map(e => e._id),
      summary: result.summary,
      reminders: result.reminders,
      stack: result.stack ?? null,
      usesAuto: !!(supportsActivities && result.uses),
      signature
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
 * Work out a rebuild in memory: the item's full new system data and flags, plus which effects to
 * replace. Unsocketed augments on a character keep their activities in storage (see syncSocketState).
 * unchanged = the automation is identical to what's already there and its storage state is right.
 */
export function planAutomation(item, text = null) {
  const effectText = text ?? getEffectText(item);
  const result = analyzeEffect(effectText, { name: item.name, img: item.img, seed: item.id ?? item.name });
  const data = automationData(result, item.type);
  const src = item.toObject();
  src.flags ??= {};
  const F = src.flags[MODULE_ID] ?? {};
  const prev = F.auto ?? {};
  const prevActs = new Set(prev.activities ?? []);
  const onActor = item.parent?.documentName === "Actor";
  const socketed = onActor && !!equippedBy(item);
  const stash = onActor && !socketed;
  const stashedNow = Array.isArray(F.stashedActivities) ? F.stashedActivities : [];
  const systemActsNow = src.system?.activities ?? {};

  if (src.system?.activities !== undefined) {
    const kept = [...Object.values(systemActsNow), ...stashedNow].filter(a => !prevActs.has(a._id));
    const all = [...kept, ...Object.values(data.system.activities ?? {})];
    src.system.activities = stash ? {} : Object.fromEntries(all.map(a => [a._id, a]));
    F.stashedActivities = stash ? all : [];
  }
  if (data.system.uses) {
    src.system.uses = { ...(src.system.uses ?? {}), ...data.system.uses, spent: Number(src.system.uses?.spent) || 0 };
  } else if (prev.usesAuto && src.system?.uses) {
    src.system.uses = { ...src.system.uses, max: "", recovery: [] };
  }
  F.auto = data.flag;
  src.flags[MODULE_ID] = F;

  const stashConsistent = !onActor || (stash ? Object.keys(systemActsNow).length === 0 : stashedNow.length === 0);
  const unchanged = prev.signature === data.flag.signature && stashConsistent;
  return {
    result, unchanged, onActor, socketed,
    system: src.system, flags: src.flags,
    deleteEffects: (prev.effects ?? []).filter(id => item.effects.has(id)),
    createEffects: data.effects.map(e => ({ ...e, disabled: initialDisabled(e, { onActor, socketed }) })),
    stackValue: Number(F.stackValue) || 0
  };
}

/** Write a plan: one item update, then replace the module's effects. */
export async function commitPlan(item, plan) {
  const opts = { [MODULE_ID]: true };
  await item.update({ system: plan.system, flags: plan.flags }, { recursive: false, ...opts });
  if (plan.deleteEffects.length) await item.deleteEmbeddedDocuments("ActiveEffect", plan.deleteEffects, opts);
  if (plan.createEffects.length) await item.createEmbeddedDocuments("ActiveEffect", plan.createEffects, { keepId: true, ...opts });
  if (plan.result.stack && plan.socketed) await applyStackValue(item, plan.stackValue);
}

/** (Re)build automation on an existing item. Only replaces what this module generated before. */
export async function applyAutomation(item, text = null, { quiet = false, force = true } = {}) {
  const plan = planAutomation(item, text);
  if (force || !plan.unchanged) await commitPlan(item, plan);
  const result = plan.result;
  if (quiet) return result;
  ui.notifications.info(result.summary.length
    ? `${item.name}: ${result.summary.join("; ")}`
    : `${item.name}: nothing in the effect text could be automated.`);
  return result;
}
