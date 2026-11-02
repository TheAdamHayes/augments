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
/** The character's proficiency bonus. ("@prof" on an augment item can mean the item's own proficiency.) */
const PBF = "@attributes.prof";
const PB_RE = /@attributes\.prof|@prof/g;
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
    .replace(/\bPB\b/g, PBF)
    .replace(/(\d|@attributes\.prof)\s*[x×]\s*(\d|@attributes\.prof)/g, "$1 * $2")
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

const pb = s => String(s).replace(/\bPB\b/g, PBF).replace(/\s*[x×]\s*/g, " * ");
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
  if (m) return { max: m[1] ? `${m[1]} * ${PBF}` : PBF, period: per(m[2]) };
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
    parts.push({ number: null, denomination: null, bonus: "", types: [], custom: { enabled: true, formula: PBF } });
  }
  for (const mm of text.matchAll(/(?:\badd|\bdeals?|\btakes?|\+)\s*PB (?:(\w+) )?damage\b/gi)) {
    if (/\d+d\d+\s*$/.test(text.slice(0, mm.index))) continue; // "2d6 + PB fire damage": PB is part of that roll
    const type = mm[1]?.toLowerCase();
    parts.push({ number: null, denomination: null, bonus: "", types: DAMAGE_TYPES.includes(type) ? [type] : [], custom: { enabled: true, formula: PBF } });
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
    ?? text.match(new RegExp(`\\bwith (\\d+d\\d+${BONUS}) hit points`, "i"))
    // A bonus on a healing roll: "increase that healing by 1d8", "add PB to its healing", "add 1d4 to the healing"
    ?? text.match(new RegExp(`\\bincrease (?:that|the|its|their) healing by (\\d+d\\d+${BONUS}|PB)\\b`, "i"))
    ?? text.match(new RegExp(`\\bincrease (?:one|that|the|a) healing(?: or temporary[- ]hit[- ]point)? roll by (\\d+d\\d+${BONUS}|PB)\\b`, "i"))
    ?? text.match(new RegExp(`\\badd (\\d+d\\d+${BONUS}|PB) to (?:its|that|the|their|that die['’]s|each die['’]s) healing\\b`, "i"));
  return m ? toFormula(m[1]) : null;
}

/** "add 1d6 after its roll" (bonus die) or "reduce it by 2d8 + PB" (damage reduction): a rollable die. */
function parseExtraRoll(text) {
  let m = text.match(new RegExp(`\\b(?:adds?|adding) (\\d+d\\d+${BONUS})(?!\\s+(?:extra |additional )?(?:\\w+ )?damage)(?!\\s+to (?:that|the|its|their) healing)\\b`, "i"))
    ?? text.match(/(?:with (?:a )?|gains? |gain a )\+(\d+d\d+)(?: bonus)?\b/i);
  if (m) return { formula: toFormula(m[1]), name: "Bonus die" };
  m = text.match(/\bbank (\d+d\d+)(?: [a-z]+)?\b/i);
  if (m) return { formula: m[1], name: "Bank" };
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
  if (/up to PB (?:willing )?creatures/i.test(text)) return { affects: { type: "creature", count: PBF } };
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
  return /\bfor each\b|\bper (?!turn\b|round\b|short\b|long\b|day\b|rest\b|use\b|casting\b)[a-z]+\b(?! of)/i.test(s) && !/\bper (?:short|long) rest\b/i.test(s);
}

/* -------------------------------------------- */
/*  Triggers                                    */
/* -------------------------------------------- */

/** Remember which text an activity came from, so its trigger can be read afterwards. */
const fromText = (act, text) => Object.defineProperty(act, "_src", { value: text, enumerable: false, writable: true });

