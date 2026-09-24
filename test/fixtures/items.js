// Fixture item and actor sources per system, shaped like each system's stored data
// (see the source references at the top of src/systems/*.js).

export const pf1 = {
  potion: (over = {}) => ({
    name: 'Potion of Cure Light Wounds',
    type: 'consumable',
    system: {
      subType: 'potion', quantity: 3, price: 50, weight: { value: 0.1 }, identified: true,
      uses: { per: 'single' }, ...over.system,
    },
    ...over.top,
  }),
  wand: () => ({
    name: 'Wand of Magic Missile',
    type: 'consumable',
    system: { subType: 'wand', quantity: 1, price: 750, weight: { value: 0 }, uses: { per: 'charges', value: 37, maxFormula: '50' } },
  }),
  sword: (over = {}) => ({
    name: 'Longsword +1',
    type: 'weapon',
    system: {
      subType: 'martial', quantity: 1, price: 2315, weight: { value: 4 }, equipped: true,
      identified: false, unidentified: { name: 'Shiny Longsword', price: 15 }, ...over.system,
    },
    _stats: { compendiumSource: 'Compendium.pf1.weapons-and-ammo.Item.abc123' },
  }),
  arrows: () => ({
    name: 'Arrow',
    type: 'ammo',
    system: { subType: 'arrow', quantity: 20, price: 0.05, weight: { value: 0.15 } },
  }),
  gems: () => ({
    name: 'Garnet',
    type: 'loot',
    system: { subType: 'treasure', quantity: 2, price: 100, weight: { value: 0 } },
  }),
  backpack: (contents = {}) => ({
    name: 'Backpack',
    type: 'container',
    system: { quantity: 1, price: 2, weight: { value: 2 }, items: contents },
  }),
  character: (items = [], currency = { pp: 0, gp: 0, sp: 0, cp: 0 }) => ({
    name: 'Valeros', type: 'character', system: { currency, altCurrency: { pp: 0, gp: 0, sp: 0, cp: 0 } }, items,
  }),
};

export const pf2e = {
  potion: (over = {}) => ({
    name: 'Minor Healing Potion',
    type: 'consumable',
    system: {
      quantity: 2, price: { value: { gp: 4 } }, bulk: { value: 0.1 }, traits: { rarity: 'common', value: ['consumable'] },
      identification: { status: 'identified', unidentified: null }, equipped: { carryType: 'worn' },
      usage: { type: 'held', hands: 1 }, uses: { value: 1, max: 1, autoDestroy: true }, containerId: null, ...over.system,
    },
    _stats: { compendiumSource: 'Compendium.pf2e.equipment-srd.Item.x9o2d1bYXeGmGkMs' },
  }),
  arrows: () => ({
    name: 'Arrows',
    type: 'ammo',
    system: {
      quantity: 30, price: { value: { sp: 1 }, per: 10 }, bulk: { value: 0.1 }, traits: { rarity: 'common', value: [] },
      identification: { status: 'identified', unidentified: null }, equipped: { carryType: 'worn' }, usage: { type: 'held', hands: 1 },
    },
  }),
  cloak: (over = {}) => ({
    name: 'Cloak of Elvenkind',
    type: 'equipment',
    system: {
      quantity: 1, price: { value: { gp: 360 } }, bulk: { value: 0.1 }, traits: { rarity: 'uncommon', value: ['invested', 'magical'] },
      identification: { status: 'unidentified', unidentified: { name: 'Strange Cloak', img: 'x.webp', data: { description: { value: '' } } } },
      equipped: { carryType: 'worn', inSlot: true }, usage: { type: 'worn', where: 'cloak' }, ...over.system,
    },
  }),
  coins: (denomination, quantity) => ({
    name: `${denomination} coins`, type: 'treasure', system: { category: 'coin', quantity, price: { value: { [denomination]: 1 } } },
  }),
  gem: () => ({
    name: 'Amethyst', type: 'treasure', system: { category: 'gem', quantity: 1, price: { value: { gp: 50 } }, bulk: { value: 0 }, traits: { rarity: 'common', value: [] } },
  }),
  character: (items = []) => ({ name: 'Ezren', type: 'character', system: {}, items }),
};

export const dnd5e = {
  potion: (over = {}) => ({
    name: 'Potion of Healing',
    type: 'consumable',
    system: {
      type: { value: 'potion' }, quantity: 3, price: { value: 50, denomination: 'gp' }, weight: { value: 0.5, units: 'lb' },
      identified: true, unidentified: { name: '' }, rarities: ['common'], uses: { max: '1', spent: 0 }, container: null, ...over.system,
    },
    _stats: { compendiumSource: 'Compendium.dnd5e.items.Item.potionOfHealing' },
  }),
  arrows: () => ({
    name: 'Arrows',
    type: 'consumable',
    system: { type: { value: 'ammo' }, quantity: 20, price: { value: 5, denomination: 'cp' }, weight: { value: 0.05, units: 'lb' } },
  }),
  wand: () => ({
    name: 'Wand of Magic Missiles',
    type: 'equipment',
    system: {
      type: { value: 'wand' }, quantity: 1, price: { value: 800, denomination: 'gp' }, weight: { value: 1, units: 'lb' },
      rarities: ['uncommon'], uses: { max: '7', spent: 2 }, equipped: false, attuned: false,
    },
  }),
  ring: (over = {}) => ({
    name: 'Ring of Protection',
    type: 'equipment',
    system: {
      type: { value: 'ring' }, quantity: 1, price: { value: 350, denomination: 'pp' }, weight: { value: 0.2, units: 'kg' },
      rarities: ['veryRare'], identified: false, unidentified: { name: 'Plain Ring' }, equipped: true, attuned: true,
      attunement: 'required', ...over.system,
    },
  }),
  gem: () => ({
    name: 'Ruby', type: 'loot', system: { type: { value: 'gem' }, quantity: 1, price: { value: 500, denomination: 'gp' }, weight: { value: 0, units: 'lb' } },
  }),
  character: (items = [], currency = { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 }) => ({
    name: 'Merric', type: 'character', system: { currency }, items,
  }),
};
