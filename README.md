# Augments for D&D 5e (FoundryVTT)

Adds an **Augments** tab (DNA icon) to every dnd5e character sheet.

## Install
In Foundry: Add-on Modules > Install Module, then paste the manifest URL:
`https://github.com/TheAdamHayes/augments/releases/latest/download/module.json`

## Making augments
- **Bulk:** Items sidebar > **Import augments** (GM). Paste rows from your table:
  Name, Rarity, Physical Description, Effect, Unlock Mechanism (tabs, pipes or wide spaces between columns).
  Each row becomes an Equipment (Trinket) with its rarity set, an icon picked for it, and uses, activities and effects built from the effect text.
- **By hand:** tick the **Augment** property on an Equipment, Loot, Consumable, Weapon, Tool or Container item.
- Each augment's sheet has a panel at the top of its Description tab to set its **rarity** (Simple, Average, Complex, Perfect, Special) and, for the GM, a **Build automation** button.

## Playing
- Sockets: first at level 2, then every 3 levels (2, 5, 8, 11, 14, 17, 20). Configurable in module settings.
- The list below the sockets shows every augment in a player character's inventory. Search by name or filter by rarity.
- Drag a row into a socket to install it. If another player is carrying it, it moves to you (a GM must be online).
- Remove: right-click a socket, or drag it back into the list.
- Locking: after a long rest the sheet unlocks; press **Lock in** when done. GMs can always edit and unlock.

## Automation
The effect text is scanned for phrases such as "PB uses per short rest", "As a bonus action", "+2d6 damage",
"1d6 + PB temporary hit points", "on a failed Dexterity save", "walking speed increases by 5 feet", "+1 AC",
"20-foot climbing speed", "hover" and "become invisible". Always-on bonuses become a passive effect; "While..." or
"After..." bonuses become an effect the player toggles on in the item's Effects tab. Save DCs are 8 + PB + Constitution.

## Macro API
`Augments.openImporter()`, `Augments.automate(item)`, `Augments.assignIcons()`, `Augments.analyze("effect text")`,
`Augments.collectAugments()`, `Augments.setLocked(actor, false)`.
