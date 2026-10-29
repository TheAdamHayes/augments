export const MODULE_ID = "augments";
export const SOCKET = `module.${MODULE_ID}`;
export const AUGMENT_PROPERTY = "augment";

/**
 * Item types that can carry the "Augment" property.
 * Feature is recommended: features never appear in inventories (including inventory readers like
 * Argon Combat HUD), and this module only switches an augment's abilities and effects on while socketed.
 */
export const AUGMENT_ITEM_TYPES = ["feat", "equipment", "loot", "consumable", "weapon", "tool", "container"];

/** Augment rarities, in order. Colours drive the pool tint and socket rings. */
export const RARITIES = {
  simple: { label: "Simple", color: "#fcf0f0" },
  average: { label: "Average", color: "#ffe257" },
  complex: { label: "Complex", color: "#ff8a1f" },
  perfect: { label: "Perfect", color: "#59b2ff" },
  special: { label: "Special", color: "#42ffc5" }
};

const DND5E_RARITY_MAP = { common: "simple", uncommon: "average", rare: "complex", veryrare: "perfect", legendary: "perfect", artifact: "special" };

export function normalizeRarity(value) {
  const key = String(value ?? "").toLowerCase().replace(/[\s_-]+/g, "");
  if (RARITIES[key]) return key;
  return DND5E_RARITY_MAP[key] ?? "";
}

/** The augment's rarity key ("simple", "average"...), from the module flag or the dnd5e rarity as a fallback. */
export function getRarity(item) {
  const flags = item?.flags?.[MODULE_ID] ?? {};
  return normalizeRarity(flags.rarity) || normalizeRarity(flags.tier) || normalizeRarity(item?.system?.rarity);
}

export function rarityColor(item) {
  return RARITIES[getRarity(item)]?.color ?? "#8a93a6";
}

/**
 * One active effect change. Foundry v14 uses a string "type" ("add", "upgrade", "override");
 * older versions use a numeric "mode".
 */
export function change(key, type, value) {
  if (globalThis.CONST?.ACTIVE_EFFECT_CHANGE_TYPES) return { key, type, value: String(value), priority: null };
  const legacy = { add: 2, upgrade: 4, override: 5 };
  return { key, mode: legacy[type] ?? 2, value: String(value), priority: null };
}

/** Rarity order, lowest first. Augments without a rarity count as the lowest. */
export const RARITY_ORDER = ["simple", "average", "complex", "perfect", "special"];
export function rarityRank(key) {
  const i = RARITY_ORDER.indexOf(key);
  return i < 0 ? 0 : i;
}

/* -------------------------------------------- */
/*  Setup                                       */
/* -------------------------------------------- */

export function registerSettings() {
  const reg = (key, data) => game.settings.register(MODULE_ID, key, { scope: "world", config: true, ...data });

  reg("firstSlotLevel", {
    name: "First socket level",
    hint: "Character level at which the first augment socket opens.",
    type: Number, default: 2
  });
  reg("slotInterval", {
    name: "Levels per extra socket",
    hint: "A new socket opens every this many levels after the first (default: 2, 5, 8, 11, 14, 17, 20).",
    type: Number, default: 3
  });
  reg("requireLongRest", {
    name: "Lock augments between long rests",
    hint: "Augments unlock after a long rest and stay locked once the player locks them in. The GM can always unlock.",
    type: Boolean, default: true
  });
  reg("enforceSockets", {
    name: "Equip augments only through sockets",
    hint: "Stops players toggling an augment's Equipped state from the normal inventory, so its effects only apply while socketed.",
    type: Boolean, default: true
  });
  reg("hideInInventory", {
    name: "Hide augments outside the DNA tab",
    hint: "Unsocketed augments only appear in the DNA tab. Socketed augments that are Features still show in the Features tab so their actions are easy to reach. Reopen sheets after changing.",
    type: Boolean, default: true
  });
  reg("includePrimaryParty", {
    name: "Include the primary party stash",
    hint: "Off: the pool only shows augments in player characters' inventories. On: augments held by the dnd5e Primary Party group actor are included too.",
    type: Boolean, default: false
  });
  game.settings.register(MODULE_ID, "tokenControls", {
    name: "Show the augments button in token controls",
    hint: "Adds a button at the bottom of the left-hand controls that shows the installed augments of the selected token.",
    scope: "client", config: true, type: Boolean, default: true,
    onChange: () => ui.controls?.render?.()
  });
  reg("iconFolder", {
    name: "Custom augment icon folder",
    hint: "Optional folder in your user data (e.g. assets/augments). The importer's auto-icon picker checks your own art here before Foundry's built-in icons.",
    type: String, default: ""
  });
}

