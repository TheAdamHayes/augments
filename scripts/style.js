/**
 * Formatting suggestions for augment text, in the style of the official D&D books.
 * Pure functions (no Foundry calls), so the editor and the tests use the same rules.
 *
 * Each suggestion is a set of small edits with a reason. Nothing is applied until you tick it.
 * Two house styles: "2024" (rules glossary terms capitalised: "the Prone condition", "Fire damage",
 * "Bonus Action") and "2014" (the older lower-case style: "prone", "fire damage", "bonus action").
 */

const ABILITIES = { str: "Strength", dex: "Dexterity", con: "Constitution", int: "Intelligence", wis: "Wisdom", cha: "Charisma" };
const CONDITIONS = ["blinded", "charmed", "deafened", "frightened", "grappled", "incapacitated", "invisible", "paralyzed",
  "petrified", "poisoned", "prone", "restrained", "stunned", "unconscious"];
const DAMAGE = ["acid", "bludgeoning", "cold", "fire", "force", "lightning", "necrotic", "piercing", "poison", "psychic", "radiant", "slashing", "thunder"];
const AREAS = ["cone", "cube", "cylinder", "emanation", "line", "sphere"];
const SENSES = ["blindsight", "darkvision", "tremorsense", "truesight"];

/** 2024 glossary terms: [lower-case form, capitalised form]. Order matters (longest first). */
const TERMS = [
  ["temporary hit points", "Temporary Hit Points"], ["hit point maximum", "Hit Point maximum"], ["hit points", "Hit Points"],
  ["hit dice", "Hit Dice"], ["hit die", "Hit Die"],
  ["bonus action", "Bonus Action"], ["opportunity attack", "Opportunity Attack"], ["opportunity attacks", "Opportunity Attacks"],
  ["short rest", "Short Rest"], ["long rest", "Long Rest"], ["difficult terrain", "Difficult Terrain"],
  ["advantage", "Advantage"], ["disadvantage", "Disadvantage"], ["concentration", "Concentration"],
  ["initiative", "Initiative"], ["heroic inspiration", "Heroic Inspiration"], ["bloodied", "Bloodied"],
  ["proficiency bonus", "Proficiency Bonus"]
];

const re = (src, flags = "gi") => new RegExp(src, flags);
const SENTENCE_START = /(?:^|[.!?:]\s+|\n\s*|\|\s*|[-•]\s+)$/;

/**
 * Suggestions for one text. Each: { key, group, label, reason, edits: [{ start, end, text }], count }.
 * options.style: "2024" | "2014". options.spells: a Set of spell names (lower case) to italicise.
 */
