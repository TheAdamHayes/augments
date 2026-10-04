import {
  MODULE_ID, RARITIES, canEdit, isLocked, getSlotCount, getSlotLayout, collectAugments, getRarity, rarityColor,
  getEffectText, stripBanner, equipAugment, unequipAugment, setLocked, addAugmentFromItem, escapeHTML as esc
} from "./core.js";

export const TAB_ID = "augments";

/* -------------------------------------------- */
/*  Sheet integration                           */
/* -------------------------------------------- */

export function isAppV2(app) {
  const V2 = foundry.applications?.api?.ApplicationV2;
  return !!V2 && app instanceof V2;
}

export function getRoot(app, html) {
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

/** Sheets with the Augments tab open. dnd5e forgets unknown tabs when a sheet re-renders. */
const openOnAugments = new WeakSet();

/** Search text and rarity filter per actor, kept across re-renders. */
const filters = new Map();

export function injectAugmentTab(app, html) {
  const actor = app.actor ?? app.document;
  if (!actor || actor.documentName !== "Actor" || actor.type !== "character") return;
  const root = getRoot(app, html);
  if (!root) return;

  const nav = root.querySelector('nav.tabs[data-group="primary"]') ?? root.querySelector("nav.tabs");
  const anyTab = root.querySelector('.tab[data-group="primary"]') ?? root.querySelector(".tab[data-tab]");
  if (!nav || !anyTab) return;

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

  if (!nav.dataset.augmentsBound) {
    nav.dataset.augmentsBound = "true";
    nav.addEventListener("click", event => {
      const tab = event.target.closest("[data-tab]");
      if (!tab) return;
      if (tab.dataset.tab === TAB_ID) openOnAugments.add(app);
      else openOnAugments.delete(app);
    }, true);
  }

  navItem.addEventListener("click", () => {
    setTimeout(() => {
      const r = getRoot(app);
      const current = r?.querySelector(`.tab[data-tab="${TAB_ID}"]`);
      if (current && !current.classList.contains("active")) {
        activateTab(app, r.querySelector('nav.tabs[data-group="primary"]') ?? r.querySelector("nav.tabs"), current, group);
      }
    }, 0);
  });

  if (openOnAugments.has(app) || getActiveTab(app, group) === TAB_ID) {
    openOnAugments.add(app);
    activateTab(app, nav, section, group);
  }

  activateListeners(section, actor);
  applyFilter(section, actor);
}

/* -------------------------------------------- */
/*  Rendering                                   */
/* -------------------------------------------- */

function statusBar(actor) {
  const requireRest = game.settings.get(MODULE_ID, "requireLongRest");
  if (!requireRest) return { cls: "open", icon: "fa-dna", text: "Augments can be changed at any time.", button: "" };
  if (isLocked(actor)) {
    return {
      cls: "locked", icon: "fa-lock", text: "Locked until your next long rest.",
      button: game.user.isGM ? '<button type="button" data-augment-action="unlock"><i class="fas fa-lock-open"></i> Unlock</button>' : ""
    };
  }
  return {
    cls: "unlocked", icon: "fa-lock-open", text: "Unlocked. Install or remove augments, then lock them in.",
    button: actor.isOwner ? '<button type="button" data-augment-action="lock"><i class="fas fa-lock"></i> Lock in</button>' : ""
  };
}

function socketsHTML(actor, editable) {
  const layout = getSlotLayout(actor);
  if (!layout.length) {
    const first = game.settings.get(MODULE_ID, "firstSlotLevel");
    return `<div class="augments-empty">No augment sockets yet. The first one opens at level ${first}.</div>`;
  }
  return layout.map(slot => {
    const item = slot.item;
    const classes = ["augment-slot", item ? "filled" : "empty", slot.overflow ? "overflow" : ""].join(" ");
    const style = item ? ` style="--rarity:${rarityColor(item)}"` : "";
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
  }).join("");
}

/** Flavour text: the importer's stored physical description, or an all-italic paragraph in the description. */
function getPhysicalText(item) {
  const stored = item.flags?.[MODULE_ID]?.physical;
  if (stored) return String(stored);
  const div = document.createElement("div");
  div.innerHTML = stripBanner(item.system?.description?.value ?? "");
  const para = [...div.querySelectorAll("p")].find(p => {
    const text = p.textContent.trim();
    const em = p.querySelector("em, i");
    return text && em && em.textContent.trim() === text;
  });
  return para?.textContent.trim() ?? "";
}

/** Uses as pips: filled for remaining, hollow for spent. Large pools fall back to a number. */
function usesHTML(item) {
  const uses = item.system?.uses;
  const max = Number(uses?.max) || 0;
  if (!max) return "";
  const value = Math.max(0, Math.min(max, Number(uses.value ?? max - (Number(uses.spent) || 0))));
  const period = { sr: " per short rest", lr: " per long rest", day: " per day" }[uses.recovery?.[0]?.period] ?? "";
  const label = `${value} of ${max} uses left${period}`;
  if (max > 12) return `<span class="augment-uses-count" data-tooltip="${label}">${value}/${max}</span>`;
  const pips = Array.from({ length: max }, (_, i) => `<span class="augment-pip${i < value ? " full" : ""}"></span>`).join("");
  return `<div class="augment-uses" data-tooltip="${label}" aria-label="${label}">${pips}</div>`;
}

function rowHTML(entry, actor, editable) {
  const { item, holder, equipper } = entry;
  const rarity = getRarity(item);
  const info = RARITIES[rarity];
  const mine = equipper === actor;
  const draggable = editable && (!equipper || mine);
  const physical = getPhysicalText(item);
  const effect = getEffectText(item);

  const who = equipper ?? holder;
  const holderState = mine ? "installed" : equipper ? "equipped" : "carried";
  const holderText = mine ? "Installed in your sockets" : equipper ? `Equipped by ${equipper.name}` : `Carried by ${holder.name}`;
  const holderBadge = mine ? '<i class="fas fa-dna" inert></i>' : equipper ? '<i class="fas fa-lock" inert></i>' : "";

  const classes = ["augment-row", rarity ? `rarity-${rarity}` : "", equipper ? "equipped" : "", mine ? "mine" : ""].join(" ");
  return `<li class="${classes}" data-uuid="${esc(item.uuid)}" draggable="${draggable}"
        data-name="${esc(item.name.toLowerCase())}" data-rarity="${rarity}" style="--rarity:${rarityColor(item)}">
      <div class="augment-row-icon"><img src="${esc(item.img)}" alt=""></div>
      <div class="augment-row-main">
        <div class="augment-row-title">
          <span class="augment-row-name">${esc(item.name)}</span>
          ${info ? `<span class="augment-rarity-pill">${info.label}</span>` : ""}
        </div>
        ${physical && physical !== effect ? `<div class="augment-row-physical">${esc(physical)}</div>` : ""}
        ${effect ? `<div class="augment-row-effect">${esc(effect)}</div>` : ""}
      </div>
      <div class="augment-row-meta">
        ${usesHTML(item)}
        <div class="augment-holder ${holderState}" data-tooltip="${esc(holderText)}">
          <div class="augment-holder-token"><img src="${esc(who.img)}" alt="">${holderBadge}</div>
          <span class="augment-holder-name">${esc(who.name)}</span>
        </div>
      </div>
    </li>`;
}

function buildHTML(actor) {
  const editable = canEdit(actor);
  const status = statusBar(actor);
  const layout = getSlotLayout(actor);
  const augments = collectAugments(actor);
  const count = getSlotCount(actor);
  const used = layout.filter(s => s.item).length;
  const state = filters.get(actor.uuid) ?? { q: "", rarity: "" };

  const rarityOptions = Object.entries(RARITIES)
    .map(([key, r]) => `<option value="${key}" ${state.rarity === key ? "selected" : ""}>${r.label}</option>`).join("");

  const rows = augments.length
    ? augments.map(e => rowHTML(e, actor, editable)).join("")
    : `<li class="augments-list-empty">No augments in any player's inventory yet. Tick the Augment property on an item, or drag one here.</li>`;

  return `<div class="augments-container">
    <div class="augments-status ${status.cls}">
      <i class="fas ${status.icon}" inert></i>
      <span class="augments-status-text">${status.text}</span>
      <span class="augments-status-count">${used} / ${count} sockets</span>
      ${status.button}
    </div>
    <div class="augments-board">${socketsHTML(actor, editable)}</div>
    <div class="augments-toolbar">
      <label class="augments-search">
        <i class="fas fa-search" inert></i>
        <input type="search" placeholder="Search augments" value="${esc(state.q)}" aria-label="Search augments">
      </label>
      <select class="augments-rarity-filter" aria-label="Filter by rarity">
        <option value="">All rarities</option>${rarityOptions}
      </select>
    </div>
    <div class="augments-pool">
      <div class="augments-list-header">
        <span>Augments <span class="augments-shown"></span></span>
        <span>Uses</span>
      </div>
      <ol class="augments-list">${rows}</ol>
      <p class="augments-no-match" hidden>No augments match your search.</p>
    </div>
  </div>`;
}

function applyFilter(section, actor) {
  const state = filters.get(actor.uuid) ?? { q: "", rarity: "" };
  const rows = [...section.querySelectorAll(".augment-row")];
  let shown = 0;
  for (const row of rows) {
    const visible = (!state.q || row.dataset.name.includes(state.q)) && (!state.rarity || row.dataset.rarity === state.rarity);
    row.hidden = !visible;
    if (visible) shown++;
  }
  const counter = section.querySelector(".augments-shown");
  if (counter) counter.textContent = rows.length ? (shown === rows.length ? `(${rows.length})` : `(${shown} of ${rows.length})`) : "";
  const noMatch = section.querySelector(".augments-no-match");
  if (noMatch) noMatch.hidden = !(rows.length && shown === 0);
}

/* -------------------------------------------- */
/*  Interaction                                 */
/* -------------------------------------------- */

function readDragData(event) {
  try { return JSON.parse(event.dataTransfer.getData("text/plain")); } catch (e) { return null; }
}

function activateListeners(section, actor) {
  // Search and filter: handled here so typing never submits or re-renders the sheet.
  const search = section.querySelector(".augments-search input");
  const raritySelect = section.querySelector(".augments-rarity-filter");
  const updateFilter = () => {
    filters.set(actor.uuid, { q: search.value.trim().toLowerCase(), rarity: raritySelect.value });
    applyFilter(section, actor);
  };
  for (const el of [search, raritySelect]) {
    el.addEventListener("input", event => { event.stopPropagation(); updateFilter(); });
    el.addEventListener("change", event => { event.stopPropagation(); updateFilter(); });
  }
  search.addEventListener("keydown", event => { if (event.key === "Enter") event.preventDefault(); });

  for (const btn of section.querySelectorAll("[data-augment-action]")) {
    btn.addEventListener("click", async event => {
      event.preventDefault();
      if (btn.dataset.augmentAction === "unlock") return setLocked(actor, false);
      const ok = await confirmDialog("Lock in augments",
        "<p>Lock your augments? You won't be able to change them again until your next long rest.</p>");
      if (ok) await setLocked(actor, true);
    });
  }

  for (const el of section.querySelectorAll(".augment-row[data-uuid], .augment-socket[data-uuid]")) {
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

  const TE = foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
  const desc = await TE.enrichHTML(item.system?.description?.value ?? "", { relativeTo: item, secrets: false });
  const info = RARITIES[getRarity(item)];
  const content = `<div class="augment-card" style="--rarity:${rarityColor(item)}">
      <header><img src="${esc(item.img)}" alt=""><div><h3>${esc(item.name)}</h3>${info ? `<span class="augment-rarity-pill">${info.label}</span>` : ""}</div></header>
      <div class="augment-card-body">${desc}</div>
    </div>`;
  const DialogV2 = foundry.applications?.api?.DialogV2;
  if (DialogV2) {
    return DialogV2.prompt({ window: { title: item.name }, content, ok: { label: "Close" }, rejectClose: false });
  }
  return new Dialog({ title: item.name, content, buttons: { ok: { label: "Close" } } }).render(true);
}

export async function confirmDialog(title, content) {
  const DialogV2 = foundry.applications?.api?.DialogV2;
  if (DialogV2) return DialogV2.confirm({ window: { title }, content, rejectClose: false });
  return Dialog.confirm({ title, content });
}
