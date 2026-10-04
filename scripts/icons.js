import { MODULE_ID } from "./core.js";

/**
 * Auto-icons: scans Foundry's built-in icon folders (and your own folder, if set) once, then scores
 * every file name against each augment's name and physical description. Words are expanded with
 * synonyms ("winch" also looks for rope/chain, "gland" for organ/sac...), biological folders get a
 * small bonus, and file names containing the rarity's colour (blue for Average, gold for Perfect...)
 * are preferred. Among equally good matches it picks by a hash of the name and avoids repeats, so a
 * big import doesn't give fifty augments the same heart.
 */

export const DEFAULT_ICON = "icons/svg/biohazard.svg";

const CORE_ROOTS = [
  "icons/commodities", "icons/creatures", "icons/magic", "icons/skills",
  "icons/equipment", "icons/tools", "icons/environment", "icons/consumables", "icons/sundries"
];

const STOPWORDS = new Set(("a an and the of to in on at for with from by into over under across along near beside " +
  "beneath behind around through up your you its it that this which while when small tiny large thin thick short long " +
  "narrow broad soft hard living fine heavy light several each one two three pair set").split(" "));

/** Augment word -> icon words to look for. Extend freely. */
export const SYNONYMS = {
  wing: ["wing", "feather", "insect"], vane: ["wing", "feather"], membrane: ["wing", "skin", "membrane"],
  heart: ["heart", "organ"], gland: ["gland", "organ", "sac", "pustule"], sac: ["sac", "pouch", "organ", "egg"],
  organ: ["organ", "heart"], stomach: ["stomach", "organ"], lung: ["lung", "organ", "wind"],
  tendon: ["tendon", "muscle", "sinew", "rope"], sinew: ["sinew", "tendon", "rope"], muscle: ["muscle", "arm"],
  claw: ["claw", "talon"], talon: ["talon", "claw"], fang: ["fang", "tooth"], tooth: ["tooth", "fang"],
  hook: ["hook", "grapple", "anchor"], anchor: ["anchor", "hook"], cable: ["rope", "chain", "cable"],
  line: ["rope", "line"], winch: ["rope", "chain", "pulley"], crane: ["rope", "chain", "hook"], tether: ["rope", "chain"],
  brace: ["armor", "plate", "belt"], girdle: ["belt", "armor"], harness: ["belt", "strap", "armor"],
  frame: ["armor", "plate"], plate: ["plate", "armor", "shield"], palm: ["hand", "fist", "palm"], hand: ["hand", "fist"],
  knuckle: ["fist", "hand"], tail: ["tail", "scorpion"], eye: ["eye"], nose: ["nose", "smell"], ear: ["ear"],
  needle: ["needle", "thorn", "spike", "dart"], blade: ["blade", "knife", "dagger"], knife: ["knife", "dagger"],
  pollen: ["pollen", "flower", "spore"], spore: ["spore", "mushroom"], fungus: ["mushroom", "fungus"],
  canopy: ["leaf", "vine", "tree"], vine: ["vine", "leaf", "plant"], garden: ["flower", "plant", "leaf"],
  nectar: ["honey", "nectar", "drop", "potion"], wax: ["wax", "candle", "honey"], amber: ["amber", "gem"],
  pouch: ["pouch", "bag"], sling: ["strap", "bag", "rope"], strap: ["strap", "belt"], clicker: ["bell", "insect"],
  signal: ["horn", "smoke", "signal"], scent: ["smoke", "smell", "flower"], weight: ["weight", "stone"],
  counterweight: ["weight", "stone"], stone: ["stone", "rock"], leap: ["jump", "leap", "boot"], lunge: ["jump", "spear"],
  dive: ["dive", "wing", "feather"], spine: ["spine", "bone"], bone: ["bone", "skull"], shell: ["shell", "carapace", "scale"],
  carapace: ["carapace", "shell", "scale"], scale: ["scale", "shell"], venom: ["poison", "venom", "vial"],
  poison: ["poison", "vial"], blood: ["blood", "drop"], skin: ["skin", "leather"], air: ["wind", "air"],
  ration: ["food", "bread", "meat"], food: ["food", "meat", "bread"], foot: ["foot", "boot"], feet: ["foot", "boot"]
};

const RARITY_COLORS = {
  simple: ["white", "pink", "rose", "pale"], average: ["orange", "peach", "tan", "amber"],
  complex: ["yellow", "cream", "gold", "beige"], perfect: ["blue", "cyan", "ice", "white"],
  special: ["green", "teal", "jade", "mint"]
};

let indexPromise = null;

function filePicker() {
  return foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
}

