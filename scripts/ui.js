import {
  MODULE_ID, canEdit, isLocked, getSlotCount, getSlotLayout, collectAugments,
  equipAugment, unequipAugment, setLocked, addAugmentFromItem, escapeHTML as esc
} from "./core.js";

export const TAB_ID = "augments";

/** Ring colours by augment tier (from the importer) or dnd5e rarity. Add your own tiers here. */
const TIER_COLORS = {
  simple: "#9aa3ad", common: "#9aa3ad",
  average: "#6cbf5a", uncommon: "#6cbf5a",
  advanced: "#4a90d9", rare: "#4a90d9",
  superior: "#a066d6", veryrare: "#a066d6",
  exceptional: "#e0a030", legendary: "#e0a030",
  artifact: "#e05050"
};

function tierColor(item) {
  const tier = String(item.flags?.[MODULE_ID]?.tier || item.system?.rarity || "").toLowerCase().replace(/[\s_-]+/g, "");
  return TIER_COLORS[tier] ?? "#8a93a6";
}

/* -------------------------------------------- */
/*  Sheet integration                           */
/* -------------------------------------------- */

function isAppV2(app) {
  const V2 = foundry.applications?.api?.ApplicationV2;
  return !!V2 && app instanceof V2;
}

function getRoot(app, html) {
  const el = app.element;
  if (el instanceof HTMLElement) return el;
  if (el?.[0] instanceof HTMLElement) return el[0];
  if (html instanceof HTMLElement) return html;
  return html?.[0] ?? null;
}

function getActiveTab(app, group) {
  if (isAppV2(app)) return app.tabGroups?.[group];
  const tabs = app._tabs ?? [];
  return (tabs.find(t => t.group === group) ?? tabs[0])?.active;
}

function rememberActiveTab(app, group) {
  if (isAppV2(app)) {
    if (app.tabGroups) app.tabGroups[group] = TAB_ID;
  } else {
    const tabs = app._tabs ?? [];
    const t = tabs.find(t => t.group === group) ?? tabs[0];
    if (t) t.active = TAB_ID;
  }
}

function activateTab(app, nav, section, group) {
  for (const el of section.parentElement.querySelectorAll(":scope > .tab[data-tab]")) {
    el.classList.toggle("active", el === section);
  }
  for (const el of nav.querySelectorAll("[data-tab]")) {
    el.classList.toggle("active", el.dataset.tab === TAB_ID);
  }
  rememberActiveTab(app, group);
}

export function injectAugmentTab(app, html) {
  const actor = app.actor ?? app.document;
  if (!actor || actor.documentName !== "Actor" || actor.type !== "character") return;
  const root = getRoot(app, html);
  if (!root) return;

  const nav = root.querySelector('nav.tabs[data-group="primary"]') ?? root.querySelector("nav.tabs");
  const anyTab = root.querySelector('.tab[data-group="primary"]') ?? root.querySelector(".tab[data-tab]");
  if (!nav || !anyTab) return;

  // Re-renders call this again; replace rather than duplicate.
  root.querySelectorAll(`.tab[data-tab="${TAB_ID}"]`).forEach(el => el.remove());
  nav.querySelectorAll(`[data-tab="${TAB_ID}"]`).forEach(el => el.remove());

  const group = anyTab.dataset.group ?? nav.dataset.group ?? "primary";

  const navItem = document.createElement("a");
  navItem.className = "item control";
  navItem.dataset.tab = TAB_ID;
  navItem.dataset.group = group;
  if (isAppV2(app)) navItem.dataset.action = "tab";
  navItem.dataset.tooltip = "Augments";
  navItem.setAttribute("aria-label", "Augments");
  navItem.innerHTML = '<i class="fas fa-dna" inert></i>';
  nav.append(navItem);

  const section = document.createElement("section");
  section.className = "tab augments-tab";
  section.dataset.tab = TAB_ID;
  section.dataset.group = group;
  section.innerHTML = buildHTML(actor);
  anyTab.parentElement.append(section);

  for (const el of section.querySelectorAll("[data-bg]")) {
    el.style.backgroundImage = `url(${JSON.stringify(el.dataset.bg)})`;
  }

  // The sheet's own tab handler usually activates us; this is a fallback for sheets where it can't.
  navItem.addEventListener("click", () => {
    setTimeout(() => { if (!section.classList.contains("active")) activateTab(app, nav, section, group); }, 0);
  });
  if (getActiveTab(app, group) === TAB_ID) activateTab(app, nav, section, group);

  activateListeners(section, actor);
}