export function registerProperty() {
  const cfg = CONFIG.DND5E;
  if (!cfg?.itemProperties || !cfg?.validProperties) {
    console.warn(`${MODULE_ID} | Could not register the Augment item property (unexpected dnd5e version).`);
    return;
  }
  cfg.itemProperties[AUGMENT_PROPERTY] = { label: "Augment", abbreviation: "Aug" };
  for (const type of AUGMENT_ITEM_TYPES) cfg.validProperties[type]?.add?.(AUGMENT_PROPERTY);
}

/* -------------------------------------------- */
/*  Queries                                     */
/* -------------------------------------------- */

/* Extra socket actions registered by other parts of the module (chat effects, etc.). */
const socketHandlers = new Map();
export function registerSocketHandler(action, fn) {
  socketHandlers.set(action, fn);
}

export function isAugment(item) {
  if (!item) return false;
  const props = item.system?.properties;
  if (props instanceof Set && props.has(AUGMENT_PROPERTY)) return true;
  if (Array.isArray(props) && props.includes(AUGMENT_PROPERTY)) return true;
  return item.flags?.[MODULE_ID]?.isAugment === true;
}

/* -------------------------------------------- */
/*  Sockets                                     */
/* -------------------------------------------- */

/** Base sockets earned from character level. */
export function getSlotCount(actor) {
  const level = Number(actor?.system?.details?.level ?? 0);
  const first = Number(game.settings.get(MODULE_ID, "firstSlotLevel")) || 2;
  const interval = Math.max(1, Number(game.settings.get(MODULE_ID, "slotInterval")) || 3);
  if (level < first) return 0;
  return Math.floor((level - first) / interval) + 1;
}

/** Items that grant an extra socket capped at a rarity ("Average Augment Socket"...). */
export function isSocketGrant(item) {
  return !!item?.flags?.[MODULE_ID]?.socketGrant?.rarity;
}

export function grantRarity(grant) {
  return normalizeRarity(grant?.flags?.[MODULE_ID]?.socketGrant?.rarity) || "simple";
}

export function getSocketGrants(actor) {
  return (actor?.items?.contents ?? []).filter(isSocketGrant)
    .sort((a, b) => ((a.sort ?? 0) - (b.sort ?? 0)) || a.id.localeCompare(b.id));
}

/** Base socket assignments: item ids by index, with missing items replaced by null. */
export function getSlots(actor) {
  const raw = actor?.flags?.[MODULE_ID]?.slots;
  if (!Array.isArray(raw)) return [];
  return raw.map(id => (typeof id === "string" && actor.items.has(id)) ? id : null);
}

/** Extra socket assignments keyed by the granting item's id. */
function getExtraSlots(actor) {
  const raw = actor?.flags?.[MODULE_ID]?.extraSlots ?? {};
  const out = {};
  for (const grant of getSocketGrants(actor)) {
    const id = raw[grant.id];
    out[grant.id] = (typeof id === "string" && actor.items.has(id)) ? id : null;
  }
  return out;
}

export function getTotalSlotCount(actor) {
  return getSlotCount(actor) + getSocketGrants(actor).length;
}

/**
 * Every socket to display, in order: level sockets (key "b0", "b1"...), any filled sockets beyond
 * the level allowance (after a level drop, marked overflow), then extra sockets (key "g<itemId>").
 */
export function getSlotLayout(actor) {
  const count = getSlotCount(actor);
  const slots = getSlots(actor);
  let lastFilled = -1;
  slots.forEach((id, i) => { if (id) lastFilled = i; });
  const length = Math.max(count, lastFilled + 1);
  const layout = Array.from({ length }, (_, i) => {
    const itemId = slots[i] ?? null;
    return { key: `b${i}`, index: i, itemId, item: itemId ? actor.items.get(itemId) : null, overflow: i >= count, grant: null, maxRarity: null };
  });
  const extra = getExtraSlots(actor);
  getSocketGrants(actor).forEach((grant, j) => {
    const itemId = extra[grant.id];
    layout.push({
      key: `g${grant.id}`, index: length + j, itemId, item: itemId ? actor.items.get(itemId) : null,
      overflow: false, grant, maxRarity: grantRarity(grant)
    });
  });
  return layout;
}