export function suggestFormatting(text, { style = "2024", spells = null } = {}) {
  const src = String(text ?? "");
  const found = new Map();
  const taken = [];
  const free = (a, b) => !taken.some(([x, y]) => a < y && b > x);
  // Don't touch what's inside **bold** markers' names or table rules.
  const add = (key, group, label, reason, start, end, replacement) => {
    if (start === end && !replacement) return;
    if (src.slice(start, end) === replacement || !free(start, end)) return;
    taken.push([start, end]);
    const s = found.get(key) ?? { key, group, label, reason, edits: [] };
    s.edits.push({ start, end, text: replacement });
    found.set(key, s);
  };
  const each = (rx, fn) => { for (const m of src.matchAll(rx)) fn(m, m.index); };

  // ---- Tables: "Roll a d4: 1: fire; 2: cold; ..." and "on a 1-2, ...; on a 3-4, ..." --------------------------
  each(/(?:\b(?:roll|rolls|rolling) (?:a |an |the )?(d\d+)[^.:\n]{0,40}?[:.]\s*)((?:(?:on an? )?\d+(?:\s*[-–]\s*\d+)?\s*[:=,)]\s*[^;.\n]{2,120}?[;.]\s*){3,})/gi, (m, i) => {
    const die = m[1].toLowerCase();
    const rows = [...m[2].matchAll(/(?:on an? )?(\d+(?:\s*[-–]\s*\d+)?)\s*[:=,)]\s*([^;.\n]{2,120}?)[;.]/gi)].map(r => [r[1].replace(/\s*[-–]\s*/, "–"), r[2].trim()]);
    if (rows.length < 3) return;
    const lead = src.slice(i, i + m[0].length - m[2].length).trim().replace(/[.:]$/, "").replace(/^./, c => c.toUpperCase());
    const table = `${lead}:\n\n| ${die} | Effect |\n| --- | --- |\n${rows.map(([a, b]) => `| ${a} | ${b.replace(/^./, c => c.toUpperCase())} |`).join("\n")}\n\n`;
    add(`table:${i}`, "Tables", "Turn the roll results into a table", "Official books put roll results in a table.", i, i + m[0].length, table);
  });

  // ---- Units and numbers ----------------------------------------------------------------------------
  each(/\b(\d+)\s*-?\s*(?:ft\.?|foot|feet)[- ](radius|cone|cube|cylinder|emanation|line|sphere|square|wide|long|high|tall|deep)\b/gi, (m, i) =>
    add("units-adj", "Units", "Write sizes as \"20-foot\"", "Before a shape or measure the books write \"20-foot\".", i, i + m[0].length,
      `${m[1]}-foot ${m[2]}`));
  each(/\b(\d+)\s*ft\b\.?/gi, (m, i) => {
    const after = src.slice(i + m[0].length);
    const end = /^\s*[A-Z]/.test(after) || !after.trim() ? "." : "";
    add("units-ft", "Units", "Write \"ft.\" out as \"feet\"", "Rules text spells out \"feet\".", i, i + m[0].length, `${m[1]} feet${m[0].endsWith(".") ? end : ""}`);
  });
  each(/\b(\d+)D(\d+)\b/g, (m, i) => add("dice-case", "Dice", "Write dice in lower case (\"2d6\")", "Dice are written \"2d6\".", i, i + m[0].length, `${m[1]}d${m[2]}`));
  each(/\b(\d+d\d+)([+-])(\d+|PB)\b/gi, (m, i) => add("dice-space", "Dice", "Space out dice bonuses (\"2d6 + 3\")", "The books put spaces around + and − in rolls.", i, i + m[0].length, `${m[1]} ${m[2] === "-" ? "−" : "+"} ${m[3]}`));
  each(/\bDC(\d+)\b/g, (m, i) => add("dc-space", "Saving throws", "Write \"DC 13\" with a space", "", i, i + m[0].length, `DC ${m[1]}`));
  each(/\bdc (\d+)\b/g, (m, i) => add("dc-case", "Saving throws", "Write \"DC\" in capitals", "", i, i + m[0].length, `DC ${m[1]}`));

  // ---- Saving throws and checks ------------------------------------------------------------------------
  each(/\b(STR|DEX|CON|INT|WIS|CHA|Str|Dex|Con|Int|Wis|Cha)\.?\s+(saving throws?|saves?|checks?)\b/g, (m, i) => {
    const plural = /s$/.test(m[2]);
    const kind = /^c/i.test(m[2]) ? `check${plural ? "s" : ""}` : `saving throw${plural ? "s" : ""}`;
    add("ability-names", "Saving throws", "Write ability names in full (\"Dexterity saving throw\")", "The books never abbreviate abilities in rules text.", i, i + m[0].length, `${ABILITIES[m[1].toLowerCase()]} ${kind}`);
  });
  each(/\b(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma) saves?\b(?! throw)/g, (m, i) =>
    add("save-word", "Saving throws", "Write \"saving throw\" instead of \"save\" after an ability", "\"Dexterity saving throw\" is the book wording; \"save\" is fine on its own later on.", i, i + m[0].length,
      `${m[1]} saving throw${/s$/.test(m[0]) ? "s" : ""}`));

  // ---- Wording -----------------------------------------------------------------------------------------
  each(/\bcan not\b/gi, (m, i) => add("cannot", "Wording", "\"can not\" → \"cannot\"", "", i, i + m[0].length, m[0][0] === "C" ? "Cannot" : "cannot"));
  each(/\bit's (speed|AC|turn|next|own|space|reach|attack|movement|hit points|Hit Points)\b/g, (m, i) =>
    add("its", "Wording", "\"it's\" (it is) → \"its\" (belonging to it)", "", i, i + 4, "its"));
  each(/ {2,}/g, (m, i) => add("spaces", "Wording", "Remove double spaces", "", i, i + m[0].length, " "));
  each(/ +([.,;:!?])/g, (m, i) => add("space-punct", "Wording", "No space before punctuation", "", i, i + m[0].length, m[1]));
  each(/\b(\d+)\s*-\s*(\d+)\b(?=\s*(?:[:|,)]|times|$))/g, (m, i) => {
    if (/d$/i.test(src.slice(Math.max(0, i - 1), i))) return;
    add("en-dash", "Wording", "Use an en dash in number ranges (\"1–2\")", "", i, i + m[0].length, `${m[1]}–${m[2]}`);
  });
  if (src.trim() && !/[.!?)|*]\s*$/.test(src.trim()) && !/\|\s*$/.test(src.trim())) {
    const end = src.replace(/\s+$/, "").length;
    add("final-stop", "Wording", "End with a full stop", "", end, end, ".");
  }

  // ---- Capitalisation: 2024 glossary terms, or 2014 lower case -----------------------------------------
  const cap = w => w.replace(/\b[a-z]/g, c => c.toUpperCase());
  const caseEdit = (key, label, reason, i, word, want) => {
    if (word === want) return;
    if (style === "2014" && SENTENCE_START.test(src.slice(Math.max(0, i - 3), i))) return;   // sentence starts keep their capital
    add(key, "Capitalisation", label, reason, i, i + word.length, want);
  };
  const s24 = style === "2024";
  each(re(`\\b(${CONDITIONS.join("|")})\\b(?=\\s+condition|[.,;]|\\s+(?:for|until|and|or|while|by))`), (m, i) => {
    const before = src.slice(Math.max(0, i - 25), i);
    if (!/\b(?:is|are|be|becomes?|has the|have the|gains? the|the|knocked|falls?|fall|or|and)\s+$/i.test(before)) return;
    caseEdit("case-conditions", s24 ? "Capitalise conditions (\"the Prone condition\")" : "Lower-case conditions (\"prone\")",
      s24 ? "2024 books capitalise rules terms such as conditions." : "2014 books write conditions in lower case.", i, m[1], s24 ? cap(m[1].toLowerCase()) : m[1].toLowerCase());
  });
  each(re(`\\b(${DAMAGE.join("|")})(?=(?:\\s+or\\s+\\w+)?\\s+damage\\b)`), (m, i) =>
    caseEdit("case-damage", s24 ? "Capitalise damage types (\"Fire damage\")" : "Lower-case damage types (\"fire damage\")", "", i, m[1], s24 ? cap(m[1].toLowerCase()) : m[1].toLowerCase()));
  each(re(`(\\d+-foot(?:-radius)?\\s+)(${AREAS.join("|")})\\b`), (m, i) =>
    caseEdit("case-areas", s24 ? "Capitalise area shapes (\"20-foot Cone\")" : "Lower-case area shapes (\"20-foot cone\")", "", i + m[1].length, m[2], s24 ? cap(m[2].toLowerCase()) : m[2].toLowerCase()));
  each(re(`\\b(${SENSES.join("|")})\\b`), (m, i) =>
    caseEdit("case-senses", s24 ? "Capitalise senses (\"Darkvision\")" : "Lower-case senses (\"darkvision\")", "", i, m[1], s24 ? cap(m[1].toLowerCase()) : m[1].toLowerCase()));
  for (const [low, up] of TERMS) {
    each(re(`\\b${low.replace(/ /g, "\\s+")}\\b`), (m, i) => {
      if (low === "concentration" && !/\b(?:requires?|maintain|lose|losing|break|on)\s+$/i.test(src.slice(Math.max(0, i - 12), i))) return;
      if (low === "initiative" && /\broll\s+$/i.test(src.slice(Math.max(0, i - 6), i)) && !s24) return;
      caseEdit("case-terms", s24 ? "Capitalise rules terms (\"Bonus Action\", \"Advantage\", \"Long Rest\")" : "Lower-case rules terms (\"bonus action\", \"advantage\")",
        s24 ? "2024 books capitalise terms from the rules glossary." : "2014 books write rules terms in lower case.", i, m[0], s24 ? up : low);
    });
  }
  each(/\bmagic action\b/gi, (m, i) => caseEdit("case-terms", s24 ? "Capitalise rules terms (\"Bonus Action\", \"Advantage\", \"Long Rest\")" : "Lower-case rules terms (\"bonus action\", \"advantage\")", "", i, m[0], s24 ? "Magic action" : "magic action"));
  each(/\bPB\b/g, (m, i) => add("pb", "Wording", s24 ? "Write \"PB\" as \"your Proficiency Bonus\"" : "Write \"PB\" as \"your proficiency bonus\"",
    "The books spell it out. The module reads \"PB\" best, so check the automation panel before keeping this.", i, i + 2, s24 ? "your Proficiency Bonus" : "your proficiency bonus"));

  // ---- Italics and bold ---------------------------------------------------------------------------------
  if (spells?.size) {
    const names = [...spells].filter(n => n.length > 3).sort((a, b) => b.length - a.length);
    const rx = names.length ? re(`(?<![*\\w])(${names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![*\\w])`) : null;
    if (rx) each(rx, (m, i) => {
      const ctx = src.slice(Math.max(0, i - 30), i);
      if (!/\b(?:cast|casts|casting)\s+(?:the\s+|a\s+)?$|\bas if by\s+$/i.test(ctx) && !/^\s+spell\b/i.test(src.slice(i + m[0].length))) return;
      add("italic-spells", "Italics and bold", "Italicise spell names (\"*fireball*\")", "Spell names are set in italics.", i, i + m[0].length, `*${s24 ? m[0].replace(/\b[a-z]/g, c => c.toUpperCase()) : m[0].toLowerCase()}*`);
    });
  }
  // A named part at the start of a paragraph ("Overcharge: ..." or "**Overcharge.**") → ***Overcharge.***
  each(/(^|\n\s*\n|^\s*)(?:\*\*)?([A-Z][A-Za-z'’]+(?: [A-Z][A-Za-z'’]+| of| the| and){0,3})(?:\*\*)?([:.])(?:\*\*)?(?=\s+[A-Z])/g, (m, i) => {
    const name = m[2];
    if (/^(?:Effect|Rarity|Unlock|Tier|You|When|If|While|As|Once|Each|The|This|At|On)$/.test(name)) return;
    const start = i + m[1].length;
    add("bold-names", "Italics and bold", "Set named parts in bold italics (\"***Overcharge.***\")", "Named parts of a feature are bold italic and end with a full stop.", start, i + m[0].length, `***${name}.***`);
  });
  each(/\b(Trigger|Response|Hit|Miss|Failure|Success|Failure or Success|Hit or Miss)(:)(?!\*)/g, (m, i) => {
    if (/\*$/.test(src.slice(Math.max(0, i - 1), i))) return;
    add("italic-labels", "Italics and bold", "Italicise \"Trigger:\", \"Failure:\" and similar labels", "2024 stat-block style.", i, i + m[0].length, `*${m[1]}:*`);
  });

  const order = ["Tables", "Saving throws", "Units", "Dice", "Capitalisation", "Italics and bold", "Wording"];
  return [...found.values()].map(s => ({ ...s, count: s.edits.length }))
    .sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
}