const AREA_WORDS = String.raw`(?:there|inside|within it|in it|in the (?:\w+ )?(?:area|field|zone|cloud|pool|canopy|bed|aura|ring|circle|storm|swarm|web|mist|fog))`;
export const TRIGGERS = {
  areaEnd: { label: "when a creature ends its turn in the area", re: new RegExp(String.raw`\b(?:ending|ends|end) (?:its|their|a) turns?\b[^.]*\b${AREA_WORDS}|\b${AREA_WORDS}\b[^.]*\b(?:ending|ends) (?:its|their|a) turns?\b|\bat the end of (?:its|their) turns?\b[^.]*\b${AREA_WORDS}`, "i"), area: true },
  areaStart: { label: "when a creature starts its turn in the area", re: new RegExp(String.raw`\b(?:starting|starts|start|begins?|beginning) (?:its|their|a) turns?\b[^.]*\b${AREA_WORDS}|\b${AREA_WORDS}\b[^.]*\b(?:starting|starts|begins?) (?:its|their|a) turns?\b|\bat the start of (?:its|their) turns?\b[^.]*\b${AREA_WORDS}`, "i"), area: true },
  areaEnter: { label: "when a creature enters the area", re: new RegExp(String.raw`\b(?:enters?|entering)\b(?:[^.]*\b${AREA_WORDS})?|\bfirst time[^.]*\benters?\b`, "i"), area: true },
  turnStart: { label: "at the start of your turn", re: /\bat (?:the start of your turn|your turn['’]s start|the start of each of your turns)\b|\bat the start of each of your turns\b/i },
  turnEnd: { label: "at the end of your turn", re: /\bat (?:the end of your turn|your turn['’]s end|the end of each of your turns)\b|\bat the end of (?:a|each|any) turn (?:on|in|during) which you\b/i },
  zeroHp: { label: "when you drop to 0 HP", re: /\b(?:you )?(?:drop|are reduced|would drop|would be reduced|fall|are dropped)\b[^.]{0,25}\bto 0 hit points\b|\bwhen reduced to 0 hit points\b|\bwhen you die\b|\bwhen you would (?:die|be killed)\b/i },
  damaged: { label: "when you take damage", re: /\bwhen you take (?:\w+ )?damage\b|\bwhen (?:an? |any )?(?:enemy|creature|attack)(?: within \d+ feet)? (?:hits|damages) you\b|\bwhen you are (?:hit|damaged)\b|\bafter (?:you )?tak(?:e|ing) damage\b|\bwhen you would take (?:\w+ )?damage\b|\breduce (?:the )?damage (?:from an attack|you take)\b(?![^.]*\bfalling\b)/i },
  bloodied: { label: "when you become bloodied", re: /\bwhen you (?:become|are first|first become) bloodied\b|\bwhen you (?:fall|drop) (?:to or )?below half your hit point maximum\b/i },
  initiative: { label: "when initiative is rolled", re: /\bwhen you roll initiative\b|\bwhen initiative is rolled\b|\bat the start of (?:a |each )?combat\b/i },
  shortRest: { label: "after a short rest", re: /\b(?:at the end of|when you finish|when you complete|after|complete) (?:a|your) short rest\b|\bor (?:finish|complete) (?:a|your) short rest\b|\bwhen you (?:finish|complete) (?:a|your) short rest\b/i },
  longRest: { label: "after a long rest", re: /\b(?:at the end of|when you finish|after|at each|at) (?:a|your|each) long rest\b|\bor (?:finish|complete) (?:a|your) long rest\b/i },
  heal: { label: "when you heal someone", re: /\bwhen you (?:restore|heal|grant (?:another creature )?healing|roll healing|use a healer['’]s kit|help or heal)\b|\bafter you restore\b|\bwhen you restore (?:an ally['’]s|another creature['’]s) hit points\b|\bwhenever you roll healing\b|\bincrease (?:one|that|the|a) healing(?: or temporary[- ]hit[- ]point)? roll\b|\bafter you heal\b|\bwhen you roll healing\b/i },
  regainHp: { label: "when you regain hit points", re: /\bwhen you regain hit points\b|\bwhen you receive healing\b|\bwhen (?:a spell|healing|an? (?:\w+ )?ally(?: within \d+ feet)?) restores your hit points\b/i },
  gainTemp: { label: "when you gain temporary hit points", re: /\bwhen you gain temporary hit points\b/i },
  castSpell: { label: "when you cast a spell", re: /\b(?:when|after) you cast (?:a |an )?(?:non-damaging |damaging |leveled |levelled )?(?:spell|cantrip)\b/i },
  spendResource: { label: "when you spend a spell slot or class feature", re: /\b(?:when|after) you (?:expend|spend|use) (?:a spell slot|an? (?:limited-use|class) feature)/i },
  hitDie: { label: "when a Hit Die is spent", re: /\bwhen (?:you|you or an? (?:adjacent |willing )?ally|an? (?:adjacent |willing )?ally)(?: within \d+ feet)? spends? (?:a |one |one or more )?hit di(?:e|ce)\b|\bwhen you spend a hit die\b|\bwhen (?:you or )?an? (?:willing )?(?:creature|ally)(?: within \d+ feet)?(?: of you)? spends? (?:a |one )?hit di(?:e|ce)\b/i },
  saveRoll: { label: "after a saving throw", re: /\bfails? a death sav(?:e|ing throw)\b|\bwhen (?:you|you or an? (?:\w+ )?ally|an? (?:\w+ )?ally)(?: within \d+ feet)? (?:fails?|succeeds? on|makes?) (?:a |an |its )?(?:\w+ )?(?:or \w+ )?sav(?:e|ing throw)\b|\bwhen you fail a save\b|\bafter you (?:succeed|fail) on (?:a|any|an?) (?:\w+ )?save\b|\bafter any saving throw\b/i },
  checkRoll: { label: "after an ability check", re: /\b(?:after|when you) fail(?:ing)? an ability check\b|\bwhen you make an ability check\b/i },
  allyDamaged: { label: "when an ally takes damage", re: /\bwhen (?:you or )?an? (?:adjacent |willing )?ally(?: within \d+ feet)?(?: of you)? (?:takes damage|is hit|is damaged)\b|\bwhen an enemy[^.]*\bdamages an ally\b|\bwhen you or an? (?:willing )?ally(?: within \d+ feet)? would take damage\b/i },
  allyBloodied: { label: "when an ally becomes bloodied", re: /\bleaves an ally[^.]*\bbloodied\b|\ban ally[^.]*\bbecomes bloodied\b/i },
  allyZero: { label: "when an ally drops to 0 HP", re: /\ban ally[^.]*\b(?:drops|is reduced|falls) to 0 hit points\b|\bwhen an? (?:willing )?ally(?: within \d+ feet)? would die\b/i },
  enemyZero: { label: "when an enemy drops to 0 HP", re: /\b(?:an enemy|a creature|a hostile creature)(?: within \d+ feet)?[^.]*\b(?:drops|is reduced|falls) to 0 hit points\b|\bwhen you reduce (?:a|an) (?:\w+ )?(?:creature|enemy|opponent)[^.]*\bto 0 hit points\b/i },
  missedBy: { label: "when an attack misses you", re: /\b(?:misses|miss) you\b|\bmisses you or an ally\b/i },
  attackHit: { label: "when you hit with an attack", re: /\bwhen you hit\b(?!\s+(?:di(?:e|ce)|points?))|\bafter (?:you hit|a hit)\b|\b(?:when|after) you (?:make an? )?(?:\w+ )?attack (?:that )?hits?\b(?!\s+(?:di(?:e|ce)|points?))|\byour (?:first |next )?(?:\w+ )?hit\b(?!\s+(?:di(?:e|ce)|points?))|\ba (?:weapon|melee|ranged|unarmed)(?: or \w+)* (?:attack )?hit\b(?!\s+(?:di(?:e|ce)|points?))|\bon a hit\b(?!\s+(?:di(?:e|ce)|points?))(?=[^.]*\b(?:once|your turn)\b)|\ba (?:weapon|melee|ranged|unarmed)?\s*attack hits\b|\bonce on your turn,? a hit\b(?!\s+(?:di(?:e|ce)|points?))|\ba hit against\b|\bwhen you score a critical hit\b(?!\s+(?:di(?:e|ce)|points?))|\bafter a (?:melee |ranged |weapon )?attack hits\b|\bafter an? (?:[\w-]+,? (?:or )?){1,6}attack hits?\b(?!\s+(?:di(?:e|ce)|points?))/i },
  dealDamage: { label: "when you deal damage", re: /\bwhen you (?:damage|deal(?: \w+)? damage)\b|\bafter (?:you damage|damaging)\b|\b(?:once on (?:each of )?your turns?|once per (?:turn|round)),? (?:when|after) you (?:damage|deal)\b|\bwhen you deal \w+ damage\b|\b(?:an? |one |the )?(?:creature|enemy|target|foe)s? you (?:damage|hit)\b|\bdamage you deal\b|\bafter (?:you )?damag(?:e|ing) (?:an? |one )?(?:enemy|creature|target)\b|\byour damaging spell deals\b/i }
};
const ONCE_RE = /\bonce (?:on (?:each of )?your turns?|per (?:turn|round)|each turn)\b|\bthe first time each (?:turn|round)\b|\byour first hit each turn\b/i;
/** "once per round" resets each round; everything else ("once per turn", "on your turn") each turn. */
const onceScope = text => (/\bonce (?:per|each) round\b|\bthe first time each round\b/i.test(text) ? "round" : "turn");

/**
 * A condition on a triggered rule that the module can check for itself during play, or a question
 * to ask the player when it can't.
 *   movedAtLeast / movedAtMost (feet this turn), noDamage (dealt no damage this turn),
 *   belowHalf (below half HP), ask (a question shown on the card).
 */
export function parseTriggerCondition(text) {
  const t = String(text ?? "");
  let m = t.match(/\bif you (?:have )?moved at least (\d+) feet\b/i);
  if (m) return { type: "movedAtLeast", n: Number(m[1]) };
  m = t.match(/\bif you (?:have )?moved no more than (\d+) feet\b/i);
  if (m) return { type: "movedAtMost", n: Number(m[1]) };
  if (/\bif you (?:did not|didn['’]t|have not|haven['’]t) moved?\b/i.test(t)) return { type: "movedAtMost", n: 0 };
  if (/\bif you (?:dealt|have dealt) no damage\b|\bif you (?:did not|didn['’]t|have not|haven['’]t) (?:deal|dealt) (?:any )?damage\b|\bon which you dealt no damage\b/i.test(t)) return { type: "noDamage" };
  if (/\bwhen you score a critical hit\b/i.test(t)) return { type: "crit" };
  if (/\bwhile (?:conscious and )?(?:you are )?below half (?:your|its) (?:hit point )?maximum\b|\bwhile (?:you are )?bloodied\b/i.test(t)) return { type: "belowHalf" };
  if (/\bif you (?:damaged|dealt damage to|hit) (?:an? )?(?:enemy|creature|target)\b/i.test(t)) return { type: "dealtDamage" };
  m = t.match(/\bif you (took|used|cast|attacked|hit|made|spent|are|were|have|did) (.+?)(?:,\s+(?:you|gain|deal|bank|move|spend|the|it|one|each|choose|add)\b|[.;]|$)/i);
  if (m) {
    const what = m[2].trim().replace(/,$/, "");
    // Help, Dodge, Study, Search, Utilize... are turns without attacks: if you dealt damage, you didn't.
    const quiet = m[1].toLowerCase() === "took" && what.split(/,\s*|\s+or\s+|\s+and\s+/).every(a => /^(?:the )?(?:help|dodge|study|search|utilize|hide|dash|disengage|influence|ready)(?: action)?$/i.test(a.replace(/^or\s+/i, "").trim()));
    return { type: "ask", text: `Only if you ${m[1]} ${what} this turn.`, quiet };
  }
  return null;
}

/** What the card's main button should do besides rolling: spend a Hit Die, or bank movement. */
function triggerAction(text) {
  if (/\b(?:may|can|might|you) spend (?:one|a|1) (?:of your (?:own )?)?hit di(?:e|ce)\b[^.]*\bto heal\b/i.test(text) && !/\bwhen (?:you|an? \w+) spends? (?:one|a|1)? ?(?:of your )?hit di/i.test(text)) return "hitDie";
  if (/\bbank (\d+d\d+) [a-z]+\b/i.test(text)) return "bankRoll";
  const m = text.match(/\bbank up to (\d+) feet of unused movement(?:, maximum (\d+))?/i);
  if (m) return "bankMovement";
  return null;
}

/**
 * Whose event counts, and from how far: "self" (only the augment's owner), "ally" (an ally within
 * range, and the owner too when the text says "you or an ally"), "enemy" (a hostile creature in range).
 */
export function triggerScope(text) {
  const t = String(text ?? "");
  const range = Number(t.match(/\bwithin (\d+) feet\b/i)?.[1]) || (/\badjacent\b/i.test(t) ? 5 : null);
  if (/\b(?:an enemy|a hostile creature|an? (?:\w+ )?opponent)\b/i.test(t) && /\b(?:drops|is reduced|falls|reduce)\b[^.]*\b0 hit points\b/i.test(t)) return { who: "enemy", range, self: false };
  if (/\b(?:an? (?:adjacent |willing )?ally|allies)\b/i.test(t)) return { who: "ally", range: range ?? 30, self: /\byou or (?:an? )?(?:adjacent |willing )?all(?:y|ies)\b/i.test(t) };
  return { who: "self", range: null, self: true };
}

/** Which moments should prompt this roll. Area triggers only apply to augments that place an area. */
export function detectTriggers(text, { hasArea = false } = {}) {
  const kinds = [];
  const t = String(text ?? "");
  for (const [kind, def] of Object.entries(TRIGGERS)) {
    if (def.area && !hasArea) continue;
    if (def.re.test(t)) kinds.push(kind);
  }
  // A creature's turn in your area isn't your turn.
  if (kinds.some(k => TRIGGERS[k].area)) return kinds.filter(k => TRIGGERS[k].area);
  return kinds;
}

const TOOLS = {
  "herbalism kit": "herb", "herbalism kits": "herb", "alchemist's supplies": "alchemist", "brewer's supplies": "brewer",
  "calligrapher's supplies": "calligrapher", "carpenter's tools": "carpenter", "cartographer's tools": "cartographer",
  "cobbler's tools": "cobbler", "cook's utensils": "cook", "glassblower's tools": "glassblower", "jeweler's tools": "jeweler",
  "leatherworker's tools": "leatherworker", "mason's tools": "mason", "painter's supplies": "painter", "potter's tools": "potter",
  "smith's tools": "smith", "tinker's tools": "tinker", "weaver's tools": "weaver", "woodcarver's tools": "woodcarver",
  "disguise kit": "disg", "forgery kit": "forg", "navigator's tools": "navg", "poisoner's kit": "pois", "thieves' tools": "thief",
  "healer's kit": null
};

/** "proficiency in Nature or herbalism kits (or expertise...)": the player picks one when it's installed. */
export function parseProficiencyChoice(text) {
  const m = String(text ?? "").replace(/\*\*/g, "").match(/\bproficiency in ([^.;]+?)(?:,? or expertise\b[^.;]*)?(?:[.;]|$)/i);
  if (!m) return null;
  const parts = m[1].split(/,\s*(?:or\s+)?|\s+or\s+/).map(x => x.trim().replace(/^(?:the|your)\s+/i, "")).filter(Boolean);
  if (parts.length < 2) return null;
  const options = [];
  for (const p of parts) {
    const k = p.toLowerCase().replace(/[’]/g, "'");
    if (SKILLS[k]) options.push({ key: `system.skills.${SKILLS[k]}.value`, label: p[0].toUpperCase() + p.slice(1) });
    else if (TOOLS[k] !== undefined && TOOLS[k]) options.push({ key: `system.tools.${TOOLS[k]}.value`, label: p[0].toUpperCase() + p.slice(1), tool: TOOLS[k] });
    else return null; // something we can't map: leave it as a reminder
  }
  return { options, expertise: /\bexpertise\b/i.test(m[0]), text: m[0].trim() };
}

/** Who an area rule is for, from the clause that names the moment: "Allies starting..." / "An enemy ending...". */
function areaSide(text) {
  const t = String(text ?? "");
  const clause = t.split(/[;.]/).find(c => /\b(?:enters?|entering|starts?|starting|ends?|ending|begins?)\b/i.test(c)) ?? t;
  const subject = clause.match(/\b(allies|ally|willing creatures?|enem(?:y|ies)|hostile creatures?|creatures?)\b/i)?.[1] ?? "";
  if (/enem|hostile/i.test(subject)) return "enemy";
  if (/all|willing/i.test(subject)) return "ally";
  return "any";
}

/**
 * Lasting rules for creatures inside an area: "Enemies inside have disadvantage on ranged attacks",
 * "enemies treat it as difficult terrain", "creatures inside are lightly obscured".
 */
function parseAuras(sentences) {
  const out = [];
  const whoOf = w => (/enem|hostile/i.test(w) ? "enemy" : /all/i.test(w) ? "ally" : "any");
  for (const s of sentences) {
    for (const m of s.matchAll(/\b(enemies|hostile creatures|creatures|allies|other creatures)(?: inside| there| in it| within it| in the area)? (?:have|has|gain) ((?:dis)?advantage on [^,.;]+?|resistance to [^,.;]+?|half cover|three-quarters cover)(?= and\b|[,.;]|$)/gi)) {
      out.push({ who: whoOf(m[1]), label: m[2].trim(), text: s });
    }
    for (const m of s.matchAll(/\b(enemies|hostile creatures|creatures|allies|other creatures)(?: inside| there| in it)? treat (?:it|the area|its area|that area) as (difficult terrain)\b/gi)) {
      out.push({ who: whoOf(m[1]), label: m[2], text: s });
    }
    if (/\b(?:the area|it|its area) is difficult terrain\b/i.test(s) && !out.some(a => a.label === "difficult terrain")) out.push({ who: "any", label: "difficult terrain", text: s });
    for (const m of s.matchAll(/\b(enemies|hostile creatures|creatures|allies)(?: inside| there| in it| within it)? (?:are|is) (lightly obscured|heavily obscured|blinded|deafened|slowed)\b/gi)) {
      out.push({ who: whoOf(m[1]), label: m[2], text: s });
    }
  }
  for (const a of out) a.changes = auraChanges(a.label);
  return out.filter((a, i) => out.findIndex(b => b.who === a.who && b.label === a.label) === i);
}

/** Mechanical part of an area rule, where dnd5e has one. */
function auraChanges(label) {
  const l = String(label).toLowerCase();
  const out = [];
  let m = l.match(/^resistance to all damage(?: except ([a-z, ]+?))?$/);
  if (m) {
    const except = (m[1] ?? "").split(/,\s*|\s+(?:and|or)\s+/).map(x => x.trim());
    for (const t of DAMAGE_TYPES) if (!except.includes(t)) out.push(change("system.traits.dr.value", "add", t));
    return out;
  }
  m = l.match(/^resistance to ([a-z, ]+?) damage$/);
  if (m) {
    for (const t of m[1].split(/,\s*|\s+(?:and|or)\s+/).map(x => x.replace(/^(?:and|or)\s+/, "").trim())) if (DAMAGE_TYPES.includes(t)) out.push(change("system.traits.dr.value", "add", t));
    return out;
  }
  if (l === "half cover") return [change("system.attributes.ac.bonus", "add", "+2"), change("system.abilities.dex.bonuses.save", "add", "+2")];
  if (l === "three-quarters cover") return [change("system.attributes.ac.bonus", "add", "+5"), change("system.abilities.dex.bonuses.save", "add", "+5")];
  return out;
}

/** Clauses describing a later or repeating instance rather than what happens on use. */
const ONGOING_RE = /\b(?:once per (?:turn|round)|each turn|whenever|(?:ending|ends|starting|starts?) (?:its|their) turns?|start of (?:its|their|each|your)|end of (?:its|their)|enters?|entering|the first time|rolls gain|again|before repeating)\b/i;

function followUpLabel(u, heal) {
  const what = heal ? "temp HP" : "damage";
  const entering = /\benters?\b|\bentering\b/i.test(u);
  const starting = /\b(?:starts?|starting) (?:its|their|a) turns?|start of (?:its|their)/i.test(u);
  if (entering && starting) return `Enter or start turn ${what}`;
  if (/\b(?:ending|ends) (?:its|their|a) turns?|end of (?:its|their) turn/i.test(u)) return `End of turn ${what}`;
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
  return /^(while|when|whenever|after|if|once per turn|the first time|until|during|at the (?:start|end))\b/i.test(s) || /\bwhile\b/i.test(s)
    || /^at your turn['’]s (?:start|end)\b/i.test(s) || /\bif you\b/i.test(s) || /\buntil (?:the start of )?your next turn\b/i.test(s);
}

/** A rule tied to a moment ("At your turn's end, ... gain +1 AC until your next turn"): a temporary effect, not a passive. */
function isTimed(s) {
  return detectTriggers(s).length > 0 || /\buntil (?:the start of )?your next turn\b|\buntil the end of (?:your|the|that) turn\b/i.test(s);
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
  else if ((m = s.match(/\bgains? (\d+) feet of (?:walking )?speed\b/i))) add("system.attributes.movement.walk", "add", m[1]);
  // "Add PB to initiative", "+2 to initiative", "gain +2 to initiative"
  if ((m = s.match(/\badd (PB|your proficiency bonus|\d+) to (?:your )?initiative\b/i) ?? s.match(/\+(\d+|PB) (?:bonus )?to (?:your )?initiative\b/i))) {
    add("system.attributes.init.bonus", "add", /pb|proficiency/i.test(m[1]) ? PBF : m[1]);
  }

  for (const mm of s.matchAll(/(\d+)-foot (climbing|flying|swimming|burrowing|climb|fly|swim|burrow) speed/gi)) {
    add(`system.attributes.movement.${MOVEMENT[mm[2].toLowerCase()]}`, "upgrade", mm[1]);
  }
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
  // "+1 to saves" (every save), "+1 to Strength checks and Strength saves"
  if ((m = s.match(/\+(\d+) (?:bonus )?to (?:all |your )?(?:saves|saving throws)\b/i)) && !isQualified(s.slice(m.index + m[0].length))) {
    add("system.bonuses.abilities.save", "add", `+${m[1]}`);
  }
  for (const mm of s.matchAll(/\+(\d+) (?:bonus )?to (strength|dexterity|constitution|intelligence|wisdom|charisma) (?:ability )?checks(?: and (?:(strength|dexterity|constitution|intelligence|wisdom|charisma) )?sav(?:es|ing throws))?/gi)) {
    if (isQualified(s.slice(mm.index + mm[0].length))) continue;
    add(`system.abilities.${ABILITIES[mm[2].toLowerCase()]}.bonuses.check`, "add", `+${mm[1]}`);
    if (/sav/i.test(mm[0])) add(`system.abilities.${ABILITIES[(mm[3] ?? mm[2]).toLowerCase()]}.bonuses.save`, "add", `+${mm[1]}`);
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
    if (k.endsWith("init.bonus")) return `+${v.replace(PB_RE, "PB")} initiative`;
    if (k === "system.bonuses.abilities.save") return `${v} to all saves`;
    const cb = k.match(/abilities\.(\w+)\.bonuses\.check/);
    if (cb) return `${v} ${cb[1].toUpperCase()} checks`;
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
  else if (/\bprevents? (?:the target|it|that creature|the creature|that target) (?:from )?regaining hit points/i.test(s)) marker = "Can't regain hit points";
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
    // "bank up to 20 feet of unused movement, maximum 60": a pool of feet, banked at turn end.
    let b = s.match(/\bbank up to (\d+) feet of unused movement(?:, maximum (\d+))?/i);
    if (b) {
      const clear = sentences.find(x => /\bclear (?:the|your) (?:reserve|bank|stored)\b[^.]*\brest\b/i.test(x));
      return { name: "Banked feet", max: b[2] ?? null, timing: "manual", gainText: s, unit: "ft", step: 5, bankPer: Number(b[1]), movement: true, clearOnRest: !!clear, loseText: clear ?? null };
    }
    // "bank 2d8 nourishment ... add it to one healing roll or one ally's damage roll within 30 feet"
    b = s.match(/\bbank (\d+d\d+) ([a-z]+)\b/i);
    if (b) {
      const rest = sentences.slice(sentences.indexOf(s) + 1).join(" ");
      const spendText = sentences.find(x => x !== s && /\badd it to\b|\bspend (?:it|the bank)\b/i.test(x)) ?? null;
      return {
        name: b[2], max: null, timing: "manual", gainText: s, banked: "total", formula: b[1],
        spendOn: [/healing roll|healing/i.test(spendText ?? rest) ? "heal" : null, /damage roll/i.test(spendText ?? rest) ? "damage" : null].filter(Boolean),
        range: Number((spendText ?? "").match(/within (\d+) feet/i)?.[1]) || null,
        allies: /\ball(?:y|ies)['’]?s?\b/i.test(spendText ?? ""),
        expires: /\bbefore your next turn ends\b|\buntil the end of your next turn\b/i.test(spendText ?? rest) ? "nextTurnEnd" : null,
        spendText
      };
    }
    // "After a long rest, gain two recovery dice, d10s": a pool refilled by the rest, spent one die at a time.
    b = s.match(/\bgain (one|two|three|four|five|six|PB|\d+) ([a-z]+ dice), (d\d+)s\b/i);
    if (b) {
      const refill = /\blong rest\b/i.test(s) ? "lr" : /\bshort rest\b/i.test(s) ? "sr" : null;
      return { name: b[2], max: maxOf(b[1]), timing: "manual", gainText: s, pool: true, die: b[3], refill };
    }
    // "bank one harvest die, a d8, maximum three"
    b = s.match(/\bbank (?:1|one|a) ([a-z][a-z'-]+(?: (?:die|dice|point|charge))?)\b[^.;]*?\bmax(?:imum)?\.?\s*(?:of )?(\d+|PB|one|two|three|four|five|six)\b/i);
    if (b) return { name: b[1], max: maxOf(b[2]), timing: "manual", gainText: s };
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
      stack.damageSentence = s;
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
    fromText(activity, stack.damageSentence ?? "");
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
  const fmt = f => String(f).replace(PB_RE, "PB").replace(/@abilities\.(\w+)\.mod/g, (_, a) => `${a.toUpperCase()} mod`).replace(/@attributes\.spell\.mod/g, "spell mod");
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
  const timed = []; // { s, self, ally }: temporary bonuses applied when their moment comes
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

  let state = null;            // "become unstarved for 1 minute": an effect the later rules depend on
  const ownerAuras = [];       // "you and allies within 10 feet gain +1 to Wisdom saves"
  for (const s of before) {
    if (isUsesSentence(s)) { produced.add(s); continue; }
    const sm = s.match(/\bbecome ([a-z][a-z'-]+)\b(?: for (\d+) (minute|hour|round)s?)?/i);
    if (sm && !state && !/^(?:bloodied|invisible|frightened|charmed|incapacitated|unconscious|prone|restrained|grappled|poisoned|stunned|paralyzed|petrified|blinded|deafened|hidden|immune|resistant|proficient|aware|able|visible|hostile|friendly|the|a|an|your)$/i.test(sm[1])) {
      const word = sm[1][0].toUpperCase() + sm[1].slice(1);
      const effect = makeEffect(`${name}: ${word}`, { changes: [], statuses: [] }, {
        transfer: false, img, duration: parseDuration(s) ?? { units: "minute", value: "1" }, description: s, kind: "self"
      });
      result.effects.push(effect);
      state = { name: effect.name, word, sentence: s, effectId: effect._id };
      result.summary.push(`State: ${word} (applied when used)`);
      produced.add(s);
    }
    const am = s.match(/\b(you and )?(?:up to \w+ )?(?:willing )?(?:allies|creatures of your choice) within (\d+) feet(?: of you)? (?:gain|have|get) (.+?)(?:[.;]|$)/i);
    if (am) {
      const ext = extractChanges(am[3]);
      if (ext.changes.length || ext.statuses.length) {
        ownerAuras.push({ range: Number(am[2]), changes: ext.changes, statuses: ext.statuses, label: describeChanges(ext), text: s });
        result.summary.push(`Around you: allies within ${am[2]} ft get ${describeChanges(ext)}`);
        markHandled(s, ["Allies"]);
      }
    }
    if (isStacking(s)) continue;
    const ext = targetsOthers(s) ? { changes: [], statuses: [] } : extractChanges(s);
    if (ext.changes.length || ext.statuses.length) {
      produced.add(s);
      if (isTimed(s)) {
        // "At your turn's end, if ..., you and one ally gain +1 AC until your next turn"
        const duration = parseDuration(s) ?? { units: "round", value: "1" };
        const self = makeEffect(name, ext, { transfer: false, img, duration, description: s, kind: "self" });
        const withAlly = /\byou and (?:one|an?|up to \w+|each|any) (?:willing )?(?:other )?all(?:y|ies)\b/i.test(s);
        const ally = withAlly ? makeEffect(`${name}: ${describeChanges(ext)}`, ext, { transfer: false, img, duration, description: s, kind: "target" }) : null;
        result.effects.push(self, ...(ally ? [ally] : []));
        timed.push({ s, self, ally });
        result.summary.push(`When it happens: ${describeChanges(ext)}${ally ? " for you and an ally" : ""}`);
        if (ally) markHandled(s, ["Allies"]);
      } else if (isConditional(s)) addToggle(s, ext);
      else {
        passive.changes.push(...ext.changes);
        passive.statuses.push(...ext.statuses);
      }
    }
    if (isConditional(s) && !/^until\b/i.test(s)) lastCondition = conditionLabel(s);
    const p = payloadOf(s);
    if (hasPayload(p)) {
      produced.add(s);
      const rider = fromText(makeActivity({
        name: `${name}: ${payloadLabel(p)}`, activation: "special", condition: conditionLabel(s),
        ...p, onSave: parseOnSave(s), range: parseRange(s), target: parseTarget(s)
      }), s);
      riders.push(rider);
      // "gain PB temporary hit points and add 1d4 to that healing": both get a button.
      if (p.heal && p.temphp && rider.type === "heal") {
        riders.push(fromText(makeActivity({ name: `${name}: Temporary HP`, activation: "special", condition: conditionLabel(s), temphp: p.temphp }), s));
      }
      if (p.roll && rider.type !== "utility") {
        riders.push(fromText(makeActivity({ name: `${name}: ${p.roll.name}`, activation: "special", condition: conditionLabel(s), roll: p.roll }), s));
      }
      if ((p.heal || p.temphp) && rider.type !== "heal") {
        riders.push(fromText(makeActivity({
          name: `${name}: ${p.heal ? "Healing" : "Temporary HP"}`, activation: "special", condition: conditionLabel(s),
          heal: p.heal, temphp: p.heal ? null : p.temphp
        }), s));
      }
    }
    if (!ownerAuras.some(a => a.text === s)) addTarget(s);
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
    // Player-started abilities (action, bonus action) have no trigger; reactions and implicit ones do.
    // Exception: an action that only sets up an area whose roll happens later ("a creature that ends
    // its turn in the area takes 2d8") - the roll itself belongs to that later moment.
    let mainSrc = ["action", "bonus"].includes(main.activation.type) ? "" : block[0];
    if (!mainSrc && main.target?.template) {
      const later = block.filter(x => /\b(?:ends?|ending|starts?|starting) (?:its|their) turn\b|\bfirst enters?\b|\benters? (?:the|it)\b/i.test(x));
      const now = block.some(x => /\bon creation\b|\bwhen (?:it|the \w+) (?:appears|is created)\b|\binitially\b|\bwhen you (?:create|place|summon)\b/i.test(x));
      if (later.length && !now) mainSrc = later.join(" ");
    }
    fromText(main, mainSrc);
    // Healing or temp HP alongside an attack, save or damage gets its own button.
    if ((mp.heal || mp.temphp) && main.type !== "heal") {
      followUps.push(fromText(makeActivity({
        name: `${name}: ${mp.heal ? "Healing" : "Temporary HP"}`, activation: "special",
        condition: conditionLabel(mainText), heal: mp.heal, temphp: mp.heal ? null : mp.temphp
      }), main._src || ""));
    }
    // A bonus die on an ability that also rolls something else gets its own button.
    if (mp.roll && main.type !== "utility") {
      followUps.push(fromText(makeActivity({ name: `${name}: ${mp.roll.name}`, activation: "special", condition: conditionLabel(mainText), roll: mp.roll }), main._src || ""));
    }
    for (const u of units) {
      if (mainUnits.includes(u)) continue;
      const p = payloadOf(u);
      if (!hasPayload(p)) continue;
      const healLike = (p.heal || p.temphp) && !p.parts.length;
      followUps.push(fromText(makeActivity({
        name: `${name}: ${p.save || p.attack || p.roll ? payloadLabel(p) : followUpLabel(u, healLike)}`, activation: "special",
        condition: conditionLabel(u), ...p, onSave: parseOnSave(u)
      }), u));
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
  if (state && !result.uses && !main) {
    tracker = fromText(makeActivity({ name, activation: "special", condition: conditionLabel(state.sentence) }), state.sentence);
    tracker.effects = [{ _id: state.effectId }];
    result.activities.push(tracker);
  }
  if (result.uses && !main && state) {
    tracker = fromText(makeActivity({ name, activation: "special", condition: conditionLabel(state.sentence), consume: true }), state.sentence);
    tracker.effects = [{ _id: state.effectId }];
    result.activities.push(tracker);
    result.summary.push(`Use: become ${state.word}`);
  } else if (result.uses && !main) {
    if (riders.length) {
      riders[0].consumption.targets = [{ type: "itemUses", target: "", value: "1", scaling: {} }];
    } else {
      tracker = fromText(makeActivity({ name, activation: "special", condition: conditionLabel(allSentences[0]), consume: true }), allSentences[0]);
      result.activities.push(tracker);
      result.summary.push("Use tracker");
    }
  }

  if (result.uses) {
    const max = result.uses.max.replace(PB_RE, "PB");
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
  if (!host && (result.reminders.length || targetEffects.length || timed.length)) {
    host = fromText(makeActivity({ name, activation: "special", condition: conditionLabel(allSentences[0]) }), allSentences[0]);
    result.activities.push(host);
  }
  if (host && targetEffects.length) host.effects = [...(host.effects ?? []), ...targetEffects.map(e => ({ _id: e._id }))];
  // No activated ability, but an area or concentration: put them on whatever the player clicks.
  if (host && !main) {
    const tpl = parseTemplate(clean);
    if (tpl && !host.target?.template) host.target = { ...(host.target ?? {}), template: tpl, prompt: true, override: false };
    if (concentrationRequired(clean)) host.duration = { units: "minute", value: "1", ...(parseDuration(clean) ?? {}), ...(host.duration ?? {}), concentration: true, override: false };
  }
  // Temporary bonuses go on the button for their moment (or whatever the player clicks).
  for (const t of timed) {
    const a = result.activities.find(x => x._src && (x._src === t.s || x._src.includes(t.s))) ?? host;
    if (!a) continue;
    a.effects = [...(a.effects ?? []), { _id: t.self._id }, ...(t.ally ? [{ _id: t.ally._id }] : [])];
  }

  // Triggers: which moments should prompt each roll during play. Each carries the rule text for the
  // card, a condition the module checks (or asks about), and any special action (Hit Die, banking).
  const hasArea = result.activities.some(a => a.target?.template);
  const areaRe = new RegExp(AREA_WORDS, "i");
  const areaText = hasArea ? allSentences.filter(x => areaRe.test(x) && !isBookkeeping(x)) : [];
  // src = the rule itself (used for the checks); shown = what the card displays.
  const entry = (activity, kinds, src, shown = src) => {
    const rolls = kinds.some(k => k === "saveRoll" || k === "checkRoll");
    return {
      activity, kinds, once: ONCE_RE.test(src), onceScope: onceScope(src), ...triggerScope(src),
      hostile: /\b(?:enem\w*|hostile)\b/i.test(src), side: areaSide(src),
      outcome: !rolls ? "any" : /\bfail/i.test(src) ? "fail" : /\bsucceed|\bsuccess/i.test(src) ? "success" : "any",
      text: shown, cond: parseTriggerCondition(src),
      death: /\bdeath sav(?:e|ing throw)/i.test(src),
      spendDie: !!result.stack?.pool && /\bone (?:die|of (?:the|your|these) dice)\b|\bspend (?:a|one) [a-z]+ die\b/i.test(src),
      dieHeals: /\brestore (?:its|the) roll(?: \+ PB)? hit points\b|\bheals? (?:by )?(?:its|the) roll\b/i.test(src),
      dieBonus: /\broll \+ PB\b/i.test(src),
      restoreHd: /\brestore (?:one|an?) (?:of (?:its|their|your) )?expended hit di(?:e|ce)\b|\b(?:and|plus) one of (?:its|their|your) expended hit di(?:e|ce)\b|\bregains? (?:one|an?) (?:of (?:its|their|your) )?expended hit di(?:e|ce)\b/i.test(src),
      restoreUse: (src.match(/\brestore (?:one|an?) expended use of (?:an? |one )?((?:simple|average|complex|perfect|special)(?:(?:,\s*|\s+or\s+)(?:simple|average|complex|perfect|special))*) augment/i)?.[1] ?? "")
        .toLowerCase().split(/,\s*|\s+or\s+/).filter(Boolean),
      sameType: /\bof (?:its|the same|that|the attack['’]s|the triggering) (?:damage )?type\b/i.test(src),
      action: triggerAction(src) ?? (result.stack?.gainText && !result.stack.movement && !result.stack.pool && src.includes(result.stack.gainText) ? "gainStack" : null)
    };
  };
  result.triggers = [];
  result.ownerAuras = ownerAuras;
  result.choice = parseProficiencyChoice(clean);
  if (result.choice) result.summary.push(`Choice: proficiency in ${result.choice.options.map(o => o.label).join(" or ")}`);
  const finish = t => {
    // Rules that only work while the state is on (everything except switching it on).
    if (state && !t.text.includes(state.sentence)) t.requires = state.name;
    // "if you damaged an enemy" after an optional damage bonus = "if you used that bonus this turn".
    if (t.cond?.type === "dealtDamage") {
      const bonus = result.activities.find(a => a.type === "damage" && result.triggers.some(x => x.activity === a._id && x.kinds.some(k => k === "dealDamage" || k === "attackHit")));
      if (bonus) t.cond = { type: "usedThisTurn", activity: bonus._id, label: bonus.name.replace(`${name}: `, "") };
    }
    return t;
  };
  for (const a of result.activities) {
    const text = a._src ?? "";
    const kinds = text ? detectTriggers(text, { hasArea }) : [];
    if (!kinds.length) continue;
    // Area moments show the area's other rules too, so nobody has to open the augment.
    const shown = kinds.some(k => TRIGGERS[k].area)
      ? [...new Set([text, ...areaText.filter(x => !text.includes(x) && !/\binitially\b|\bon creation\b/i.test(x) && /\b(?:inside|there|in it|within it|enters?|turns?)\b/i.test(x))])].join(" ")
      : text;
    result.triggers.push(finish(entry(a._id, kinds, text, shown)));
    result.summary.push(`Prompts ${kinds.map(k => TRIGGERS[k].label).join(" or ")}: ${a.name.replace(`${name}: `, "")}`);
  }
  // "drop to 1 instead, then heal 5d8": dnd5e has already dropped you to 0, so the heal adds that 1.
  for (const t of result.triggers) {
    if (!t.kinds.includes("zeroHp") || !/\bdrops? to 1\b|\bat 1 hit point\b|\bto 1 hit point instead\b/i.test(t.text)) continue;
    const a = result.activities.find(x => x._id === t.activity && x.type === "heal");
    if (a?.healing?.custom?.formula && !/\+ 1$/.test(a.healing.custom.formula)) a.healing.custom.formula = `${a.healing.custom.formula} + 1`;
  }
  // Rules with a moment but nothing to roll still get a card at that moment, with their text.
  const covered = t => result.triggers.some(x => x.text.includes(t));
  for (const r of result.reminders) {
    const kinds = detectTriggers(r.text, { hasArea });
    if (!kinds.length || covered(r.text) || kinds.some(k => TRIGGERS[k].area)) continue;
    result.triggers.push(finish(entry(tracker?._id ?? null, kinds, r.text)));
    result.summary.push(`Reminds ${kinds.map(k => TRIGGERS[k].label).join(" or ")}`);
  }
  // Allies walking into your area are reminded of what it does for them.
  const forAllies = areaText.filter(x => /\ball(?:y|ies)\b/i.test(x) && !/^as an? (?:bonus )?action\b|\binitially\b|\bon creation\b/i.test(x));
  if (forAllies.length) {
    result.triggers.push({ ...entry(null, ["areaEnter"], forAllies.join(" ")), side: "ally", who: "ally", self: false, range: null, hostile: false, once: true, onceScope: "turn", areaInfo: true, cond: null, action: null });
  }
  // Rules for creatures inside the area (disadvantage, difficult terrain...) mark them while inside.
  result.auras = hasArea ? parseAuras(allSentences) : [];
  for (const a of result.auras) result.summary.push(`Marks ${a.who === "enemy" ? "enemies" : a.who === "ally" ? "allies" : "creatures"} inside: ${a.label}`);
  if (result.reminders.length) result.summary.push(`${result.reminders.length} reminder${result.reminders.length === 1 ? "" : "s"} in chat`);

  return result;
}

/* -------------------------------------------- */
/*  Hand edits (from the audit window)          */
/* -------------------------------------------- */

/**
 * The audit window can store hand edits for an augment. They're applied on top of the reader's
 * output every time the augment is rebuilt, so later rule changes never undo them.
 * Activities and effects are keyed by position ("a0", "e1"), which is the same for the world copy
 * and every character's copy, as long as the effect text doesn't change.
 */
let overrideLookup = () => null;
export function setOverrideLookup(fn) { overrideLookup = typeof fn === "function" ? fn : () => null; }

/** Formula as people write it: PB and MOD (the augment ability modifier). */
export function formulaToText(f) {
  const mod = augMod();
  return String(f ?? "").split(mod).join("MOD").replace(PB_RE, "PB");
}
export function formulaFromText(t) {
  return String(t ?? "").replace(/\bMOD\b/gi, augMod()).replace(/\bPB\b/gi, PBF).replace(/\s+/g, " ").trim();
}

function partsToText(parts = []) {
  return parts.map(p => {
    const type = p.types?.[0] ? ` ${p.types[0]}` : "";
    if (p.custom?.enabled) return `${formulaToText(p.custom.formula)}${type}`;
    return `${p.number}d${p.denomination}${p.bonus ? ` + ${formulaToText(p.bonus)}` : ""}${type}`;
  }).join("; ");
}

function partsFromText(text) {
  return String(text ?? "").split(/[;\n]/).map(s => s.trim()).filter(Boolean).map(s => {
    const tm = s.match(new RegExp(`\\s+(${DAMAGE_TYPES.join("|")})$`, "i"));
    const types = tm ? [tm[1].toLowerCase()] : [];
    const body = tm ? s.slice(0, tm.index).trim() : s;
    const m = body.match(/^(\d+)d(\d+)\s*(?:\+\s*(.+))?$/i);
    if (m) return { number: Number(m[1]), denomination: Number(m[2]), bonus: m[3] ? formulaFromText(m[3]) : "", types, custom: { enabled: false, formula: "" } };
    return { number: null, denomination: null, bonus: "", types, custom: { enabled: true, formula: formulaFromText(body) } };
  });
}

/** An activity as the editor's plain fields. */
export function activitySpec(act, trig = null) {
  const roll = act.type === "attack" ? (act.attack?.type?.value === "ranged" ? "ranged" : "melee")
    : act.type === "heal" ? (act.healing?.types?.[0] === "healing" ? "heal" : "temphp")
    : act.type;
  return {
    name: act.name ?? "",
    activation: act.activation?.type ?? "special",
    condition: act.activation?.condition ?? "",
    roll,
    ability: act.save?.ability?.[0] ?? "dex",
    half: act.damage?.onSave === "half",
    damage: partsToText(act.damage?.parts),
    heal: act.type === "heal" ? formulaToText(act.healing?.custom?.formula ?? "") : "",
    extra: act.roll?.formula ? formulaToText(act.roll.formula) : "",
    extraName: act.roll?.name ?? "",
    area: act.target?.template?.type ? { type: act.target.template.type, size: Number(act.target.template.size) || 5 } : null,
    concentration: !!act.duration?.concentration,
    duration: act.duration?.units ? { value: act.duration.value, units: act.duration.units } : null,
    consume: !!act.consumption?.targets?.length,
    triggers: trig?.kinds ?? [],
    once: !!trig?.once
  };
}

export function activityFromSpec(spec, orig, id) {
  const r = spec.roll;
  const parts = ["save", "melee", "ranged", "damage"].includes(r) ? partsFromText(spec.damage) : [];
  let target = orig?.target ? { ...orig.target } : null;
  if (target) delete target.override;
  if (spec.area?.type && Number(spec.area.size) > 0) {
    target = { ...(target ?? {}), template: makeTemplate(spec.area.type, Number(spec.area.size)) };
    target.prompt ??= true;
  } else if (target) {
    delete target.template;
    delete target.prompt;
    if (!Object.keys(target).length) target = null;
  }
  const act = makeActivity({
    name: spec.name || orig?.name || "Augment",
    activation: spec.activation || "special",
    condition: spec.condition ?? "",
    parts,
    heal: r === "heal" ? formulaFromText(spec.heal) || null : null,
    temphp: r === "temphp" ? formulaFromText(spec.heal) || null : null,
    roll: r === "utility" && spec.extra ? { formula: formulaFromText(spec.extra), name: spec.extraName || "Roll" } : null,
    attack: r === "melee" || r === "ranged" ? r : null,
    save: r === "save" ? (spec.ability || "dex") : null,
    onSave: spec.half ? "half" : "none",
    concentration: !!spec.concentration,
    duration: spec.duration?.units ? { units: spec.duration.units, value: String(spec.duration.value ?? "1") } : null,
    range: orig?.range ? (({ override, ...rest }) => rest)(orig.range) : null,
    target,
    consume: !!spec.consume
  });
  act._id = id ?? orig?._id ?? act._id;
  if (orig?.effects) act.effects = orig.effects;
  return act;
}

/** Apply stored hand edits to a fresh analysis. Mutates and returns result. */
export function applyOverride(result, ov, { name = "Augment", seed = "" } = {}) {
  if (!ov) return result;
  const shortName = n => String(n ?? "").replace(`${name}: `, "");
  const oldDescs = new Set(result.activities.map(describeActivity));
  const oldTrig = new Map((result.triggers ?? []).map(t => [t.activity, t]));
  const outActs = [], outTrig = [];
  result.activities.forEach((a, i) => {
    const o = ov.activities?.[`a${i}`];
    if (o?.removed) return;
    if (!o?.spec) {
      outActs.push(a);
      if (oldTrig.has(a._id)) outTrig.push(oldTrig.get(a._id));
      return;
    }
    const act = activityFromSpec(o.spec, a);
    outActs.push(act);
    if (o.spec.triggers?.length) outTrig.push({ ...(oldTrig.get(a._id) ?? triggerScope(o.spec.condition)), activity: act._id, kinds: o.spec.triggers, once: !!o.spec.once, outcome: oldTrig.get(a._id)?.outcome ?? "any" });
  });
  (ov.added ?? []).forEach((spec, i) => {
    const act = activityFromSpec(spec, null, stableId(`${seed}:added:${i}`));
    outActs.push(act);
    if (spec.triggers?.length) outTrig.push({ ...triggerScope(spec.condition), activity: act._id, kinds: spec.triggers, once: !!spec.once, outcome: "any", hostile: /\benem|\bhostile/i.test(spec.condition ?? "") });
  });

  // Uses
  if (ov.uses?.none) result.uses = null;
  else if (ov.uses?.max) result.uses = { max: formulaFromText(ov.uses.max), period: ov.uses.period === "sr" ? "sr" : "lr" };
  if (!result.uses) for (const a of outActs) a.consumption.targets = [];

  // Effects
  const removedEffects = new Set(result.effects.filter((e, i) => ov.effects?.[`e${i}`]?.removed).map(e => e._id));
  result.effects = result.effects.filter(e => !removedEffects.has(e._id));
  for (const a of outActs) if (a.effects) a.effects = a.effects.filter(l => !removedEffects.has(l._id));

  if (Array.isArray(ov.reminders)) result.reminders = ov.reminders.filter(r => r?.text?.trim()).map(r => ({ tags: r.tags?.length ? r.tags : ["Rule"], text: r.text.trim() }));

  // Summary: keep the passive/toggle/for-others lines, redo the rest.
  const keep = result.summary.filter(s => !oldDescs.has(s) && ![...oldDescs].some(d => s.startsWith(`${d},`))
    && !/^Uses: |^Prompts |^\d+ reminders? in chat$|^Use tracker$/.test(s));
  const summary = [];
  if (result.uses) summary.push(`Uses: ${formulaToText(result.uses.max)} per ${result.uses.period === "sr" ? "short" : "long"} rest`);
  summary.push(...keep.filter(s => !removedEffects.size || !/^(?:Passive|Toggle|For others)/.test(s) || result.effects.length));
  summary.push(...outActs.map(describeActivity));
  for (const t of outTrig) {
    const a = outActs.find(x => x._id === t.activity);
    summary.push(`Prompts ${t.kinds.map(k => TRIGGERS[k]?.label ?? k).join(" or ")}: ${shortName(a?.name)}`);
  }
  if (result.reminders.length) summary.push(`${result.reminders.length} reminder${result.reminders.length === 1 ? "" : "s"} in chat`);
  summary.push("Edited by hand");
  result.activities = outActs;
  result.triggers = outTrig;
  result.summary = summary;
  result.edited = true;
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
  // Everything the module writes, so a change to any of it (triggers, reminders...) counts as outdated.
  const signature = stableHash(JSON.stringify({
    a: activities, u: system.uses ?? null,
    e: result.effects.map(({ disabled, img, ...rest }) => rest),
    t: result.triggers ?? [], r: result.reminders ?? [], s: result.stack ?? null, au: result.auras ?? [], oa: result.ownerAuras ?? [], ch: result.choice ?? null
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
      triggers: result.triggers ?? [],
      auras: result.auras ?? [],
      ownerAuras: result.ownerAuras ?? [],
      choice: result.choice ?? null,
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
  const seed = item.id ?? item.name;
  const result = analyzeEffect(effectText, { name: item.name, img: item.img, seed });
  let ov = null;
  try { ov = overrideLookup(item, effectText); } catch (e) { ov = null; }
  if (ov) applyOverride(result, ov, { name: item.name, seed });
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