/** Older code passed a number for level sockets. */
function normalizeKey(key) {
  return typeof key === "number" ? `b${key}` : String(key);
}

/** Can this socket hold this augment? Extra sockets only take their rarity or lower. */
export function slotAccepts(slot, item) {
  if (!slot || slot.overflow) return false;
  if (!slot.maxRarity) return true;
  return rarityRank(getRarity(item)) <= rarityRank(slot.maxRarity);
}

export function slotCapLabel(slot) {
  return slot?.maxRarity ? `${RARITIES[slot.maxRarity]?.label ?? slot.maxRarity} or lower` : "";
}

async function writeLayout(actor, layout) {
  const count = getSlotCount(actor);
  const base = layout.filter(s => !s.grant).map(s => s.itemId ?? null);
  while (base.length > count && base[base.length - 1] === null) base.pop();
  const extra = {};
  for (const s of layout) if (s.grant) extra[s.grant.id] = s.itemId ?? null;
  await actor.update({ [`flags.${MODULE_ID}.slots`]: base, [`flags.${MODULE_ID}.extraSlots`]: extra });
}

/** The actor that currently has this augment socketed, or null. */
export function equippedBy(item) {
  const actor = item?.parent;
  if (!actor || actor.documentName !== "Actor") return null;
  if (getSlots(actor).includes(item.id)) return actor;
  return Object.values(getExtraSlots(actor)).includes(item.id) ? actor : null;
}

export function isLocked(actor) {
  if (!game.settings.get(MODULE_ID, "requireLongRest")) return false;
  return actor?.flags?.[MODULE_ID]?.locked === true;
}

export function canEdit(actor, user = game.user) {
  if (!actor) return false;
  if (user.isGM) return true;
  return actor.testUserPermission(user, "OWNER") && !isLocked(actor);
}

/** Actors whose augments make up the shared pool. */
export function getSourceActors(extra = null) {
  const actors = game.actors.filter(a => a.type === "character" && a.hasPlayerOwner);
  if (game.settings.get(MODULE_ID, "includePrimaryParty")) {
    try {
      const party = game.settings.get("dnd5e", "primaryParty")?.actor;
      if (party && !actors.includes(party)) actors.push(party);
    } catch (e) { /* setting not present in this dnd5e version */ }
  }
  if (extra && !actors.includes(extra)) actors.push(extra);
  return actors;
}

export function collectAugments(extra = null) {
  const out = [];
  for (const holder of getSourceActors(extra)) {
    for (const item of holder.items) {
      if (isAugment(item)) out.push({ item, holder, equipper: equippedBy(item) });
    }
  }
  // Equipped augments first: the viewing character's own installed ones, then other players'
  // installed ones, then everything not socketed. Alphabetical within each group.
  const rank = e => !e.equipper ? 2 : (extra && e.equipper === extra ? 0 : 1);
  return out.sort((a, b) => (rank(a) - rank(b)) || a.item.name.localeCompare(b.item.name));
}

/* -------------------------------------------- */
/*  "Equipped by" description banner            */
/* -------------------------------------------- */

