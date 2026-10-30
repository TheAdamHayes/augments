import {
  MODULE_ID, RARITIES, getSlotLayout, getRarity, rarityColor, getEffectText, boldMarkdown, escapeHTML as esc
} from "./core.js";
import { openAugment } from "./ui.js";

/** Tooltip body for an augment. Foundry draws it (data-tooltip-html), so it sits above all UI. */
function tooltipHTML(item) {
  const active = isActive(item);
  const key = getRarity(item);
  const info = RARITIES[key];
  const uses = usesText(item);
  return `<div class="aug-tt rarity-${key || "none"}">
      <div class="aug-tt-head"><img src="${esc(item.img)}" alt=""><div>
        <strong>${esc(item.name)}</strong>
        <div class="aug-tt-meta">${info ? `<span class="aug-tt-pill">${info.label}</span>` : ""}${uses ? `<em>${uses}</em>` : ""}</div>
      </div></div>
      <p>${boldMarkdown(getEffectText(item))}</p>
      <div class="aug-tt-foot">${active ? "Click to use. Right-click to open." : "Click to open."}</div>
    </div>`;
}

/** Per-rarity colours for the tooltip (Foundry cleans inline styles out of tooltip HTML). */
function ensureRarityStyles() {
  if (document.getElementById("aug-tt-rarity-styles")) return;
  const style = document.createElement("style");
  style.id = "aug-tt-rarity-styles";
  style.textContent = Object.entries(RARITIES).map(([k, r]) => `.aug-tt.rarity-${k}{--rarity:${r.color}}`).join("\n");
  document.head.append(style);
}

/**
 * A button at the bottom of the left-hand scene controls. It slides open a column of the selected
 * token's installed augments: hover for details, click to open the augment. Players only ever see
 * tokens they own (they can only select their own); with nothing selected they see their character.
 */

const STORE_KEY = `${MODULE_ID}.hudOpen`;
let isOpen = (() => {
  try { return sessionStorage.getItem(STORE_KEY) === "1"; } catch (e) { return false; }
})();
function saveOpen() {
  try { sessionStorage.setItem(STORE_KEY, isOpen ? "1" : "0"); } catch (e) { /* storage unavailable */ }
}

/* -------------------------------------------- */
/*  Content                                     */
/* -------------------------------------------- */

function hudGroups() {
  const groups = [];
  for (const token of canvas?.tokens?.controlled ?? []) {
    const actor = token.actor;
    if (!actor?.isOwner || groups.some(g => g.actor === actor)) continue;
    groups.push({ actor, img: token.document?.texture?.src ?? actor.img });
  }
  if (!groups.length && !game.user.isGM && game.user.character) {
    groups.push({ actor: game.user.character, img: game.user.character.img });
  }
  return groups;
}

function installed(actor) {
  return getSlotLayout(actor).filter(s => s.item && !s.overflow).map(s => s.item);
}

/** Uses left and max, or null for augments without limited uses. */
function usesOf(item) {
  const uses = item.system?.uses;
  const max = Number(uses?.max) || 0;
  if (!max) return null;
  const value = Math.max(0, Math.min(max, Number(uses.value ?? max - (Number(uses.spent) || 0))));
  return { value, max };
}

/** Active = an ability with a limited number of uses. Shown as a circle you click to use. */
function isActive(item) {
  return !!usesOf(item) && (item.system?.activities?.size ?? 0) > 0;
}

function iconHTML(item, i) {
  const tt = esc(tooltipHTML(item));
  const tip = `data-tooltip-html="${tt}" data-tooltip="${tt}" data-tooltip-direction="RIGHT" data-tooltip-class="aug-hud-tooltip"`;
  if (isActive(item)) {
    const { value, max } = usesOf(item);
    return `<button type="button" class="aug-hud-icon aug-hud-active${value ? "" : " spent"}" data-uuid="${esc(item.uuid)}"
      style="--rarity:${rarityColor(item)};--i:${i};--aug-pct:${value / max}"
      aria-label="${esc(item.name)}, ${value} of ${max} uses left" ${tip}>
      <img src="${esc(item.img)}" alt=""><span class="aug-hud-count">${value}</span></button>`;
  }
  return `<button type="button" class="aug-hud-icon aug-hud-passive" data-uuid="${esc(item.uuid)}"
    style="--rarity:${rarityColor(item)};--i:${i}" aria-label="${esc(item.name)}" ${tip}>
    <img src="${esc(item.img)}" alt=""></button>`;
}

