import {
  RARITIES, canEdit, equippedBy, getSlotCount, getSlotLayout, getRarity, rarityColor,
  equipAugment, unequipAugment, escapeHTML as esc
} from "./core.js";

/* -------------------------------------------- */
/*  Quick equip                                 */
/* -------------------------------------------- */

/** Equip into the first free socket, or ask which augment to swap out if every socket is full. */
export async function quickEquip(actor, item) {
  if (!canEdit(actor)) return ui.notifications.warn(`${actor.name}'s augments are locked until the next long rest.`);
  const current = equippedBy(item);
  if (current === actor) return ui.notifications.info(`${item.name} is already installed.`);
  if (current) return ui.notifications.warn(`${item.name} is already equipped by ${current.name}.`);

  const count = getSlotCount(actor);
  if (!count) return ui.notifications.warn(`${actor.name} has no augment sockets yet.`);

  const layout = getSlotLayout(actor).filter(s => s.index < count);
  const free = layout.find(s => !s.item);
  if (free) return equipAugment(actor, free.index, item);

  const index = await chooseSwapSlot(actor, item, layout);
  if (index === null) return;
  return equipAugment(actor, index, item);
}

/* -------------------------------------------- */
/*  Swap chooser (animated overlay)             */
/* -------------------------------------------- */

const OUTRO_MS = 650;

function usesPips(item) {
  const uses = item.system?.uses;
  const max = Number(uses?.max) || 0;
  if (!max || max > 12) return "";
  const value = Math.max(0, Math.min(max, Number(uses.value ?? max - (Number(uses.spent) || 0))));
  return `<div class="aug-swap-pips">${Array.from({ length: max }, (_, i) =>
    `<span class="${i < value ? "full" : ""}"></span>`).join("")}</div>`;
}

function cardHTML(slot, i) {
  const item = slot.item;
  const info = RARITIES[getRarity(item)];
  return `<button type="button" class="aug-swap-card" data-slot="${slot.index}"
      style="--rarity:${rarityColor(item)};--i:${i}">
    <span class="aug-swap-card-glow"></span>
    <span class="aug-swap-card-icon"><img src="${esc(item.img)}" alt=""></span>
    <span class="aug-swap-card-name">${esc(item.name)}</span>
    ${info ? `<span class="augment-rarity-pill">${info.label}</span>` : ""}
    ${usesPips(item)}
    <span class="aug-swap-card-action"><i class="fas fa-right-left" inert></i> Swap out</span>
  </button>`;
}

/** Resolves to the chosen socket index, or null if cancelled. */
export function chooseSwapSlot(actor, incoming, layout = getSlotLayout(actor)) {
  return new Promise(resolve => {
    const filled = layout.filter(s => s.item);
    const info = RARITIES[getRarity(incoming)];
    const overlay = document.createElement("div");
    overlay.className = "aug-swap-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-label", "Choose an augment to swap out");
    overlay.innerHTML = `
      <div class="aug-swap-backdrop"></div>
      <div class="aug-swap-stage" style="--rarity:${rarityColor(incoming)}">
        <div class="aug-swap-heading">
          <span class="aug-swap-kicker"><i class="fas fa-dna" inert></i> All sockets full</span>
          <h2>Choose an augment to replace</h2>
        </div>
        <div class="aug-swap-incoming">
          <span class="aug-swap-halo"></span>
          <span class="aug-swap-ring"></span>
          <span class="aug-swap-incoming-icon"><img src="${esc(incoming.img)}" alt=""></span>
        </div>
        <div class="aug-swap-incoming-name">${esc(incoming.name)}
          ${info ? `<span class="augment-rarity-pill">${info.label}</span>` : ""}</div>
        <div class="aug-swap-link"><span></span></div>
        <div class="aug-swap-cards">${filled.map(cardHTML).join("")}</div>
        <button type="button" class="aug-swap-cancel"><i class="fas fa-xmark" inert></i> Cancel</button>
      </div>`;
    document.body.append(overlay);
    requestAnimationFrame(() => overlay.classList.add("open"));

    let done = false;
    const finish = (index, chosen) => {
      if (done) return;
      done = true;
      document.removeEventListener("keydown", onKey, true);
      if (chosen) {
        overlay.classList.add("choosing");
        chosen.classList.add("ejecting");
        for (const card of overlay.querySelectorAll(".aug-swap-card")) if (card !== chosen) card.classList.add("dimmed");
      }
      overlay.classList.add(chosen ? "installing" : "closing");
      setTimeout(() => { overlay.remove(); resolve(index); }, chosen ? OUTRO_MS : 220);
    };
    const onKey = event => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      finish(null);
    };
    document.addEventListener("keydown", onKey, true);

    overlay.querySelector(".aug-swap-backdrop").addEventListener("click", () => finish(null));
    overlay.querySelector(".aug-swap-cancel").addEventListener("click", () => finish(null));
    for (const card of overlay.querySelectorAll(".aug-swap-card")) {
      card.addEventListener("click", () => finish(Number(card.dataset.slot), card));
    }
    overlay.querySelector(".aug-swap-card")?.focus({ preventScroll: true });
  });
}