/* -------------------------------------------- */
/*  Rendering                                   */
/* -------------------------------------------- */

function buildHTML(actor) {
  const editable = canEdit(actor);
  const requireRest = game.settings.get(MODULE_ID, "requireLongRest");
  const locked = isLocked(actor);
  const layout = getSlotLayout(actor);
  const augments = collectAugments(actor);

  let status;
  if (!requireRest) {
    status = { cls: "open", icon: "fa-dna", text: "Augments can be changed at any time.", button: "" };
  } else if (locked) {
    status = {
      cls: "locked", icon: "fa-lock", text: "Locked until your next long rest.",
      button: game.user.isGM ? '<button type="button" data-augment-action="unlock"><i class="fas fa-lock-open"></i> Unlock</button>' : ""
    };
  } else {
    status = {
      cls: "unlocked", icon: "fa-lock-open", text: "Unlocked. Install or remove augments, then lock them in.",
      button: actor.isOwner ? '<button type="button" data-augment-action="lock"><i class="fas fa-lock"></i> Lock in</button>' : ""
    };
  }

  const first = game.settings.get(MODULE_ID, "firstSlotLevel");
  const slotsHTML = layout.length ? layout.map(slot => {
    const item = slot.item;
    const classes = ["augment-slot", item ? "filled" : "empty", slot.overflow ? "overflow" : ""].join(" ");
    const style = item ? ` style="--tier-color:${tierColor(item)}"` : "";
    const label = item ? esc(item.name) : (slot.overflow ? "Over capacity" : "Empty socket");
    const socket = item
      ? `<div class="augment-socket" draggable="${editable}" data-uuid="${esc(item.uuid)}" data-tooltip="${esc(item.name)}${editable ? " (right-click to remove)" : ""}">
           <img src="${esc(item.img)}" alt="${esc(item.name)}">
         </div>`
      : `<div class="augment-socket"><i class="fas fa-plus" inert></i></div>`;
    return `<div class="${classes}" data-slot="${slot.index}"${style}>
        ${item ? `<div class="augment-slot-bg" data-bg="${esc(item.img)}"></div>` : ""}
        ${socket}
        <div class="augment-slot-label">${label}</div>
      </div>`;
  }).join("") : `<div class="augments-empty">No augment sockets yet. The first one opens at level ${first}.</div>`;

  const poolHTML = augments.length ? augments.map(({ item, holder, equipper }) => {
    const mine = equipper === actor;
    const draggable = editable && (!equipper || mine);
    const where = equipper ? `Equipped by ${equipper.name}` : `Carried by ${holder.name}`;
    const classes = ["augment-icon", equipper ? "equipped" : "", mine ? "mine" : ""].join(" ");
    return `<div class="${classes}" data-uuid="${esc(item.uuid)}" draggable="${draggable}"
          data-tooltip="${esc(item.name)}: ${esc(where)}" style="--tier-color:${tierColor(item)}">
        <img class="icon" src="${esc(item.img)}" alt="${esc(item.name)}">
        ${equipper ? `<img class="augment-badge" src="${esc(equipper.img)}" alt="${esc(equipper.name)}">` : ""}
      </div>`;
  }).join("") : `<p class="augments-pool-empty">No augments in the party yet. Tick the Augment property on an item, or drag an item here.</p>`;

  const count = getSlotCount(actor);
  const used = layout.filter(s => s.item).length;

  return `<div class="augments-container">
    <div class="augments-status ${status.cls}">
      <i class="fas ${status.icon}" inert></i>
      <span class="augments-status-text">${status.text}</span>
      <span class="augments-status-count">${used} / ${count} sockets</span>
      ${status.button}
    </div>
    <div class="augments-board" style="--slot-count:${Math.max(layout.length, 1)}">${slotsHTML}</div>
    <div class="augments-pool-header">
      <span>Party augments</span><span>${augments.length}</span>
    </div>
    <div class="augments-pool">${poolHTML}</div>
  </div>`;
}

/* -------------------------------------------- */
/*  Interaction                                 */
/* -------------------------------------------- */

function readDragData(event) {
  try { return JSON.parse(event.dataTransfer.getData("text/plain")); } catch (e) { return null; }
}

