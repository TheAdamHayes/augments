# Augments for D&D 5e (FoundryVTT)

Adds an **Augments** tab (DNA icon) to every dnd5e character sheet.

## Install
Unzip so you have `Data/modules/augments/module.json`, then enable "Augments for D&D 5e" in your world.
Works with Foundry v12/v13 and dnd5e 4.x (classic sheets) or 5.x (ApplicationV2 sheets).

## Making augments
- **Bulk:** Items sidebar > **Import augments** (GM). Paste rows straight from your spreadsheet
  (Module, Rarity, Physical Description, Effect, Unlock Mechanism). Creates Equipment (Trinket) items in an "Augments" folder.
  Re-importing updates the text but keeps any activities/effects you've added.
- **By hand:** any Equipment, Loot, Consumable, Weapon, Tool or Container item has an **Augment** property checkbox on its Details tab.
- Hand them out by dragging onto a character (or into the Augments pool on their sheet), or onto the Primary Party group actor.

Use Equipment for augments with mechanics: give them activities, limited uses (e.g. 1/long rest) and active effects.
Effects only apply while the augment is socketed.

## Playing
- Sockets: first at level 2, then every 3 levels (2, 5, 8, 11, 14, 17, 20). Configurable in module settings.
- Drag an icon from the pool into a socket. If another player is carrying it (unsocketed), it moves to you. A GM must be online for that.
- Remove: right-click a socket, or drag it back into the pool.
- Click any icon to read it. Socketed augments get "Equipped by NAME" added to the top of their description.
- Locking: after a long rest the sheet unlocks; press **Lock in** when done. GMs can always edit and unlock.

## Macro API
`Augments.openImporter()`, `Augments.collectAugments()`, `Augments.setLocked(actor, false)`, and more on `game.modules.get("dnd5e-augments").api`.