function contentHTML() {
  const groups = hudGroups();
  if (!groups.length) {
    return `<div class="aug-hud-note" data-tooltip="Select a token to see its augments"><i class="fas fa-hand-pointer" inert></i></div>`;
  }
  let i = 0;
  return groups.map(({ actor, img }) => {
    const items = installed(actor);
    const owner = groups.length > 1
      ? `<div class="aug-hud-owner" data-tooltip="${esc(actor.name)}"><img src="${esc(img)}" alt=""></div>` : "";
    if (!items.length) {
      return owner + `<div class="aug-hud-note" data-tooltip="${esc(actor.name)} has no augments installed"><i class="fas fa-ban" inert></i></div>`;
    }
    const actives = items.filter(isActive);
    const passives = items.filter(it => !isActive(it));
    const divider = actives.length && passives.length ? `<div class="aug-hud-divider"></div>` : "";
    return owner + actives.map(it => iconHTML(it, i++)).join("") + divider + passives.map(it => iconHTML(it, i++)).join("");
  }).join("");
}

function usesText(item) {
  const u = usesOf(item);
  return u ? `${u.value} / ${u.max} uses` : "";
}

function hideTip() {
  try { game.tooltip?.deactivate?.(); } catch (e) { /* ignore */ }
}

/* -------------------------------------------- */
/*  Rendering                                   */
/* -------------------------------------------- */

function bindIcons(scroll) {
  for (const btn of scroll.querySelectorAll(".aug-hud-icon")) {
    // Belt and braces: ask Foundry's tooltip manager to show it, in case its own hover detection doesn't.
    btn.addEventListener("pointerenter", () => {
      try {
        if (game.tooltip?.element?.isConnected && game.tooltip.element === btn) return;
        game.tooltip?.activate?.(btn, {
          html: btn.dataset.tooltipHtml, direction: "RIGHT", cssClass: "aug-hud-tooltip"
        });
      } catch (e) { console.warn(`${MODULE_ID} | Tooltip failed`, e); }
    });
    btn.addEventListener("pointerleave", hideTip);
    btn.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      hideTip();
      if (btn.classList.contains("aug-hud-active")) useFromHud(btn);
      else openAugment(btn.dataset.uuid);
    });
    btn.addEventListener("contextmenu", event => {
      event.preventDefault();
      event.stopPropagation();
      hideTip();
      openAugment(btn.dataset.uuid);
    });
  }
}

/* -------------------------------------------- */
/*  Using an ability                            */
/* -------------------------------------------- */

function currentButton(uuid, fallback) {
  return document.querySelector(`.aug-hud-icon[data-uuid="${CSS.escape(uuid)}"]`) ?? fallback;
}

function playOnce(btn, cls) {
  btn.classList.remove(cls);
  void btn.offsetWidth; // restart the animation if it's already playing
  btn.classList.add(cls);
  btn.addEventListener("animationend", () => btn.classList.remove(cls), { once: true });
}

async function useFromHud(btn) {
  const uuid = btn.dataset.uuid;
  const item = await fromUuid(uuid);
  if (!item) return;
  const uses = usesOf(item);
  if (uses && uses.value <= 0) {
    playOnce(btn, "denied");
    const period = item.system?.uses?.recovery?.[0]?.period;
    const when = period === "sr" ? "short or long rest" : period === "lr" ? "long rest" : "rest";
    return ui.notifications.warn(`${item.name} has no uses left. They come back after a ${when}.`);
  }
  if (typeof item.use !== "function") return openAugment(uuid);
  btn.classList.add("pressing");
  let result = null;
  try {
    result = await item.use();
  } catch (err) {
    console.error(`${MODULE_ID} | Couldn't use ${item.name}`, err);
  } finally {
    currentButton(uuid, btn).classList.remove("pressing");
  }
  if (result) playOnce(currentButton(uuid, btn), "fired");
}

