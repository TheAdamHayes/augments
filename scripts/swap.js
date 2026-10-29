import {
  RARITIES, canEdit, equippedBy, getSlotLayout, getRarity, rarityColor, rarityRank,
  slotAccepts, slotCapLabel, equipAugment, unequipAugment, escapeHTML as esc
} from "./core.js";
import { postAugmentCard } from "./chat.js";

/* -------------------------------------------- */
/*  Quick equip                                 */
/* -------------------------------------------- */

/** Equip into the first free socket, or ask which augment to swap out if every socket is full. */
export async function quickEquip(actor, item) {
  if (!canEdit(actor)) return ui.notifications.warn(`${actor.name}'s augments are locked until the next long rest.`);
  const current = equippedBy(item);
  if (current === actor) return ui.notifications.info(`${item.name} is already installed.`);
  if (current) return ui.notifications.warn(`${item.name} is already equipped by ${current.name}.`);

  const layout = getSlotLayout(actor).filter(s => !s.overflow);
  if (!layout.length) return ui.notifications.warn(`${actor.name} has no augment sockets yet.`);
  const fits = layout.filter(s => slotAccepts(s, item));
  if (!fits.length) {
    return ui.notifications.warn(`None of ${actor.name}'s sockets can hold ${RARITIES[getRarity(item)]?.label ?? "this"} augments.`);
  }

  // Free socket first. Use the most limited extra socket that fits, saving the open ones.
  const capRank = s => (s.maxRarity ? rarityRank(s.maxRarity) : 99);
  const free = fits.filter(s => !s.item).sort((a, b) => capRank(a) - capRank(b))[0];
  if (free) return equipAugment(actor, free.key, item);

  const key = await chooseSwapSlot(actor, item, fits);
  if (key === null) return;
  return equipAugment(actor, key, item);
}

/** Is there a free socket that fits, and does any socket fit at all? */
export function socketFit(actor, item) {
  const fits = getSlotLayout(actor).filter(s => slotAccepts(s, item));
  return { any: fits.length > 0, free: fits.some(s => !s.item) };
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
  return `<button type="button" class="aug-swap-card" data-slot="${slot.key}"
      style="--rarity:${rarityColor(item)};--i:${i}">
    <span class="aug-swap-card-glow"></span>
    <span class="aug-swap-card-icon"><img src="${esc(item.img)}" alt=""></span>
    <span class="aug-swap-card-name">${esc(item.name)}</span>
    ${info ? `<span class="augment-rarity-pill">${info.label}</span>` : ""}
    ${usesPips(item)}
    ${slot.maxRarity ? `<span class="aug-swap-card-cap">${esc(slotCapLabel(slot))} socket</span>` : ""}
    <span class="aug-swap-card-action"><i class="fas fa-right-left" inert></i> Swap out</span>
  </button>`;
}

/** Resolves to the chosen socket key, or null if cancelled. */
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
      card.addEventListener("click", () => finish(card.dataset.slot, card));
    }
    overlay.querySelector(".aug-swap-card")?.focus({ preventScroll: true });
  });
}

/* -------------------------------------------- */
/*  Delete                                      */
/* -------------------------------------------- */

async function confirmDelete(item) {
  const title = "Delete augment";
  const content = `<p>Delete <strong>${esc(item.name)}</strong> from ${esc(item.parent?.name ?? "the world")}? This can't be undone.</p>`;
  const DialogV2 = foundry.applications?.api?.DialogV2;
  if (DialogV2) return DialogV2.confirm({ window: { title }, content, rejectClose: false });
  return Dialog.confirm({ title, content });
}

/** Delete an augment item. GM only. */
export async function deleteAugment(item) {
  if (!game.user.isGM) return ui.notifications.warn("Only the GM can delete augments.");
  if (!(await confirmDelete(item))) return;
  await item.delete();
  ui.notifications.info(`Deleted ${item.name}.`);
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
  const fit = socketFit(actor, item);
  const full = fit.any && !fit.free;
  const canUse = mine && item.parent === actor && (item.system?.activities?.size ?? 0) > 0 && typeof item.use === "function";

  const entries = [];
  if (!equipper) {
    let note = "";
    if (!editable) note = "Locked until long rest";
    else if (!getSlotLayout(actor).some(s => !s.overflow)) note = "No sockets yet";
    else if (!fit.any) note = "No socket can hold this rarity";
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
      note: editable ? "" : "Locked until long rest", run: () => unequipAugment(actor, slot.key)
    });
  }
  entries.push({ icon: "fa-eye", label: "View details", run: () => openSheet(item.uuid) });
  entries.push({
    icon: "fa-comment", label: "Post reminders to chat",
    run: async () => { if (!(await postAugmentCard(item))) ui.notifications.info(`${item.name} has nothing to remind you of.`); }
  });
  if (game.user.isGM) {
    entries.push({ icon: "fa-trash", label: "Delete augment", danger: true, run: () => deleteAugment(item) });
  }

  const menu = document.createElement("nav");
  menu.className = "aug-context-menu";
  menu.style.setProperty("--rarity", rarityColor(item));
  menu.innerHTML = `
    <header><img src="${esc(item.img)}" alt=""><span>${esc(item.name)}</span></header>
    <ol>${entries.map((e, i) => `
      <li data-i="${i}" class="${e.disabled ? "disabled" : ""} ${e.danger ? "danger" : ""}">
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