function activateListeners(section, actor) {
  for (const btn of section.querySelectorAll("[data-augment-action]")) {
    btn.addEventListener("click", async event => {
      event.preventDefault();
      if (btn.dataset.augmentAction === "unlock") return setLocked(actor, false);
      const ok = await confirmDialog("Lock in augments",
        "<p>Lock your augments? You won't be able to change them again until your next long rest.</p>");
      if (ok) await setLocked(actor, true);
    });
  }

  for (const el of section.querySelectorAll(".augment-icon[data-uuid], .augment-socket[data-uuid]")) {
    el.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      openAugment(el.dataset.uuid);
    });
  }

  for (const el of section.querySelectorAll('[draggable="true"][data-uuid]')) {
    el.addEventListener("dragstart", event => {
      event.stopPropagation();
      const slot = el.closest(".augment-slot")?.dataset.slot;
      event.dataTransfer.setData("text/plain", JSON.stringify({
        type: "Augment", uuid: el.dataset.uuid, actorUuid: actor.uuid,
        fromSlot: slot === undefined ? null : Number(slot)
      }));
      event.dataTransfer.effectAllowed = "move";
      section.classList.add("dragging");
    });
    el.addEventListener("dragend", () => section.classList.remove("dragging"));
  }

  for (const slot of section.querySelectorAll(".augment-slot")) {
    slot.addEventListener("contextmenu", event => {
      if (!slot.classList.contains("filled")) return;
      event.preventDefault();
      event.stopPropagation();
      unequipAugment(actor, Number(slot.dataset.slot));
    });
    slot.addEventListener("dragover", event => {
      event.preventDefault();
      event.stopPropagation();
      slot.classList.add("drag-over");
    });
    slot.addEventListener("dragleave", event => {
      if (!slot.contains(event.relatedTarget)) slot.classList.remove("drag-over");
    });
    slot.addEventListener("drop", async event => {
      event.preventDefault();
      event.stopPropagation();
      slot.classList.remove("drag-over");
      const data = readDragData(event);
      if (data?.type !== "Augment") return;
      const item = await fromUuid(data.uuid);
      if (item) await equipAugment(actor, Number(slot.dataset.slot), item);
    });
  }

  const pool = section.querySelector(".augments-pool");
  pool.addEventListener("dragover", event => {
    event.preventDefault();
    event.stopPropagation();
    pool.classList.add("drag-over");
  });
  pool.addEventListener("dragleave", event => {
    if (!pool.contains(event.relatedTarget)) pool.classList.remove("drag-over");
  });
  pool.addEventListener("drop", async event => {
    event.preventDefault();
    event.stopPropagation();
    pool.classList.remove("drag-over");
    let data = readDragData(event);
    if (!data) {
      const TE = foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
      data = TE?.getDragEventData?.(event);
    }
    if (data?.type === "Augment") {
      if (data.fromSlot !== null && data.fromSlot !== undefined && data.actorUuid === actor.uuid) {
        await unequipAugment(actor, data.fromSlot);
      }
    } else if (data?.type === "Item" && data.uuid) {
      await addAugmentFromItem(actor, data.uuid);
    }
  });
}

/* -------------------------------------------- */
/*  Dialogs                                     */
/* -------------------------------------------- */

export async function openAugment(uuid) {
  const item = await fromUuid(uuid);
  if (!item) return;
  if (item.testUserPermission(game.user, "OBSERVER")) return item.sheet.render(true);

  // Players can't open item sheets on other players' characters, so show a read-only card.
  const TE = foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
  const desc = await TE.enrichHTML(item.system?.description?.value ?? "", { relativeTo: item, secrets: false });
  const content = `<div class="augment-card">
      <header><img src="${esc(item.img)}" alt=""><h3>${esc(item.name)}</h3></header>
      <div class="augment-card-body">${desc}</div>
    </div>`;
  const DialogV2 = foundry.applications?.api?.DialogV2;
  if (DialogV2) {
    return DialogV2.prompt({ window: { title: item.name }, content, ok: { label: "Close" }, rejectClose: false });
  }
  return new Dialog({ title: item.name, content, buttons: { ok: { label: "Close" } } }).render(true);
}

async function confirmDialog(title, content) {
  const DialogV2 = foundry.applications?.api?.DialogV2;
  if (DialogV2) return DialogV2.confirm({ window: { title }, content, rejectClose: false });
  return Dialog.confirm({ title, content });
}