function setOpen(li, open, { instant = false } = {}) {
  isOpen = open;
  saveOpen();
  const toggle = li.querySelector(".aug-hud-toggle");
  const drawer = li.querySelector(".aug-hud-drawer");
  if (instant) drawer.classList.add("instant");
  drawer.classList.toggle("open", open);
  toggle.classList.toggle("open", open);
  toggle.setAttribute("aria-expanded", String(open));
  toggle.dataset.tooltip = open ? "Hide augments" : "Show augments";
  if (!open) hideTip();
  if (instant) requestAnimationFrame(() => requestAnimationFrame(() => drawer.classList.remove("instant")));
}

/** renderSceneControls hook: add the button and drawer to the left-hand column. */
export function injectHud(app, html) {
  if (!game.settings.get(MODULE_ID, "tokenControls")) return;
  ensureRarityStyles();
  const root = html instanceof HTMLElement ? html : (html?.[0] ?? document);
  const menu = root.querySelector?.("#scene-controls-layers")
    ?? document.querySelector("#scene-controls-layers")
    ?? root.querySelector?.(".main-controls");
  if (!menu) return;
  menu.querySelectorAll(".aug-hud-li").forEach(el => el.remove());

  const li = document.createElement("li");
  li.className = "aug-hud-li";
  // Match Foundry's own buttons exactly so the column never gets wider and pushes the tools column off.
  const sample = menu.querySelector("button.control, .scene-control, li > button");
  const size = sample?.getBoundingClientRect?.().width;
  if (size) li.style.setProperty("--aug-hud-size", `${Math.round(size)}px`);
  li.innerHTML = `
    <button type="button" class="control ui-control icon fa-solid fa-angles-down aug-hud-toggle"
      aria-label="Augments" aria-expanded="false" data-tooltip="Show augments"></button>
    <div class="aug-hud-drawer"><div class="aug-hud-clip"><div class="aug-hud-scroll">${contentHTML()}</div></div></div>`;
  menu.append(li);
  bindIcons(li.querySelector(".aug-hud-scroll"));
  setOpen(li, isOpen, { instant: true });

  li.querySelector(".aug-hud-toggle").addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    if (!isOpen) refreshHud();
    setOpen(li, !isOpen);
  });
}

/** Rebuild the drawer contents (selection changed, augment installed or removed...). */
export function refreshHud() {
  const scroll = document.querySelector(".aug-hud-li .aug-hud-scroll");
  if (!scroll) return;
  const next = document.createElement("div");
  next.innerHTML = contentHTML();
  const keyOf = el => `${el.dataset.uuid ?? ""}|${el.classList.contains("aug-hud-active") ? "a" : el.className}`;
  const same = scroll.children.length === next.children.length
    && [...next.children].every((el, i) => keyOf(el) === keyOf(scroll.children[i]));

  if (same) {
    // Same icons: patch values in place so the uses ring animates to its new value.
    [...next.children].forEach((el, i) => {
      const old = scroll.children[i];
      for (const attr of ["style", "aria-label", "data-tooltip", "data-tooltip-html"]) {
        const v = el.getAttribute(attr);
        if (v !== null && old.getAttribute(attr) !== v) old.setAttribute(attr, v);
      }
      old.classList.toggle("spent", el.classList.contains("spent"));
      const count = el.querySelector(".aug-hud-count");
      if (count) old.querySelector(".aug-hud-count").textContent = count.textContent;
    });
    return;
  }
  hideTip();
  scroll.replaceChildren(...next.children);
  bindIcons(scroll);
}

export const queueHudRefresh = foundry.utils.debounce(refreshHud, 80);
