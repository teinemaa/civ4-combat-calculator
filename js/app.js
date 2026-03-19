// Alpine.js application component

import { UNITS, PROMOTIONS, TERRAIN_BONUSES, CITY_BUILDING_BONUSES, CITY_CULTURE_BONUSES, SEA_TERRAIN_BONUSES, COMBAT_GLOBALS } from './data.js';
import { sortUnitsForDisplay } from './sort.js';

// Build free promotions array (with full promo data) for a unit.
// Free promotions bypass normal prerequisites — only the listed promos are added.
function buildFreePromotions(unit) {
  const ids = unit.freePromotions || [];
  if (ids.length === 0) return [];
  const result = [];
  for (const id of ids) {
    const promo = PROMOTIONS.find(p => p.id === id);
    if (promo) result.push({ ...promo });
  }
  return result;
}

export function combatCalculator() {
  return {
    // Data
    units: sortUnitsForDisplay(UNITS),
    promotions: PROMOTIONS,
    terrainOptions: Object.entries(TERRAIN_BONUSES).map(([k, v]) => ({ id: k, ...v })),

    cityBuildingOptions: Object.entries(CITY_BUILDING_BONUSES).map(([k, v]) => ({ id: k, ...v })),
    cityCultureOptions: Object.entries(CITY_CULTURE_BONUSES).map(([k, v]) => ({ id: k, ...v })),
    seaTerrainOptions: Object.entries(SEA_TERRAIN_BONUSES).map(([k, v]) => ({ id: k, ...v })),

    // Attacker stack
    attackerStack: [],
    selectedAttackerUnit: 'warrior',
    attackMode: 'stack',  // 'stack' = AI picks best attacker, 'ordered' = sequential

    // Defender stack
    defenderStack: [],
    selectedDefenderUnit: 'warrior',

    // Context / modifiers
    combatType: 'land',
    terrain: 'flat',
    seaTerrain: 'coastal',
    cityBuildings: 'none',
    cityCulture: 'none',
    attackPenalty: 'none',
    attackPenaltyOptions: [
      { id: 'none',       short: 'Normal',             icon: 'ph-check' },
      { id: 'river',      short: 'River +25%',         icon: 'ph-waves' },
      { id: 'amphibious', short: 'Amphibious +50%',    icon: 'ph-sailboat' },
    ],

    // Drag and drop
    dragSide: null,
    dragIndex: null,
    dragOverIndex: null,

    dragStart(side, idx, event) {
      this.dragSide = side;
      this.dragIndex = idx;
      event.dataTransfer.effectAllowed = 'move';
    },
    dragOver(side, idx, event) {
      if (this.dragSide !== side) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      this.dragOverIndex = idx;
    },
    dragDrop(side, idx) {
      if (this.dragSide !== side || this.dragIndex === null) return;
      const stack = side === 'attacker' ? this.attackerStack : this.defenderStack;
      const from = this.dragIndex;
      const to = idx;
      if (from !== to) {
        const [item] = stack.splice(from, 1);
        stack.splice(to, 0, item);
        this.autoSimulate();
      }
      this.dragEnd();
    },
    dragEnd() {
      this.dragSide = null;
      this.dragIndex = null;
      this.dragOverIndex = null;
    },

    // Simulation settings
    simMode: 'auto',       // 'auto' or 'manual'
    numSimulations: 1000,
    isSimulating: false,
    _worker: null,
    _taskId: 0,
    _autoSimLimit: 100000,

    // Results
    results: null,

    // Add unit to stack by id
    addAttackerById(id) {
      const unit = UNITS.find(u => u.id === id);
      if (!unit) return;
      const freePromos = buildFreePromotions(unit);
      this.attackerStack.push({
        ...unit,
        hp: COMBAT_GLOBALS.maxHP,
        promotions: freePromos,
        _freePromoIds: new Set(freePromos.map(p => p.id)),
        count: 1,
        editingCount: false,
        editingStrength: false,
        editingHP: false,
        instanceId: Date.now() + Math.random(),
      });
      this.autoSimulate();
    },

    addDefenderById(id) {
      const unit = UNITS.find(u => u.id === id);
      if (!unit) return;
      const freePromos = buildFreePromotions(unit);
      this.defenderStack.push({
        ...unit,
        hp: COMBAT_GLOBALS.maxHP,
        promotions: freePromos,
        _freePromoIds: new Set(freePromos.map(p => p.id)),
        fortificationBonus: 0,
        count: 1,
        editingCount: false,
        editingStrength: false,
        editingHP: false,
        instanceId: Date.now() + Math.random(),
      });
      this.autoSimulate();
    },

    // Keep legacy methods for backward-compat
    addAttacker() { this.addAttackerById(this.selectedAttackerUnit); },
    addDefender() { this.addDefenderById(this.selectedDefenderUnit); },

    // Switch combat type and remove incompatible units from both stacks
    setCombatType(type) {
      this.combatType = type;
      const isNaval = type === 'sea';
      const isCompatible = u => isNaval ? u.unitCombatType === 'naval' : u.unitCombatType !== 'naval';
      this.attackerStack = this.attackerStack.filter(isCompatible);
      this.defenderStack = this.defenderStack.filter(isCompatible);
      this.autoSimulate();
    },

    // Units filtered to the active combat type
    get availableUnits() {
      const isNaval = this.combatType === 'sea';
      return this.units.filter(u =>
        isNaval ? u.unitCombatType === 'naval' : u.unitCombatType !== 'naval'
      );
    },

    // Attacker units: same as availableUnits but excludes recon (can't attack)
    get availableAttackerUnits() {
      return this.availableUnits.filter(u => u.unitCombatType !== 'recon');
    },

    removeAttacker(index) {
      this.attackerStack.splice(index, 1);
      this.autoSimulate();
    },

    removeDefender(index) {
      this.defenderStack.splice(index, 1);
      this.autoSimulate();
    },

    // Unit count controls
    incrementCount(stack, idx) {
      stack[idx].count++;
      this.autoSimulate();
    },
    decrementCount(stack, idx) {
      if (stack[idx].count > 1) {
        stack[idx].count--;
        this.autoSimulate();
      }
    },
    setCount(stack, idx, value) {
      const n = parseInt(value, 10);
      stack[idx].count = (isNaN(n) || n < 1) ? 1 : n;
      stack[idx].editingCount = false;
      this.autoSimulate();
    },

    // Current combat strength based on HP
    currentStrength(unit) {
      return +(unit.strength * unit.hp / COMBAT_GLOBALS.maxHP).toFixed(2);
    },

    // Set HP directly (source of truth)
    setHP(stack, idx, value) {
      const n = parseInt(value, 10);
      stack[idx].hp = isNaN(n) ? COMBAT_GLOBALS.maxHP : Math.max(1, Math.min(COMBAT_GLOBALS.maxHP, n));
      stack[idx].editingHP = false;
      this.autoSimulate();
    },

    // Set strength → derive HP from it
    setStrength(stack, idx, value) {
      const v = parseFloat(value);
      if (isNaN(v) || v <= 0) {
        stack[idx].editingStrength = false;
        return;
      }
      const hp = Math.round(v / stack[idx].strength * COMBAT_GLOBALS.maxHP);
      stack[idx].hp = Math.max(1, Math.min(COMBAT_GLOBALS.maxHP, hp));
      stack[idx].editingStrength = false;
      this.autoSimulate();
    },

    // Clone a unit (duplicate with new instanceId, preserving count)
    cloneAttacker(idx) {
      const unit = this.attackerStack[idx];
      this.attackerStack.splice(idx + 1, 0, {
        ...unit,
        promotions: [...unit.promotions],
        _freePromoIds: new Set(unit._freePromoIds),
        editingCount: false,
        editingStrength: false,
        editingHP: false,
        instanceId: Date.now() + Math.random(),
      });
      this.autoSimulate();
    },
    cloneDefender(idx) {
      const unit = this.defenderStack[idx];
      this.defenderStack.splice(idx + 1, 0, {
        ...unit,
        promotions: [...unit.promotions],
        _freePromoIds: new Set(unit._freePromoIds),
        editingCount: false,
        editingStrength: false,
        editingHP: false,
        instanceId: Date.now() + Math.random(),
      });
      this.autoSimulate();
    },

    // Total unit counts (expanded by count)
    get totalAttackerCount() {
      return this.attackerStack.reduce((s, u) => s + (u.count || 1), 0);
    },
    get totalDefenderCount() {
      return this.defenderStack.reduce((s, u) => s + (u.count || 1), 0);
    },

    // Toggle promotion on a unit
    togglePromotion(stack, unitIndex, promoId) {
      const unit = stack[unitIndex];
      const promo = PROMOTIONS.find(p => p.id === promoId);
      if (!promo) return;

      // Cannot toggle free promotions
      if (unit._freePromoIds && unit._freePromoIds.has(promoId)) return;

      const hasPromo = unit.promotions.some(p => p.id === promoId);
      if (hasPromo) {
        // Remove this promotion and cascade-remove any that depend on it
        const toRemove = new Set([promoId]);
        let changed = true;
        while (changed) {
          changed = false;
          for (const p of unit.promotions) {
            if (toRemove.has(p.id)) continue;
            // Never remove free promotions
            if (unit._freePromoIds && unit._freePromoIds.has(p.id)) continue;
            const promoDef = PROMOTIONS.find(pd => pd.id === p.id);
            if (!promoDef) continue;
            // Check if required (all) prereq is being removed
            if (promoDef.requires && promoDef.requires.some(r => toRemove.has(r))) {
              toRemove.add(p.id);
              changed = true;
              continue;
            }
            // Check if requiresAny prereqs are all gone after removal
            if (promoDef.requiresAny && promoDef.requiresAny.length > 0) {
              const remaining = unit.promotions.filter(up => !toRemove.has(up.id));
              if (!promoDef.requiresAny.some(r => remaining.some(up => up.id === r))) {
                toRemove.add(p.id);
                changed = true;
              }
            }
          }
        }
        // Never remove free promotions from the set
        if (unit._freePromoIds) {
          for (const fid of unit._freePromoIds) toRemove.delete(fid);
        }
        unit.promotions = unit.promotions.filter(p => !toRemove.has(p.id));
      } else {
        // Auto-add prerequisites recursively
        const addPrereqs = (pid) => {
          const pr = PROMOTIONS.find(p => p.id === pid);
          if (!pr) return;
          // Handle requires (all must be met)
          for (const reqId of pr.requires) {
            if (!unit.promotions.some(p => p.id === reqId)) {
              addPrereqs(reqId);
              const reqPromo = PROMOTIONS.find(p => p.id === reqId);
              if (reqPromo) unit.promotions.push({ ...reqPromo });
            }
          }
          // Handle requiresAny (at least one must be met)
          if (pr.requiresAny && pr.requiresAny.length > 0) {
            if (!pr.requiresAny.some(reqId => unit.promotions.some(p => p.id === reqId))) {
              const firstReq = pr.requiresAny[0];
              addPrereqs(firstReq);
              const reqPromo = PROMOTIONS.find(p => p.id === firstReq);
              if (reqPromo && !unit.promotions.some(p => p.id === firstReq)) {
                unit.promotions.push({ ...reqPromo });
              }
            }
          }
        };
        addPrereqs(promoId);
        unit.promotions.push({ ...promo });
      }
      this.autoSimulate();
    },

    hasPromotion(stack, unitIndex, promoId) {
      return stack[unitIndex].promotions.some(p => p.id === promoId);
    },

    // Is this promotion a free (locked) promotion for this unit?
    isFreePromotion(stack, unitIndex, promoId) {
      const unit = stack[unitIndex];
      return unit._freePromoIds && unit._freePromoIds.has(promoId);
    },

    // Promotions visible for a unit: filtered by combat type + requires/requiresAny
    // Always includes promotions the unit already has (e.g. free promotions)
    visiblePromotions(stack, unitIndex) {
      const unit = stack[unitIndex];
      const hasIds = new Set(unit.promotions.map(p => p.id));
      const combatType = unit.unitCombatType;
      return this.promotions.filter(promo => {
        // Always show promotions the unit already has
        if (hasIds.has(promo.id)) return true;
        // Must be eligible for this unit's combat type
        if (!promo.unitCombatTypes || !promo.unitCombatTypes.includes(combatType)) return false;
        // Prerequisites: requires (all) + requiresAny (at least one)
        const allMet = promo.requires.every(reqId => hasIds.has(reqId));
        const anyMet = !promo.requiresAny || promo.requiresAny.length === 0 || promo.requiresAny.some(reqId => hasIds.has(reqId));
        return allMet && anyMet;
      });
    },

    setDefenderFortification(idx, value) {
      this.defenderStack[idx].fortificationBonus = value;
      this.autoSimulate();
    },

    setAllFortification(value) {
      for (const unit of this.defenderStack) {
        if (!unit.noDefensiveBonus) unit.fortificationBonus = value;
      }
      this.autoSimulate();
    },

    allDefendersFortified(value) {
      const eligible = this.defenderStack.filter(u => !u.noDefensiveBonus);
      if (eligible.length === 0) return false;
      return eligible.every(u => u.fortificationBonus === value);
    },

    // Initialize the web worker
    _ensureWorker() {
      if (this._worker) return;
      this._worker = new Worker(new URL('./simulation-worker.js', import.meta.url), { type: 'module' });
      this._worker.onmessage = (e) => {
        const { taskId, results: rawResults } = e.data;
        // Ignore results from stale tasks
        if (taskId !== this._taskId) return;

        // Group per-expanded-unit results by original stack index
        const groupRates = (rates, mapping, origLen) => {
          const grouped = Array.from({ length: origLen }, () => []);
          for (let i = 0; i < rates.length; i++) {
            grouped[mapping[i]].push(rates[i]);
          }
          return grouped;
        };

        rawResults.attackerSurvivalRates = groupRates(
          rawResults.attackerSurvivalRates, this._mapAtk, this._attackerLen
        );
        rawResults.defenderSurvivalRates = groupRates(
          rawResults.defenderSurvivalRates, this._mapDef, this._defenderLen
        );
        rawResults.attackerOrderRanks = groupRates(
          rawResults.attackerOrderRanks, this._mapAtk, this._attackerLen
        );

        // Sort per-copy results by attack order within each unit group
        for (let i = 0; i < rawResults.attackerOrderRanks.length; i++) {
          const ranks = rawResults.attackerOrderRanks[i];
          const rates = rawResults.attackerSurvivalRates[i];
          if (ranks && ranks.length > 1) {
            const indices = ranks.map((r, j) => j).sort((a, b) => ranks[a] - ranks[b]);
            rawResults.attackerOrderRanks[i] = indices.map(j => ranks[j]);
            rawResults.attackerSurvivalRates[i] = indices.map(j => rates[j]);
          }
        }

        this.results = rawResults;

        // In auto mode, progressively run larger batches
        if (this.simMode === 'auto' && rawResults.numRuns < this._autoSimLimit) {
          const nextCount = Math.min(rawResults.numRuns * 10, this._autoSimLimit);
          this._dispatchWorker(nextCount);
        } else {
          this.isSimulating = false;
        }
      };
    },

    // Determine initial sim count based on total units
    _getInitialSimCount() {
      const totalUnits = this.totalAttackerCount + this.totalDefenderCount;
      if (totalUnits > 10000) return 1;
      if (totalUnits > 1000) return 10;
      if (totalUnits > 100) return 100;
      return 1000;
    },

    // Build context and expanded stacks, then post to worker
    _dispatchWorker(numRuns) {
      const isSea  = this.combatType === 'sea';
      const isLand = !isSea;
      const cityBuildingDefense = isLand
        ? (CITY_BUILDING_BONUSES[this.cityBuildings]?.defenseBonus || 0)
        : 0;
      const cityCultureDefense = isLand
        ? (CITY_CULTURE_BONUSES[this.cityCulture]?.defenseBonus || 0)
        : 0;
      // Determine terrain detail for unit-specific modifiers (hills, feature)
      const terrainId = isLand ? this.terrain : null;
      const isHills = terrainId === 'hill' || terrainId === 'hillForest';
      const featureType = (terrainId === 'forest' || terrainId === 'hillForest') ? 'forest' : null;

      const context = {
        terrainDefenseBonus: isSea
          ? (SEA_TERRAIN_BONUSES[this.seaTerrain]?.defenseBonus || 0)
          : (TERRAIN_BONUSES[this.terrain]?.defenseBonus || 0),
        cityBuildingDefense,
        cityCultureDefense,
        isHills,
        featureType,
        acrossRiver: isLand && this.attackPenalty === 'river',
        amphibious:  isLand && this.attackPenalty === 'amphibious',
        isAttackingCity: this.combatType === 'city',
        attackMode: this.attackMode,
      };

      const expandStack = (stack) => {
        const expanded = [];
        const mapping = [];
        for (let i = 0; i < stack.length; i++) {
          const count = stack[i].count || 1;
          for (let c = 0; c < count; c++) {
            expanded.push(stack[i]);
            mapping.push(i);
          }
        }
        return { expanded, mapping };
      };

      const { expanded: expAtk, mapping: mapAtk } = expandStack(this.attackerStack);
      const { expanded: expDef, mapping: mapDef } = expandStack(this.defenderStack);

      // Store mappings for when results come back
      this._mapAtk = mapAtk;
      this._mapDef = mapDef;
      this._attackerLen = this.attackerStack.length;
      this._defenderLen = this.defenderStack.length;

      // Deep-serialize units to plain objects (strips Sets, Alpine proxies, etc.)
      const clean = (stack) => JSON.parse(JSON.stringify(
        stack.map(u => {
          const { _freePromoIds, ...rest } = u;
          return rest;
        })
      ));

      this._worker.postMessage({
        taskId: this._taskId,
        attackerStack: clean(expAtk),
        defenderStack: clean(expDef),
        context,
        numRuns,
      });
    },

    // Cancel any running simulation
    _cancelSimulation() {
      this._taskId++;
      this.isSimulating = false;
      // Terminate worker to abort any long-running computation
      if (this._worker) {
        this._worker.terminate();
        this._worker = null;
      }
    },

    // Auto-simulate on every change
    autoSimulate() {
      if (this.attackerStack.length === 0 || this.defenderStack.length === 0) {
        this._cancelSimulation();
        this.results = null;
        return;
      }
      if (this.simMode === 'auto') {
        this._cancelSimulation();
        this._ensureWorker();
        this.isSimulating = true;
        this._dispatchWorker(this._getInitialSimCount());
      }
    },

    // Run simulation (manual mode or explicit call)
    simulate(count) {
      if (this.attackerStack.length === 0 || this.defenderStack.length === 0) return;
      this._cancelSimulation();
      this._ensureWorker();
      this.isSimulating = true;
      const n = count ?? this.numSimulations;
      this._dispatchWorker(n);
    },

    // Total defender bonus from all active sources
    get totalDefenseBreakdown() {
      if (this.combatType === 'sea') {
        return { total: SEA_TERRAIN_BONUSES[this.seaTerrain]?.defenseBonus || 0 };
      }
      const terrain = TERRAIN_BONUSES[this.terrain]?.defenseBonus || 0;
      const city = this.combatType === 'city'
        ? Math.max(
            CITY_BUILDING_BONUSES[this.cityBuildings]?.defenseBonus || 0,
            CITY_CULTURE_BONUSES[this.cityCulture]?.defenseBonus  || 0
          )
        : 0;
      const water = this.attackPenalty === 'river' ? 25
        : this.attackPenalty === 'amphibious' ? 50 : 0;
      return { total: terrain + city + water };
    },

    // City defence breakdown (buildings & culture don't stack — only highest applies)
    get effectiveCityDefenseInfo() {
      const building = CITY_BUILDING_BONUSES[this.cityBuildings]?.defenseBonus || 0;
      const culture  = CITY_CULTURE_BONUSES[this.cityCulture]?.defenseBonus  || 0;
      return { building, culture, effective: Math.max(building, culture) };
    },

    // Terrain options filtered for combat type (cities can't be on forest)
    get activeTerrainOptions() {
      if (this.combatType === 'city') {
        return this.terrainOptions.filter(t => t.id === 'flat' || t.id === 'hill');
      }
      return this.terrainOptions;
    },

    // Unit tooltip
    tooltip: null,
    tooltipPos: { x: 0, y: 0 },

    showTooltip(unit, event) {
      this.tooltip = unit;
      this.tooltipPos = { x: event.clientX, y: event.clientY };
    },
    showPromoTooltip(promo, event) {
      this.tooltip = promo;
      this.tooltipPos = { x: event.clientX, y: event.clientY };
    },
    moveTooltip(event) {
      this.tooltipPos = { x: event.clientX, y: event.clientY };
    },
    hideTooltip() {
      this.tooltip = null;
    },

    getUnitStats(unit) {
      const lines = [];

      // First strikes: free combat rounds where only you deal damage
      if (unit.firstStrikes > 0 && unit.firstStrikeChances > 0)
        lines.push(`${unit.firstStrikes} first strike${unit.firstStrikes > 1 ? 's' : ''} + ${unit.firstStrikeChances} chance${unit.firstStrikeChances > 1 ? 's' : ''}`);
      else if (unit.firstStrikes > 0)
        lines.push(`${unit.firstStrikes} guaranteed first strike${unit.firstStrikes > 1 ? 's' : ''}`);
      else if (unit.firstStrikeChances > 0)
        lines.push(`${unit.firstStrikeChances} first strike chance${unit.firstStrikeChances > 1 ? 's' : ''}`);

      // Immunity: nullifies enemy first strikes
      if (unit.immuneToFirstStrikes)       lines.push(`Immune to first strikes`);

      // Withdrawal: chance to retreat instead of dying on final hit
      if (unit.withdrawalChance > 0)       lines.push(`${unit.withdrawalChance}% withdrawal chance`);

      // Collateral: damages nearby defenders before combat begins
      if (unit.collateralDamage > 0)
        lines.push(`Collateral: ${unit.collateralDamage}% strength, up to ${unit.collateralDamageMaxUnits} units, max ${unit.collateralDamageLimit}% damage each`);

      // Combat limit: can't kill the defender, leaves them wounded
      if (unit.combatLimit < 100)          lines.push(`Can't kill: leaves defender at ${100 - unit.combatLimit}% HP`);

      // City bonuses (unit-inherent, not from buildings)
      if (unit.cityAttackBonus)            lines.push(`+${unit.cityAttackBonus}% attacking cities`);
      if (unit.cityDefenseBonus)           lines.push(`+${unit.cityDefenseBonus}% defending cities`);

      // Hills defense (unit-inherent, stacks with terrain)
      if (unit.hillsDefenseBonus)          lines.push(`+${unit.hillsDefenseBonus}% hills defense`);

      // Vs combat type: applies on both attack and defense
      if (unit.bonusVsMelee)               lines.push(`+${unit.bonusVsMelee}% vs melee`);
      if (unit.bonusVsMounted)             lines.push(`+${unit.bonusVsMounted}% vs mounted`);
      if (unit.bonusVsArcher)              lines.push(`+${unit.bonusVsArcher}% vs archery`);
      if (unit.bonusVsGun)                 lines.push(`+${unit.bonusVsGun}% vs gunpowder`);

      // Attack-only bonuses vs specific unit classes
      if (unit.attackBonusVsAxemen)        lines.push(`+${unit.attackBonusVsAxemen}% attack vs axemen`);
      if (unit.attackBonusVsCatapults)     lines.push(`+${unit.attackBonusVsCatapults}% attack vs catapults`);
      if (unit.attackBonusVsCannons)       lines.push(`+${unit.attackBonusVsCannons}% attack vs cannons`);
      if (unit.attackBonusVsRiflemen)      lines.push(`+${unit.attackBonusVsRiflemen}% attack vs riflemen`);
      if (unit.attackBonusVsFrigates)      lines.push(`+${unit.attackBonusVsFrigates}% attack vs frigates`);
      if (unit.attackBonusVsGalleys)       lines.push(`+${unit.attackBonusVsGalleys}% attack vs galleys`);

      // Defense-only bonuses vs specific unit classes
      if (unit.defenseBonusVsGalleys)      lines.push(`+${unit.defenseBonusVsGalleys}% defense vs galleys`);
      if (unit.defenseBonusVsChariots)     lines.push(`+${unit.defenseBonusVsChariots}% defense vs chariots`);
      if (unit.defenseBonusVsFrigates)     lines.push(`+${unit.defenseBonusVsFrigates}% defense vs frigates`);

      // Flanking strikes: damages specific unit types in stack on win/withdrawal (outside cities)
      if (unit.flankingStrikes) {
        const targets = Object.keys(unit.flankingStrikes).map(t => t + 's').join(', ');
        lines.push(`Flanking strikes vs ${targets}`);
      }

      // Unit combat targets: prioritizes attacking specific combat types in stacks
      if (unit.unitCombatTargets && unit.unitCombatTargets.length > 0)
        lines.push(`Targets ${unit.unitCombatTargets.join(', ')} units in stacks`);

      // No defensive bonus: doesn't receive terrain or city building/culture defense
      if (unit.noDefensiveBonus)           lines.push(`No terrain/building defense bonus`);

      // Ignores walls/castle: defender's building defense set to 0
      if (unit.ignoreBuildingDefense)      lines.push(`Ignores defender's walls and castles`);

      // Collateral immunity: immune to collateral from specific combat types
      if (unit.collateralImmuneVs && unit.collateralImmuneVs.length > 0)
        lines.push(`Immune to ${unit.collateralImmuneVs.join('/')} collateral`);

      // Free promotions
      if (unit.freePromotions && unit.freePromotions.length > 0) {
        const names = unit.freePromotions.map(id => {
          const p = PROMOTIONS.find(pr => pr.id === id);
          return p ? p.name : id;
        });
        lines.push(`Free: ${names.join(', ')}`);
      }
      return lines;
    },

    // Aggregate stats helpers (survivalRates are now array-of-arrays)
    avgStrengthRemaining(stack, side) {
      if (!this.results) return '';
      const rates = side === 'attacker' ? this.results.attackerSurvivalRates : this.results.defenderSurvivalRates;
      if (!rates || rates.length !== stack.length) return '';
      const remaining = stack.reduce((s, u, i) => {
        return s + rates[i].reduce((s2, r) => s2 + u.strength * r.avgHP / 100, 0);
      }, 0);
      const total = stack.reduce((s, u) => s + u.strength * (u.count || 1), 0);
      return remaining.toFixed(1) + ' / ' + total;
    },
    avgHammersDestroyed(stack, side) {
      if (!this.results) return '';
      const rates = side === 'attacker' ? this.results.attackerSurvivalRates : this.results.defenderSurvivalRates;
      if (!rates || rates.length !== stack.length) return '';
      return Math.round(stack.reduce((s, u, i) => {
        return s + rates[i].reduce((s2, r) => s2 + u.cost * (1 - r.survivalRate), 0);
      }, 0));
    },

    // Format fraction as integer percentage
    pct(value) {
      return Math.round(value * 100) + '%';
    },

    // HP bar color
    hpColor(hp) {
      if (hp > 66) return 'bg-green-500';
      if (hp > 33) return 'bg-yellow-500';
      return 'bg-red-500';
    },
  };
}