/* -------------------------------------------- */
/*  Right-click menu on the DNA list            */
/* -------------------------------------------- */

let openMenu = null;

export function closeAugmentMenu() {
  openMenu?.remove();
  openMenu = null;
}

/** Show the context menu for an augment row at the mouse position. */
export function showAugmentMenu(event, actor, item, { openSheet }) {
  event.preventDefault();
  event.stopPropagation();
  closeAugmentMenu();

  const equipper = equippedBy(item);
  const mine = equipper === actor;
  const editable = canEdit(actor);
  const count = getSlotCount(actor);
  const full = count > 0 && getSlotLayout(actor).filter(s => s.index < count && s.item).length >= count;
  const canUse = mine && item.parent === actor && (item.system?.activities?.size ?? 0) > 0 && typeof item.use === "function";

  const entries = [];
  if (!equipper) {
    let note = "";
    if (!editable) note = "Locked until long rest";
    else if (!count) note = "No sockets yet";
    entries.push({
      icon: full ? "fa-right-left" : "fa-dna", label: full ? "Equip (swap)" : "Equip",
      disabled: !!note, note, run: () => quickEquip(actor, item)
    });
  } else if (!mine) {
    entries.push({ icon: "fa-lock", label: `Equipped by ${equipper.name}`, disabled: true });
  }
  if (canUse) entries.push({ icon: "fa-bolt", label: "Use", run: () => item.use() });
  if (mine) {
    const slot = getSlotLayout(actor).find(s => s.itemId === item.id);
    entries.push({
      icon: "fa-eject", label: "Remove from socket", disabled: !editable,
      note: editable ? "" : "Locked until long rest", run: () => unequipAugment(actor, slot.index)
    });
  }
  entries.push({ icon: "fa-eye", label: "View details", run: () => openSheet(item.uuid) });

  const menu = document.createElement("nav");
  menu.className = "aug-context-menu";
  menu.style.setProperty("--rarity", rarityColor(item));
  menu.innerHTML = `
    <header><img src="${esc(item.img)}" alt=""><span>${esc(item.name)}</span></header>
    <ol>${entries.map((e, i) => `
      <li data-i="${i}" class="${e.disabled ? "disabled" : ""}">
        <i class="fas ${e.icon}" inert></i><span>${esc(e.label)}</span>
        ${e.note ? `<em>${esc(e.note)}</em>` : ""}
      </li>`).join("")}</ol>`;
  document.body.append(menu);

  // Keep the menu on screen.
  const rect = menu.getBoundingClientRect();
  const x = Math.min(event.clientX, window.innerWidth - rect.width - 8);
  const y = Math.min(event.clientY, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.max(8, x)}px`;
  menu.style.top = `${Math.max(8, y)}px`;
  requestAnimationFrame(() => menu.classList.add("open"));
  openMenu = menu;

  for (const li of menu.querySelectorAll("li:not(.disabled)")) {
    li.addEventListener("click", ev => {
      ev.stopPropagation();
      const entry = entries[Number(li.dataset.i)];
      closeAugmentMenu();
      entry.run?.();
    });
  }
  const dismiss = ev => {
    if (menu.contains(ev.target)) return;
    closeAugmentMenu();
    document.removeEventListener("pointerdown", dismiss, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("wheel", dismiss, true);
  };
  const onKey = ev => { if (ev.key === "Escape") dismiss(ev); };
  setTimeout(() => {
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("wheel", dismiss, true);
  }, 0);
}