const BANNER_CLASS_RE = /^\s*<p[^>]*class="[^"]*augment-equipped-banner[^"]*"[^>]*>[\s\S]*?<\/p>\s*/i;
// Fallback in case the rich-text editor stripped the class on a later edit.
const BANNER_TEXT_RE = /^\s*<p>\s*<strong>\s*Equipped by [^<]*<\/strong>\s*<\/p>\s*/i;

export function escapeHTML(str) {
  return String(str ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** "**text**" -> <strong>text</strong> (HTML-escaped first). Any unpaired "**" is dropped. */
export function boldMarkdown(text) {
  return escapeHTML(text).replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>").replace(/\*\*/g, "");
}

/** Remove "**" markers, for places that can't show bold (names, rarity, automation). */
export function stripMarkdown(text) {
  return String(text ?? "").replace(/\*\*/g, "").trim();
}

export function stripBanner(html) {
  return String(html ?? "").replace(BANNER_CLASS_RE, "").replace(BANNER_TEXT_RE, "");
}

export function addBanner(html, name) {
  return `<p class="augment-equipped-banner"><strong>Equipped by ${escapeHTML(name)}</strong></p>${stripBanner(html)}`;
}

function stateUpdate(item, actor, socketed) {
  const update = { _id: item.id, [`flags.${MODULE_ID}.equippedBy`]: socketed ? actor.name : null };
  if (item.system?.equipped !== undefined) update["system.equipped"] = socketed;
  const desc = item.system?.description?.value;
  if (typeof desc === "string") update["system.description.value"] = socketed ? addBanner(desc, actor.name) : stripBanner(desc);
  return update;
}

/**
 * Switch an augment's mechanics on or off to match whether it's socketed.
 * Unsocketed: its activities move into a flag (so action lists and HUDs don't show them) and its
 * transferred effects are disabled. Socketed: activities come back, passive effects switch on,
 * toggles stay as the player left them and stack effects follow the stack count.
 */
export async function syncSocketState(item, socketed) {
  if (!item?.parent || item.parent.documentName !== "Actor") return;
  const opts = { [MODULE_ID]: true };
  const F = item.flags?.[MODULE_ID] ?? {};
  const stashed = Array.isArray(F.stashedActivities) ? F.stashedActivities : [];
  const acts = item.system?.activities;
  const moveIn = socketed && stashed.length;
  const moveOut = !socketed && acts !== undefined && acts.size;
  const resetStacks = !socketed && F.stackValue;
  if (moveIn || moveOut || resetStacks) {
    // One write: swap the whole activities object and the module's flags.
    const src = item.toObject();
    const mf = { ...(src.flags?.[MODULE_ID] ?? {}) };
    if (moveIn) {
      src.system.activities = { ...(src.system.activities ?? {}), ...Object.fromEntries(stashed.map(a => [a._id, a])) };
      mf.stashedActivities = [];
    } else if (moveOut) {
      mf.stashedActivities = [...stashed, ...Object.values(src.system.activities ?? {})];
      src.system.activities = {};
    }
    if (!socketed) mf.stackValue = 0;
    src.flags = { ...(src.flags ?? {}), [MODULE_ID]: mf };
    await item.update({ system: src.system, flags: src.flags }, { recursive: false, ...opts });
  }
  const stackValue = socketed ? Number(item.flags?.[MODULE_ID]?.stackValue) || 0 : 0;

  const updates = [];
  for (const e of item.effects) {
    if (!e.transfer) continue;
    const ef = e.flags?.[MODULE_ID] ?? {};
    let disabled;
    if (!socketed) disabled = true;
    else if (ef.kind === "toggle" || (!ef.kind && ef.auto && e.name.includes("("))) continue;
    else if (ef.kind === "stack") disabled = stackValue <= 0;
    else disabled = false;
    if (e.disabled !== disabled) updates.push({ _id: e.id, disabled });
  }
  if (updates.length) await item.updateEmbeddedDocuments("ActiveEffect", updates, opts);
}

/** Plain-text effect for display and automation: the importer's stored effect, or a best guess from the description. */
export function getEffectText(item) {
  const stored = item?.flags?.[MODULE_ID]?.effect;
  if (stored) return String(stored);
  const html = stripBanner(item?.system?.description?.value ?? "");
  if (!html) return "";
  const div = document.createElement("div");
  div.innerHTML = html;
  div.querySelectorAll(".secret").forEach(el => el.remove());
  const paras = [...div.querySelectorAll("p")].map(p => p.textContent.trim()).filter(Boolean);
  const labelled = paras.find(t => /^Effect\./i.test(t));
  if (labelled) return labelled.replace(/^Effect\.\s*/i, "");
  const rules = /\b(feet|damage|action|reaction|PB|advantage|gain|rest|hit points|speed|AC|save|attack)\b/i;
  return paras.find(t => rules.test(t) && !/^(Tier|Rarity|Unlock):/i.test(t)) ?? paras[0] ?? div.textContent.trim();
}

/* -------------------------------------------- */
/*  Actions                                     */
/* -------------------------------------------- */

function warn(msg) { ui.notifications.warn(msg); }

export async function equipAugment(actor, slotKey, item) {
  try {
    if (!canEdit(actor)) return warn(`${actor.name}'s augments are locked until the next long rest.`);
    if (!isAugment(item)) return warn(`${item.name} isn't an augment.`);
    const key = normalizeKey(slotKey);
    const layout = getSlotLayout(actor);
    const target = layout.find(s => s.key === key);
    if (!target || target.overflow) return warn("That socket isn't open at this level.");
    if (!slotAccepts(target, item)) {
      return warn(`That socket only holds ${slotCapLabel(target)} augments.`);
    }

    const current = equippedBy(item);
    if (current && current !== actor) return warn(`${item.name} is already equipped by ${current.name}.`);

    // Moving an augment between this actor's own sockets: swap.
    if (current === actor) {
      const from = layout.find(s => s.itemId === item.id);
      if (!from || from === target) return;
      const displaced = target.item;
      if (displaced && !slotAccepts(from, displaced)) {
        return warn(`${displaced.name} can't move into a socket that only holds ${slotCapLabel(from)} augments.`);
      }
      [from.itemId, target.itemId] = [target.itemId ?? null, from.itemId];
      return writeLayout(actor, layout);
    }

    // Pull the augment onto this actor if someone else is carrying it.
    let itemId = item.id;
    if (item.parent !== actor) {
      itemId = await requestTransfer(item, actor);
      await waitForItem(actor, itemId);
    }

    const displacedId = target.itemId;
    target.itemId = itemId;
    await writeLayout(actor, layout);

    const updates = [];
    const installed = actor.items.get(itemId);
    if (installed) updates.push(stateUpdate(installed, actor, true));
    const displaced = displacedId && displacedId !== itemId ? actor.items.get(displacedId) : null;
    if (displaced) updates.push(stateUpdate(displaced, actor, false));
    if (updates.length) await actor.updateEmbeddedDocuments("Item", updates, { [MODULE_ID]: true });
    if (installed) await syncSocketState(installed, true);
    if (displaced) await syncSocketState(displaced, false);
  } catch (err) {
    console.error(err);
    ui.notifications.error(err.message);
  }
}

/** Mark an augment as no longer socketed (banner, equipped state, abilities and effects off). */
export async function releaseAugment(actor, item) {
  if (!item) return;
  await actor.updateEmbeddedDocuments("Item", [stateUpdate(item, actor, false)], { [MODULE_ID]: true });
  await syncSocketState(item, false);
}

export async function unequipAugment(actor, slotKey) {
  try {
    if (!canEdit(actor)) return warn(`${actor.name}'s augments are locked until the next long rest.`);
    const key = normalizeKey(slotKey);
    const layout = getSlotLayout(actor);
    const slot = layout.find(s => s.key === key);
    if (!slot?.itemId) return;
    const item = actor.items.get(slot.itemId);
    slot.itemId = null;
    await writeLayout(actor, layout);
    await releaseAugment(actor, item);
  } catch (err) {
    console.error(err);
    ui.notifications.error(err.message);
  }
}

/** GM: take away an extra socket. Its augment drops back into the character's storage. */
export async function removeSocketGrant(actor, grantId) {
  if (!game.user.isGM) return warn("Only the GM can remove extra sockets.");
  const grant = actor.items.get(grantId);
  if (!grant) return;
  const layout = getSlotLayout(actor);
  const slot = layout.find(s => s.grant?.id === grantId);
  const item = slot?.itemId ? actor.items.get(slot.itemId) : null;
  if (slot) slot.itemId = null;
  await writeLayout(actor, layout);
  if (item) await releaseAugment(actor, item);
  await grant.delete({ augmentsGrantRemoval: true });
}

/** Clean up when an extra-socket item is deleted some other way (e.g. from the Features tab). */
export async function onSocketGrantDeleted(item, options) {
  if (options?.augmentsGrantRemoval) return;
  const actor = item.parent;
  if (actor?.documentName !== "Actor") return;
  const augId = actor.flags?.[MODULE_ID]?.extraSlots?.[item.id];
  if (!augId) return;
  await actor.update({ [`flags.${MODULE_ID}.extraSlots.${item.id}`]: null });
  await releaseAugment(actor, actor.items.get(augId));
}

export async function setLocked(actor, locked) {
  return actor.setFlag(MODULE_ID, "locked", locked);
}

/** Dropping a sidebar/compendium item onto the pool adds it to this actor as an augment. */
export async function addAugmentFromItem(actor, uuid) {
  const src = await fromUuid(uuid);
  if (!src || src.documentName !== "Item") return;
  if (!actor.isOwner) return warn(`You don't own ${actor.name}.`);
  if (isSocketGrant(src)) {
    if (!game.user.isGM) return warn("Only the GM can give extra augment sockets.");
    if (src.parent === actor) return;
    const grant = src.toObject();
    delete grant._id;
    await actor.createEmbeddedDocuments("Item", [grant]);
    return ui.notifications.info(`${actor.name} gained a ${grantRarity(src)} augment socket.`);
  }
  if (!AUGMENT_ITEM_TYPES.includes(src.type)) {
    return warn(`${src.name} can't be an augment. Use a Feature (or Equipment) item.`);
  }
  if (src.parent === actor) {
    if (!isAugment(src)) await src.update({ "system.properties": [...(src.system.properties ?? []), AUGMENT_PROPERTY] });
    return;
  }
  if (src.parent && isAugment(src)) return; // Augments held by others are taken via sockets.
  const data = src.toObject();
  delete data._id;
  data.system ??= {};
  data.system.properties = Array.from(new Set([...(data.system.properties ?? []), AUGMENT_PROPERTY]));
  if (data.system.equipped !== undefined) data.system.equipped = false;
  foundry.utils.setProperty(data, `flags.${MODULE_ID}.isAugment`, true);
  await actor.createEmbeddedDocuments("Item", [data]);
}

async function waitForItem(actor, id, timeout = 3000) {
  const start = Date.now();
  while (!actor.items.has(id) && Date.now() - start < timeout) await new Promise(r => setTimeout(r, 100));
}

/* -------------------------------------------- */
/*  Transfers between actors (GM-mediated)      */
/* -------------------------------------------- */

const pending = new Map();
let gmQueue = Promise.resolve();

async function performTransfer(itemUuid, target) {
  const item = await fromUuid(itemUuid);
  if (!item) throw new Error("That augment is no longer available.");
  if (!isAugment(item)) throw new Error(`${item.name} isn't an augment.`);
  if (item.parent === target) return item.id;
  if (item.parent && !getSourceActors(target).includes(item.parent)) throw new Error("That augment isn't in the party pool.");
  const current = equippedBy(item);
  if (current) throw new Error(`${item.name} is already equipped by ${current.name}.`);

  const data = item.toObject();
  delete data._id;
  if (data.system?.equipped !== undefined) data.system.equipped = false;
  if (typeof data.system?.description?.value === "string") data.system.description.value = stripBanner(data.system.description.value);
  foundry.utils.setProperty(data, `flags.${MODULE_ID}.equippedBy`, null);

  // The equip that follows switches it on; skip the automatic "store while unsocketed" step.
  const [created] = await target.createEmbeddedDocuments("Item", [data], { augmentsSkipSync: true });
  if (item.parent) await item.delete();
  return created.id;
}

function requestTransfer(item, target) {
  if (game.user.isGM) return performTransfer(item.uuid, target);
  if (!game.users.activeGM) {
    return Promise.reject(new Error(`A GM needs to be online to take ${item.name} from ${item.parent?.name ?? "another character"}.`));
  }
  return new Promise((resolve, reject) => {
    const requestId = foundry.utils.randomID();
    const timeout = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error("The GM didn't respond to the augment transfer."));
    }, 10000);
    pending.set(requestId, { resolve, reject, timeout });
    game.socket.emit(SOCKET, { action: "transfer", requestId, userId: game.user.id, itemUuid: item.uuid, targetUuid: target.uuid });
  });
}

export function handleSocket(msg) {
  if (!msg?.action) return;
  const handler = socketHandlers.get(msg.action);
  if (handler) return handler(msg);

  if (msg.action === "transfer") {
    if (game.user !== game.users.activeGM) return;
    // Process one transfer at a time so two players can't grab the same augment.
    gmQueue = gmQueue.then(async () => {
      let itemId = null;
      let error = null;
      try {
        const user = game.users.get(msg.userId);
        const target = await fromUuid(msg.targetUuid);
        if (!user || !target?.testUserPermission(user, "OWNER")) throw new Error("You don't own that character.");
        if (!user.isGM && isLocked(target)) throw new Error(`${target.name}'s augments are locked.`);
        itemId = await performTransfer(msg.itemUuid, target);
      } catch (err) {
        error = err.message;
      }
      game.socket.emit(SOCKET, { action: "transferResult", requestId: msg.requestId, userId: msg.userId, itemId, error });
    });
    return;
  }

  if (msg.action === "transferResult" && msg.userId === game.user.id) {
    const p = pending.get(msg.requestId);
    if (!p) return;
    clearTimeout(p.timeout);
    pending.delete(msg.requestId);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg.itemId);
  }
}