/** Apply the edits of the chosen suggestions (later edits first, overlapping ones skipped). */
export function applySuggestions(text, suggestions) {
  const edits = suggestions.flatMap(s => s.edits).sort((a, b) => b.start - a.start);
  let out = String(text ?? "");
  let floor = Infinity;
  for (const e of edits) {
    if (e.end > floor) continue;
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
    floor = e.start;
  }
  return out;
}

/* -------------------------------------------- */
/*  Word diff, for showing what changed          */
/* -------------------------------------------- */

const tokens = s => String(s ?? "").match(/\s+|[A-Za-z0-9'’]+|[^\sA-Za-z0-9'’]/g) ?? [];

/** [{ type: "same" | "add" | "del", text }] between two texts, word by word. */
export function wordDiff(a, b) {
  const x = tokens(a), y = tokens(b);
  if (x.length * y.length > 400000) return [{ type: "del", text: a }, { type: "add", text: b }];
  const n = x.length, m = y.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  const push = (type, text) => { const last = out.at(-1); if (last?.type === type) last.text += text; else out.push({ type, text }); };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { push("same", x[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) push("del", x[i++]);
    else push("add", y[j++]);
  }
  while (i < n) push("del", x[i++]);
  while (j < m) push("add", y[j++]);
  return out;
}

/** A short "before → after" excerpt around one edit. */
export function editExcerpt(text, edit, pad = 28) {
  const a = Math.max(0, edit.start - pad), b = Math.min(text.length, edit.end + pad);
  return { before: (a > 0 ? "…" : "") + text.slice(a, edit.start), removed: text.slice(edit.start, edit.end), added: edit.text, after: text.slice(edit.end, b) + (b < text.length ? "…" : "") };
}
