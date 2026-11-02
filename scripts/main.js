import {
  MODULE_ID, SOCKET, registerSettings, registerProperty, handleSocket, isAugment, equippedBy,
  getSlotCount, collectAugments, equipAugment, unequipAugment, setLocked, syncSocketState,
  isSocketGrant, onSocketGrantDeleted, removeSocketGrant, getSlotLayout
} from "./core.js";
import { injectHud, queueHudRefresh } from "./hud.js";
import { AugmentAudit, getBench } from "./audit.js";
import { injectAugmentTab, openAugment } from "./ui.js";
import { openImporter, importAugments } from "./importer.js";
import { injectItemSheet } from "./item-sheet.js";
import { analyzeEffect, applyAutomation } from "./automation.js";
import { assignIcons } from "./icons.js";
import { quickEquip, chooseSwapSlot, deleteAugment } from "./swap.js";
import { postAugmentCard, bindCard, applyEffectToActor, onDropCanvasData, onUpdateCombat } from "./chat.js";
import { getStack, setStackValue } from "./stacks.js";
import { registerTriggers, triggerReport } from "./triggers.js";
import { runSelfTest, stopSelfTest, lastSelfTest, openSelfTest } from "./selftest.js";
import { exportReviews, getReview, isProtected } from "./review.js";
import { allAugmentItems, updateAllAugments, openUpdateAll, convertToFeature, createSocketItems } from "./tools.js";

/** Safe "did this update touch key?" (Foundry v14 throws if the change list is missing). */
const hasChange = (changes, key) => !!changes && typeof changes === "object" && foundry.utils.hasProperty(changes, key);

Hooks.once("init", () => {
  registerSettings();
  registerProperty();
  registerTriggers();
  if (AugmentAudit) {
    game.settings.registerMenu(MODULE_ID, "audit", {
      name: "Augment audit",
      label: "Open augment audit",
      hint: "Check what every augment automates, rebuild them, and test their abilities on a test-bench character.",
      icon: "fas fa-clipboard-check",
      type: AugmentAudit,
      restricted: true
    });
  }
});

Hooks.once("ready", () => {
  game.socket.on(SOCKET, handleSocket);
  const api = {
    isAugment, equippedBy, getSlotCount, collectAugments,
    equip: equipAugment, unequip: unequipAugment, quickEquip, chooseSwapSlot, deleteAugment, setLocked,
    open: openAugment, openImporter, importAugments,
    analyze: analyzeEffect,
    automate: applyAutomation,
    assignIcons: (items = allAugmentItems(), options) => assignIcons(items, options),
    postToChat: postAugmentCard, applyEffectToActor, getStack, setStackValue,
    updateAll: updateAllAugments, openUpdateAll, convertToFeature, syncSocketState,
    createSocketItems, removeSocketGrant, getSlotLayout, refreshHud: queueHudRefresh,
    getReview, isProtected, exportReviews, triggerReport, runSelfTest, stopSelfTest, lastSelfTest, openSelfTest,
    openAudit: () => AugmentAudit && new AugmentAudit().render({ force: true }), getBench
  };
  game.modules.get(MODULE_ID).api = api;
  globalThis.Augments = api;
});

/* Character sheets: V1 (dnd5e 4.x) and ApplicationV2 (dnd5e 5.x) */
Hooks.on("renderActorSheet", injectAugmentTab);
Hooks.on("renderActorSheetV2", injectAugmentTab);

/* Item sheets: rarity selector and automation button for augments */
Hooks.on("renderItemSheet", injectItemSheet);
Hooks.on("renderItemSheetV2", injectItemSheet);

/* Long rest unlocks augments */
Hooks.on("dnd5e.restCompleted", (actor, result, config) => {
  const longRest = result?.longRest || config?.type === "long";
  if (!longRest || actor?.type !== "character") return;
  if (!game.settings.get(MODULE_ID, "requireLongRest")) return;
  if (actor.flags?.[MODULE_ID]?.locked) {
    actor.setFlag(MODULE_ID, "locked", false);
    ui.notifications.info(`${actor.name} finished a long rest: swap augments now, then lock them in.`);
  }
});

/* Keep "Equipped" in step with sockets so effects only apply while socketed */
Hooks.on("preUpdateItem", (item, changes, options) => {
  if (options?.[MODULE_ID]) return;
  if (!game.settings.get(MODULE_ID, "enforceSockets") || !isAugment(item)) return;
  const equipped = changes ? foundry.utils.getProperty(changes, "system.equipped") : undefined;
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
const refreshSheetsSoon = foundry.utils.debounce(refreshAugmentSheets, 120);
function queueRefresh() {
  refreshSheetsSoon();
  queueHudRefresh();
}

Hooks.on("createItem", item => { if (isAugment(item) || isSocketGrant(item)) queueRefresh(); });

/* Augments dropped onto a character outside the DNA tab start switched off until socketed */
Hooks.on("createItem", (item, options, userId) => {
  if (userId !== game.user.id || options?.augmentsSkipSync) return;
  if (item.parent?.documentName !== "Actor" || !isAugment(item)) return;
  syncSocketState(item, !!equippedBy(item));
});

/* After an augment's ability is used: reminders, stack counter and effects for others in chat */
Hooks.on("dnd5e.postUseActivity", activity => {
  const item = activity?.item;
  if (isAugment(item) && item.isOwner) postAugmentCard(item);
});
Hooks.on("renderChatMessageHTML", bindCard);
Hooks.on("renderChatMessage", bindCard);
Hooks.on("dropCanvasData", onDropCanvasData);
Hooks.on("updateCombat", onUpdateCombat);
Hooks.on("deleteItem", item => { if (isAugment(item) || isSocketGrant(item)) queueRefresh(); });

/* Extra sockets: only the GM hands them out, and deleting one frees its augment */
Hooks.on("preCreateItem", item => {
  if (isSocketGrant(item) && item.parent?.documentName === "Actor" && !game.user.isGM) {
    ui.notifications.warn("Only the GM can give extra augment sockets.");
    return false;
  }
});
Hooks.on("deleteItem", (item, options, userId) => {
  if (userId === game.user.id && isSocketGrant(item)) onSocketGrantDeleted(item, options);
});

/* Token controls: augments drawer */
Hooks.on("renderSceneControls", injectHud);
Hooks.on("controlToken", () => queueHudRefresh());
Hooks.on("canvasReady", () => queueHudRefresh());
Hooks.on("updateItem", (item, changes) => {
  if (isAugment(item) || hasChange(changes, "system.properties")) queueRefresh();
});
Hooks.on("updateActor", (actor, changes) => {
  if (!changes) return;
  if (hasChange(changes, `flags.${MODULE_ID}`) || "name" in changes || "img" in changes
    || hasChange(changes, "system.details.level")) queueRefresh();
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
  const all = document.createElement("button");
  all.type = "button";
  all.className = "augments-import";
  all.innerHTML = '<i class="fas fa-arrows-rotate"></i> Update all augments';
  all.addEventListener("click", () => openUpdateAll());
  const sockets = document.createElement("button");
  sockets.type = "button";
  sockets.className = "augments-import";
  sockets.innerHTML = '<i class="fas fa-circle-plus"></i> Create socket items';
  sockets.addEventListener("click", () => createSocketItems());
  actions.append(btn, all, sockets);
});
