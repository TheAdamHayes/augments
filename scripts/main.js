import {
  MODULE_ID, SOCKET, registerSettings, registerProperty, handleSocket, isAugment, equippedBy,
  getSlotCount, collectAugments, equipAugment, unequipAugment, setLocked
} from "./core.js";
import { injectAugmentTab, openAugment } from "./ui.js";
import { openImporter, importAugments } from "./importer.js";

Hooks.once("init", () => {
  registerSettings();
  registerProperty();
});

Hooks.once("ready", () => {
  game.socket.on(SOCKET, handleSocket);
  const api = {
    isAugment, equippedBy, getSlotCount, collectAugments,
    equip: equipAugment, unequip: unequipAugment, setLocked,
    open: openAugment, openImporter, importAugments
  };
  game.modules.get(MODULE_ID).api = api;
  globalThis.Augments = api;
});

/* Character sheets: V1 (dnd5e 4.x) and ApplicationV2 (dnd5e 5.x) */
Hooks.on("renderActorSheet", injectAugmentTab);
Hooks.on("renderActorSheetV2", injectAugmentTab);

/* Long rest unlocks augments */
Hooks.on("dnd5e.restCompleted", (actor, result, config) => {
  const longRest = result?.longRest || config?.type === "long";
  if (!longRest || actor?.type !== "character") return;
  if (!game.settings.get(MODULE_ID, "requireLongRest")) return;
  if (actor.flags?.[MODULE_ID]?.locked) {
    actor.setFlag(MODULE_ID, "locked", false);
    ui.notifications.info(`${actor.name} can change augments until they lock them in.`);
  }
});

/* Keep "Equipped" in step with sockets so effects only apply while socketed */
Hooks.on("preUpdateItem", (item, changes, options) => {
  if (options?.[MODULE_ID]) return;
  if (!game.settings.get(MODULE_ID, "enforceSockets") || !isAugment(item)) return;
  const equipped = foundry.utils.getProperty(changes, "system.equipped");
  if (equipped === undefined) return;
  const socketed = !!equippedBy(item);
  if (equipped !== socketed) {
    ui.notifications.warn(`${item.name} is an augment. ${socketed ? "Remove" : "Install"} it from the Augments tab.`);
    return false;
  }
});

/* Re-render open sheets showing the Augments tab when the shared pool changes */
function refreshAugmentSheets() {
  const apps = new Set([
    ...Object.values(ui.windows ?? {}),
    ...(foundry.applications?.instances?.values?.() ?? [])
  ]);
  for (const app of apps) {
    if (!app?.rendered) continue;
    const el = app.element instanceof HTMLElement ? app.element : app.element?.[0];
    if (el?.querySelector?.(".augments-tab")) app.render(false);
  }
}
const queueRefresh = foundry.utils.debounce(refreshAugmentSheets, 120);

Hooks.on("createItem", item => { if (isAugment(item)) queueRefresh(); });
Hooks.on("deleteItem", item => { if (isAugment(item)) queueRefresh(); });
Hooks.on("updateItem", (item, changes) => {
  if (isAugment(item) || foundry.utils.hasProperty(changes, "system.properties")) queueRefresh();
});
Hooks.on("updateActor", (actor, changes) => {
  if (foundry.utils.hasProperty(changes, `flags.${MODULE_ID}`) || "name" in changes || "img" in changes
    || foundry.utils.hasProperty(changes, "system.details.level")) queueRefresh();
});

/* GM shortcut in the Items sidebar */
Hooks.on("renderItemDirectory", (app, html) => {
  if (!game.user.isGM) return;
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root || root.querySelector(".augments-import")) return;
  const actions = root.querySelector(".header-actions");
  if (!actions) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "augments-import";
  btn.innerHTML = '<i class="fas fa-dna"></i> Import augments';
  btn.addEventListener("click", () => openImporter());
  actions.append(btn);
});