async function walk(source, path, depth, out) {
  let result;
  try { result = await filePicker().browse(source, path); } catch (e) { return; }
  for (const f of result.files ?? []) if (/\.(webp|png|jpe?g|svg)$/i.test(f)) out.push(f);
  if (depth > 0) await Promise.all((result.dirs ?? []).map(d => walk(source, d, depth - 1, out)));
}

export function stem(word) {
  return word.replace(/(?:ies)$/, "y").replace(/(?:es|s)$/, "");
}

export function tokenize(text) {
  return String(text ?? "").toLowerCase().split(/[^a-z]+/).filter(w => w.length > 2 && !STOPWORDS.has(w)).map(stem);
}

/** Build (once per session) the searchable list of icon files. */
export function buildIconIndex(force = false) {
  if (indexPromise && !force) return indexPromise;
  indexPromise = (async () => {
    const custom = (game.settings.get(MODULE_ID, "iconFolder") || "").trim().replace(/\/$/, "");
    const customFiles = [];
    if (custom) await walk("data", custom, 3, customFiles);
    const coreFiles = [];
    await Promise.all(CORE_ROOTS.map(root => walk("public", root, 3, coreFiles)));
    return makeIndex([...customFiles.map(p => ({ path: p, custom: true })), ...coreFiles.map(p => ({ path: p, custom: false }))]);
  })();
  return indexPromise;
}

export function makeIndex(entries) {
  return entries.map(({ path, custom }) => ({
    path, custom,
    tokens: new Set(tokenize(path.replace(/^icons\//, "").replace(/\.\w+$/, ""))),
    bio: /biological|creatures|organ/i.test(path)
  }));
}

function hash(str) {
  let h = 2166136261;
  for (const c of str) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return Math.abs(h);
}

/** Weighted search terms for an augment. */
export function searchTerms({ name = "", physical = "", effect = "" }) {
  const terms = new Map();
  const addAll = (text, weight) => {
    for (const w of tokenize(text)) {
      terms.set(w, Math.max(terms.get(w) ?? 0, weight));
      for (const syn of SYNONYMS[w] ?? []) terms.set(stem(syn), Math.max(terms.get(stem(syn)) ?? 0, weight * 0.6));
    }
  };
  addAll(effect, 0.4);
  addAll(physical, 1.5);
  addAll(name, 3);
  return terms;
}

/** Create a picker bound to an index. pick() remembers what it has used to keep icons varied. */
export function createIconPicker(index) {
  const used = new Map();
  return {
    pick({ name = "", physical = "", effect = "", rarity = "" }) {
      if (!index?.length) return DEFAULT_ICON;
      const terms = searchTerms({ name, physical, effect });
      const colors = RARITY_COLORS[rarity] ?? [];
      let best = 0;
      const scored = [];
      for (const icon of index) {
        let score = 0;
        for (const [term, weight] of terms) if (icon.tokens.has(term)) score += weight;
        if (score <= 0) continue;
        if (icon.custom) score += 2;
        if (icon.bio) score += 0.5;
        if (colors.some(c => icon.tokens.has(c))) score += 0.4;
        score -= (used.get(icon.path) ?? 0) * 1.2;
        scored.push([icon.path, score]);
        if (score > best) best = score;
      }
      if (best < 1.5) {
        // Nothing relevant: fall back to a varied biological icon.
        const bio = index.filter(i => i.bio && !i.custom);
        if (!bio.length) return DEFAULT_ICON;
        return bio[hash(name) % bio.length].path;
      }
      const top = scored.filter(([, s]) => s >= best - 0.5).map(([p]) => p).sort();
      const choice = top[hash(name) % top.length];
      used.set(choice, (used.get(choice) ?? 0) + 1);
      return choice;
    }
  };
}

/** Give icons to augment items that still have a placeholder image. */
export async function assignIcons(items, { onlyDefault = true } = {}) {
  const { getRarity, getEffectText } = await import("./core.js");
  ui.notifications.info("Augments: scanning icons...");
  const picker = createIconPicker(await buildIconIndex());
  const placeholder = /icons\/svg\/(biohazard|item-bag|mystery-man)\.svg$|^$/;
  const updates = [];
  for (const item of items) {
    if (onlyDefault && !placeholder.test(item.img ?? "")) continue;
    const f = item.flags?.[MODULE_ID] ?? {};
    updates.push({ item, img: picker.pick({ name: item.name, physical: f.physical, effect: f.effect ?? getEffectText(item), rarity: getRarity(item) }) });
  }
  for (const { item, img } of updates) await item.update({ img });
  ui.notifications.info(`Augments: updated ${updates.length} icons.`);
  return updates.length;
}
