// Civ4 BTS Combat Engine
//
// Implements: hit probability, firepower-based damage, HP-adjusted strength, modifiers,
//             first strikes, withdrawal, combat limit, collateral damage
//
// Sources:
// - CvUnit.cpp source code (Apolyton analysis)
// - https://www.civfanatics.com/civ4/strategy/combat-explained/

const COMBAT_DAMAGE = 20; // GC.COMBAT_DAMAGE from GlobalDefines.xml
const COLLATERAL_COMBAT_DAMAGE = 10; // GC.COLLATERAL_COMBAT_DAMAGE from GlobalDefines.xml
const COMBAT_DIE_SIDES = 1000; // GC.getDefineINT("COMBAT_DIE_SIDES") from GlobalDefines.xml
const MAX_HP = 100;
const STR_SCALE = 100; // Civ4 stores combat strength * 100 internally

// ── Strength & Firepower (Civ4 integer math) ──────────────────────────

/**
 * Max combat strength with modifier applied.
 * Returns value scaled the same way as the SDK's maxCombatStr():
 *   Positive modifier: baseCombatStr * (modifier + 100)
 *   Negative modifier: baseCombatStr * 10000 / (100 - modifier)
 *   Minimum: 1
 *
 * Note: The SDK does NOT divide by 100 — the result stays in a "scaled"
 * form where baseCombatStr * 100 is the unmodified value.
 */
export function maxCombatStrScaled(baseStrength, modifierPercent) {
  let iCombat;
  if (modifierPercent > 0) {
    iCombat = baseStrength * (modifierPercent + 100);
  } else {
    iCombat = Math.trunc((baseStrength * 10000) / (100 - modifierPercent));
  }
  return Math.max(1, iCombat);
}

/**
 * Current combat strength = max strength adjusted for current HP.
 * SDK: (maxCombatStr * currHitPoints) / maxHitPoints  [integer division]
 */
function currCombatStrScaled(maxStrScaled, currHP) {
  return Math.trunc(maxStrScaled * currHP / MAX_HP);
}

/**
 * Firepower = (maxStr + currStr + 1) / 2  [integer division]
 * A wounded unit has lower firepower, dealing less damage.
 */
function currFirepowerScaled(maxStrScaled, currStrScaled) {
  return Math.trunc((maxStrScaled + currStrScaled + 1) / 2);
}

// ── Damage Calculation ─────────────────────────────────────────────────

/**
 * Damage per hit using the Civ4 source code formula:
 *   strengthFactor = floor((AFP + DFP + 1) / 2)
 *   damageToDefender = max(1, floor(COMBAT_DAMAGE * (AFP + sf) / (DFP + sf)))
 *   damageToAttacker = max(1, floor(COMBAT_DAMAGE * (DFP + sf) / (AFP + sf)))
 */
function calcCombatDamage(attackerFP, defenderFP) {
  const sf = Math.trunc((attackerFP + defenderFP + 1) / 2);
  return {
    dmgToDefender: Math.max(1, Math.trunc(COMBAT_DAMAGE * (attackerFP + sf) / (defenderFP + sf))),
    dmgToAttacker: Math.max(1, Math.trunc(COMBAT_DAMAGE * (defenderFP + sf) / (attackerFP + sf))),
  };
}

// ── Modifier Calculation ───────────────────────────────────────────────

/**
 * Get the unit class for a unit (base unit id, or what it replaces for UUs).
 * Used for attack/defense bonuses vs specific unit classes.
 */
function unitClass(unit) {
  return unit.replaces || unit.id;
}

/**
 * Sum hills defense modifier from unit base + promotions.
 * SDK: hillsDefenseModifier() = unitInfo.getHillsDefenseModifier() + getExtraHillsDefensePercent()
 * Archer, Mali Skirmisher, Babylon Bowman, Longbowman have inherent +25% hills defense.
 */
function getHillsDefenseModifier(unit) {
  let mod = unit.hillsDefenseBonus || 0;
  if (unit.promotions) {
    for (const p of unit.promotions) {
      if (p.hillsDefensePercent) mod += p.hillsDefensePercent;
    }
  }
  return mod;
}

/**
 * Sum hills attack modifier from a unit's promotions.
 * SDK: hillsAttackModifier() = unitInfo.getHillsAttackModifier() + getExtraHillsAttackPercent()
 */
function getHillsAttackModifier(unit) {
  let mod = 0;
  if (unit.promotions) {
    for (const p of unit.promotions) {
      if (p.hillsAttackPercent) mod += p.hillsAttackPercent;
    }
  }
  return mod;
}

/**
 * Sum feature defense modifier for a specific feature type from promotions.
 * SDK: featureDefenseModifier(eFeature) = unitInfo + getExtraFeatureDefensePercent(eFeature)
 */
function getFeatureDefenseModifier(unit, featureType) {
  if (!featureType) return 0;
  let mod = 0;
  if (unit.promotions) {
    for (const p of unit.promotions) {
      if (p.featureDefensePercent) {
        mod += p.featureDefensePercent;
      }
    }
  }
  return mod;
}

/**
 * Sum feature attack modifier for a specific feature type from promotions.
 * SDK: featureAttackModifier(eFeature) = unitInfo + getExtraFeatureAttackPercent(eFeature)
 */
function getFeatureAttackModifier(unit, featureType) {
  if (!featureType) return 0;
  let mod = 0;
  if (unit.promotions) {
    for (const p of unit.promotions) {
      if (p.featureAttackPercent) {
        mod += p.featureAttackPercent;
      }
    }
  }
  return mod;
}

/**
 * Calculate the total modifier percentage for a unit.
 *
 * Matches the SDK's maxCombatStr() (CvUnit.cpp lines 7429-7871):
 *
 * When called for the DEFENDER (isAttacker=false, pPlot != NULL):
 *   1. getExtraCombatPercent() — flat strength from promotions
 *   2. Plot defense: pPlot->defenseModifier() — terrain/hills/city buildings
 *      (gated by noDefensiveBonus)
 *   3. fortifyModifier() — fortification bonus
 *      (units with noDefensiveBonus can't fortify: isFortifyable() returns false)
 *   4. cityDefenseModifier() — unit's own city defense + promotion city defense
 *   5. hillsDefenseModifier() — unit-specific hills defense from promotions
 *   6. featureDefenseModifier() — unit-specific forest/jungle defense from promotions
 *   7. terrainDefenseModifier() — unit-specific terrain defense (only if no feature)
 *   8. Attacker bonuses applied as NEGATIVES (city attack, hills attack, feature/terrain
 *      attack, unitClassAttack, unitCombatModifier, river, amphibious)
 *
 * When called for the ATTACKER (isAttacker=true, pPlot == NULL):
 *   Only getExtraCombatPercent() + vs-combat-type + vs-unit-class + city attack + etc.
 *   (These get subtracted from the defender's modifier in getCombinedDefenderModifier)
 *
 * Context: isAttacker, isAttackingCity, terrainDefenseBonus, cityBuildingDefense, cityCultureDefense,
 * isHills, featureType, acrossRiver, amphibious.
 */
function getModifierPercent(unit, opponent, context) {
  let mod = 0;

  // ── Promotion bonuses ──
  if (unit.promotions) {
    for (const promo of unit.promotions) {
      // Flat strength bonus (Combat I–VI)
      // SDK: getExtraCombatPercent()
      if (promo.strengthPercent) mod += promo.strengthPercent;

      // City attack (attacker attacking city)
      // SDK: cityAttackModifier() = unitInfo + getExtraCityAttackPercent()
      if (context.isAttackingCity && context.isAttacker && promo.cityAttackPercent) {
        mod += promo.cityAttackPercent;
      }

      // City defense (defender in city)
      // SDK: cityDefenseModifier() = unitInfo + getExtraCityDefensePercent()
      // NOT gated by noDefensiveBonus — this is a unit modifier, not plot defense
      if (context.isAttackingCity && !context.isAttacker && promo.cityDefensePercent) {
        mod += promo.cityDefensePercent;
      }

      // Vs combat type bonuses from promotions
      // SDK: unitCombatModifier(eUnitCombat) = unitInfo + getExtraUnitCombatModifier()
      const oCT = opponent.unitCombatType;
      if (promo.strengthPercentVsMelee && oCT === 'melee') mod += promo.strengthPercentVsMelee;
      if (promo.strengthPercentVsArchery && oCT === 'archery') mod += promo.strengthPercentVsArchery;
      if (promo.strengthPercentVsMounted && oCT === 'mounted') mod += promo.strengthPercentVsMounted;
      if (promo.strengthPercentVsGun && oCT === 'gun') mod += promo.strengthPercentVsGun;
      if (promo.strengthPercentVsSiege && oCT === 'siege') mod += promo.strengthPercentVsSiege;
      if (promo.strengthPercentVsArmor && oCT === 'armor') mod += promo.strengthPercentVsArmor;
    }
  }

  // ── Unit-inherent bonuses vs combat types (apply on attack and defense) ──
  // SDK: unitCombatModifier(eUnitCombat) includes unitInfo base value
  const oCT = opponent.unitCombatType;
  if (unit.bonusVsMelee && oCT === 'melee') mod += unit.bonusVsMelee;
  if (unit.bonusVsMounted && oCT === 'mounted') mod += unit.bonusVsMounted;
  if (unit.bonusVsArcher && oCT === 'archery') mod += unit.bonusVsArcher;
  if (unit.bonusVsGun && oCT === 'gun') mod += unit.bonusVsGun;

  // ── City attack bonus (attacker in city assault) ──
  // SDK: cityAttackModifier() includes unitInfo base value
  if (context.isAttackingCity && context.isAttacker && unit.cityAttackBonus) {
    mod += unit.cityAttackBonus;
  }

  // ── Attack bonuses vs specific unit classes (attacker only) ──
  // SDK: unitClassAttackModifier(eUnitClass)
  if (context.isAttacker) {
    const oClass = unitClass(opponent);
    if (unit.attackBonusVsAxemen && oClass === 'axeman') mod += unit.attackBonusVsAxemen;
    if (unit.attackBonusVsCatapults && oClass === 'catapult') mod += unit.attackBonusVsCatapults;
    if (unit.attackBonusVsCannons && oClass === 'cannon') mod += unit.attackBonusVsCannons;
    if (unit.attackBonusVsRiflemen && oClass === 'rifleman') mod += unit.attackBonusVsRiflemen;
    if (unit.attackBonusVsFrigates && oClass === 'frigate') mod += unit.attackBonusVsFrigates;
  }

  // ── Defense bonuses vs specific unit classes (defender only) ──
  // SDK: unitClassDefenseModifier(eUnitClass)
  if (!context.isAttacker) {
    const oClass = unitClass(opponent);
    if (unit.defenseBonusVsGalleys && oClass === 'galley') mod += unit.defenseBonusVsGalleys;
    if (unit.defenseBonusVsChariots && oClass === 'chariot') mod += unit.defenseBonusVsChariots;
    if (unit.defenseBonusVsFrigates && oClass === 'frigate') mod += unit.defenseBonusVsFrigates;
  }

  // ── Attacker-only: hills/feature attack modifiers from promotions ──
  // SDK lines 7697-7724: applied as negatives on defender via iTempModifier
  // We add them here so getAttackerTacticalModifier picks them up
  if (context.isAttacker) {
    if (context.isHills) {
      mod += getHillsAttackModifier(unit);
    }
    if (context.featureType) {
      mod += getFeatureAttackModifier(unit, context.featureType);
    }
  }

  // ── Defender-only bonuses ──
  if (!context.isAttacker) {
    // SDK line 7609: noDefensiveBonus gates ONLY pPlot->defenseModifier()
    // pPlot->defenseModifier() includes: terrain/feature base, hills base,
    // improvement defense, and city building/culture defense.
    if (!unit.noDefensiveBonus) {
      // Plot defense (terrain base + hills base)
      if (context.terrainDefenseBonus) mod += context.terrainDefenseBonus;

      // City defense from buildings/culture
      // SDK: pPlot->defenseModifier(team, pAttacker->ignoreBuildingDefense())
      // CvCity::getTotalDefense: max(bIgnore ? 0 : buildingDef, cultureDef)
      // When attacker has ignoreBuildingDefense, building defense is excluded
      if (context.cityBuildingDefense || context.cityCultureDefense) {
        const bIgnoreBuilding = opponent && opponent.ignoreBuildingDefense;
        const buildingDef = bIgnoreBuilding ? 0 : (context.cityBuildingDefense || 0);
        const cultureDef = context.cityCultureDefense || 0;
        mod += Math.max(buildingDef, cultureDef);
      }
    }

    // SDK line 7619: fortifyModifier() — outside noDefensiveBonus check, but
    // isFortifyable() returns false for noDefensiveBonus units, so effectively 0
    if (unit.fortificationBonus) mod += unit.fortificationBonus;

    // SDK line 7626-7634: cityDefenseModifier() — unit's own city defense
    // (unitInfo + promotion cityDefensePercent, NOT gated by noDefensiveBonus)
    // Promotion cityDefensePercent is already added above in the promotions loop
    if (context.isAttackingCity && unit.cityDefenseBonus) {
      mod += unit.cityDefenseBonus;
    }

    // SDK line 7636-7644: hillsDefenseModifier() — unit-specific hills defense
    // from promotions (Guerilla line). NOT gated by noDefensiveBonus.
    if (context.isHills) {
      mod += getHillsDefenseModifier(unit);
    }

    // SDK lines 7646-7663: feature/terrain defense modifier from unit/promotions
    // featureDefenseModifier if feature present, else terrainDefenseModifier
    // NOT gated by noDefensiveBonus.
    if (context.featureType) {
      mod += getFeatureDefenseModifier(unit, context.featureType);
    }
    // Note: terrainDefenseModifier (no feature) — no units/promotions currently
    // have base terrain defense, so we skip it for now.

    // SDK line 7799-7809: River crossing penalty
    // -GC.getRIVER_ATTACK_MODIFIER() where RIVER_ATTACK_MODIFIER = -25 in BTS
    // Result: -(-25) = +25 added to defender's modifier
    // Negated if attacker has isRiver() (Amphibious promotion grants this)
    if (context.acrossRiver) {
      const attackerHasAmphibious = opponent.promotions?.some(p => p.id === 'amphibious');
      if (!attackerHasAmphibious) mod += 25;
    }

    // SDK line 7812-7823: Amphibious landing penalty
    // -GC.getAMPHIB_ATTACK_MODIFIER() where AMPHIB_ATTACK_MODIFIER = -50 in BTS
    // Negated if attacker has isAmphib() (Amphibious promotion grants this)
    if (context.amphibious) {
      const attackerHasAmphibious = opponent.promotions?.some(p => p.id === 'amphibious');
      if (!attackerHasAmphibious) mod += 50;
    }
  }

  return mod;
}

// ── Unit Attribute Helpers (unit base + promotions) ───────────────────

/**
 * Total guaranteed first strikes and first strike chances (unit + promotions).
 */
export function getEffectiveFirstStrikes(unit) {
  let fs = unit.firstStrikes || 0;
  let fsc = unit.firstStrikeChances || 0;
  if (unit.promotions) {
    for (const p of unit.promotions) {
      if (p.firstStrikes) fs += p.firstStrikes;
      if (p.firstStrikeChances) fsc += p.firstStrikeChances;
    }
  }
  return { guaranteed: fs, chances: fsc };
}

/**
 * Is this unit immune to the opponent's first strikes?
 */
export function isUnitImmuneToFirstStrikes(unit) {
  if (unit.immuneToFirstStrikes) return true;
  return unit.promotions?.some(p => p.immuneToFirstStrikes) || false;
}

/**
 * Total withdrawal chance % (unit + promotions). Not capped — Civ4 doesn't cap either.
 */
export function getEffectiveWithdrawalChance(unit) {
  let wc = unit.withdrawalChance || 0;
  if (unit.promotions) {
    for (const p of unit.promotions) {
      if (p.withdrawalChance) wc += p.withdrawalChance;
    }
  }
  return wc;
}

/**
 * Base collateral damage % (unit only, no promotions).
 * SDK: CvUnit::collateralDamage() returns max(0, unitInfo.getCollateralDamage())
 * Used for iCollateralStrength calculation.
 */
function getBaseCollateralDamage(unit) {
  return Math.max(0, unit.collateralDamage || 0);
}

/**
 * Extra collateral damage % from promotions (Barrage line).
 * SDK: CvUnit::getExtraCollateralDamage() returns m_iExtraCollateralDamage
 * Applied as a separate multiplier: damage *= (100 + extraCollateralDamage) / 100
 */
function getExtraCollateralDamage(unit) {
  let extra = 0;
  if (unit.promotions) {
    for (const p of unit.promotions) {
      if (p.collateralDamageChange) extra += p.collateralDamageChange;
    }
  }
  return extra;
}

/**
 * Collateral damage protection % (from drill promotions), capped at 100.
 */
function getCollateralDamageProtection(unit) {
  let prot = 0;
  if (unit.promotions) {
    for (const p of unit.promotions) {
      if (p.collateralDamageProtection) prot += p.collateralDamageProtection;
    }
  }
  return Math.min(100, prot);
}

// ── SDK-style Modifier Architecture ─────────────────────────────────
//
// In the SDK (CvUnit::maxCombatStr, lines 7429-7871):
//   - The ATTACKER calls maxCombatStr(NULL, NULL):
//     Only includes getExtraCombatPercent() (Combat I-VI promotions).
//   - The DEFENDER calls maxCombatStr(plot, attacker):
//     Includes defender's own bonuses (getExtraCombatPercent + terrain +
//     city defense + fortification + vs-type + etc.) PLUS the attacker's
//     tactical bonuses applied as NEGATIVE values (city attack, hills attack,
//     vs-unit-type, etc.).
//
// This matters because the positive/negative modifier formula is nonlinear:
// subtracting attacker Combat I from defender != adding it to attacker.

/**
 * Get the attacker's base modifier (what the SDK applies to the attacker's
 * own maxCombatStr when called with NULL, NULL).
 *
 * This is ONLY getExtraCombatPercent() — the flat strength bonuses from
 * promotions (Combat I-VI etc.).
 */
export function getAttackerBaseModifier(attacker) {
  let mod = 0;
  if (attacker.promotions) {
    for (const promo of attacker.promotions) {
      if (promo.strengthPercent) mod += promo.strengthPercent;
    }
  }
  return mod;
}

/**
 * Get the attacker's tactical modifier — bonuses that the SDK applies as
 * NEGATIVES to the defender's maxCombatStr (lines 7673-7843).
 *
 * This is everything from getModifierPercent(attacker, isAttacker:true)
 * EXCEPT the base strengthPercent (which goes on the attacker's own side).
 */
function getAttackerTacticalModifier(attacker, defender, context) {
  const fullMod = getModifierPercent(attacker, defender, { ...context, isAttacker: true });
  const baseMod = getAttackerBaseModifier(attacker);
  return fullMod - baseMod;
}

/**
 * Compute the combined modifier for the defender's maxCombatStr, matching
 * the SDK's architecture exactly.
 *
 * Returns the total modifier to apply to the defender's baseCombatStr.
 * Includes:
 *   1. Defender's own full modifier (getExtraCombatPercent + terrain + city + etc.)
 *   2. Attacker's tactical bonuses as negatives (city attack, vs-type, etc.)
 */
export function getCombinedDefenderModifier(attacker, defender, context) {
  // Defender's own full modifier
  let mod = getModifierPercent(defender, attacker, { ...context, isAttacker: false });

  // Attacker's tactical bonuses as negatives on the defender
  // (excludes attacker's strengthPercent which goes on the attacker's own side)
  const tacticalMod = getAttackerTacticalModifier(attacker, defender, context);
  mod -= tacticalMod;

  return mod;
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Calculate effective strength of a unit (used by simulation.js for
 * defender/attacker selection). Returns unscaled strength value.
 */
export function calculateEffectiveStrength(unit, opponent, context) {
  const mod = getModifierPercent(unit, opponent, context);
  const maxStr = maxCombatStrScaled(unit.strength, mod);
  return maxStr / STR_SCALE;
}

/**
 * Simulate a single combat between attacker and defender.
 *
 * Both units must have `hp` (current HP, 1–100) and `strength` (base).
 * Returns { attackerHP, defenderHP, withdrawn }.
 *
 * Matches the SDK's resolveCombat() (CvUnit.cpp lines 1051-1178) exactly:
 *
 * Strength architecture (SDK lines 1056-1063):
 *   Attacker: currCombatStr(NULL, NULL) — only getExtraCombatPercent()
 *     (Combat I-VI promotions, flat strength bonuses)
 *   Defender: currCombatStr(plot, attacker) — all defender bonuses plus
 *     attacker's tactical bonuses (city attack, vs-type, etc.) as negatives
 *
 * Combat round loop (SDK lines 1078-1177):
 *   1. Roll random < defenderOdds (discrete die-based)
 *   2. If defender wins roll: damage to attacker ONLY IF attacker has 0 FS
 *      (having FS protects you from taking damage)
 *   3. If attacker wins roll: damage to defender ONLY IF defender has 0 FS
 *   4. Decrement both sides' FS counters
 *   5. Check death, break if dead
 */
export function simulateSingleCombat(attacker, defender, context) {
  // SDK architecture: attacker maxCombatStr(NULL, NULL) includes only
  // getExtraCombatPercent() (Combat I-VI promotions, flat strength bonuses)
  const aBaseMod = getAttackerBaseModifier(attacker);
  const aMaxStr = maxCombatStrScaled(attacker.strength, aBaseMod);

  // All modifiers (defender's own + attacker's bonuses as negatives) go on defender
  const dCombinedMod = getCombinedDefenderModifier(attacker, defender, context);
  const dMaxStr = maxCombatStrScaled(defender.strength, dCombinedMod);

  let aHP = attacker.hp;
  let dHP = defender.hp;

  // Strengths and firepower at combat start (fixed for entire combat)
  const aCurrStr = currCombatStrScaled(aMaxStr, aHP);
  const dCurrStr = currCombatStrScaled(dMaxStr, dHP);

  const aFP = currFirepowerScaled(aMaxStr, aCurrStr);
  const dFP = currFirepowerScaled(dMaxStr, dCurrStr);

  // Discrete hit probability matching SDK (CvUnit.cpp line 12285):
  //   iDefenderOdds = COMBAT_DIE_SIDES * defStr / (attStr + defStr)
  const iDefenderOdds = Math.trunc(COMBAT_DIE_SIDES * dCurrStr / (aCurrStr + dCurrStr));

  // Damage per hit (fixed for entire combat)
  const { dmgToDefender, dmgToAttacker } = calcCombatDamage(aFP, dFP);

  // ── First strikes ──
  // SDK (line 10688): setCombatFirstStrikes(immuneToFS ? 0 : firstStrikes() + getSorenRandNum(chanceFirstStrikes() + 1))
  const aFS = getEffectiveFirstStrikes(attacker);
  const dFS = getEffectiveFirstStrikes(defender);

  let aFirstStrikes = aFS.guaranteed;
  if (aFS.chances > 0) aFirstStrikes += Math.floor(Math.random() * (aFS.chances + 1));

  let dFirstStrikes = dFS.guaranteed;
  if (dFS.chances > 0) dFirstStrikes += Math.floor(Math.random() * (dFS.chances + 1));

  // Immunity: if opponent is immune, your first strikes are nullified
  if (isUnitImmuneToFirstStrikes(defender)) aFirstStrikes = 0;
  if (isUnitImmuneToFirstStrikes(attacker)) dFirstStrikes = 0;

  // ── Withdrawal chance ──
  const withdrawalPct = getEffectiveWithdrawalChance(attacker);

  // ── Combat limit ──
  // SDK (line 1117): min(MAX_HIT_POINTS, damage + existingDamage) > combatLimit
  // In HP terms: defender can't drop below maxHP - combatLimit
  const combatLimit = attacker.combatLimit ?? 100;
  const defenderHitLimit = MAX_HP - combatLimit; // SDK: maxHitPoints - combatLimit()

  // ── Combat rounds (matches SDK resolveCombat lines 1078-1177) ──
  const maxRounds = 200; // safety limit
  let rounds = 0;
  let withdrawn = false;

  while (rounds < maxRounds) {
    // SDK line 1080: roll = getSorenRandNum(COMBAT_DIE_SIDES)
    const roll = Math.floor(Math.random() * COMBAT_DIE_SIDES);

    if (roll < iDefenderOdds) {
      // Defender wins the round (SDK line 1080: roll < iDefenderOdds)
      // SDK line 1082: damage only if attacker has 0 first strikes
      if (aFirstStrikes === 0) {
        // SDK line 1084: withdrawal check — if damage would kill attacker
        const aDamage = MAX_HP - aHP; // current damage in SDK terms
        if (aDamage + dmgToAttacker >= MAX_HP && withdrawalPct > 0) {
          if (Math.floor(Math.random() * 100) < withdrawalPct) {
            withdrawn = true;
            break; // attacker keeps pre-damage HP
          }
        }
        // SDK line 1092: changeDamage(iAttackerDamage)
        aHP = Math.max(0, aHP - dmgToAttacker);
      }
    } else {
      // Attacker wins the round
      // SDK line 1115: damage only if defender has 0 first strikes
      if (dFirstStrikes === 0) {
        // SDK line 1117: combat limit check
        const dDamage = MAX_HP - dHP; // current damage in SDK terms
        if (Math.min(MAX_HP, dDamage + dmgToDefender) > combatLimit) {
          // Combat limit reached — set defender to limit and break
          dHP = defenderHitLimit;
          withdrawn = true;
          break;
        }
        // SDK line 1124: pDefender->changeDamage(iDefenderDamage)
        dHP = Math.max(0, dHP - dmgToDefender);
      }
    }

    // SDK lines 1146-1154: decrement first strike counters
    if (aFirstStrikes > 0) aFirstStrikes--;
    if (dFirstStrikes > 0) dFirstStrikes--;

    // SDK line 1156: check death
    if (aHP <= 0 || dHP <= 0) {
      break;
    }

    rounds++;
  }

  // SDK line 1064: iAttackerKillOdds = iDefenderOdds * (100 - withdrawalProbability()) / 100
  const iAttackerKillOdds = Math.trunc(iDefenderOdds * (100 - withdrawalPct) / 100);

  return {
    attackerHP: Math.max(0, aHP),
    defenderHP: Math.max(0, dHP),
    withdrawn,
    // Expose for flanking strikes (SDK passes these to flankingStrikeCombat)
    iAttackerKillOdds,
    dmgToDefender,
  };
}

/**
 * Apply flanking strike damage from an attacker to the defender stack.
 *
 * SDK: CvUnit::flankingStrikeCombat() (CvUnit.cpp lines 11621-11704)
 * Called when attacker wins combat or withdraws, ONLY outside cities.
 *
 * For each defender in the stack (skipping the fought unit):
 *   - Check if attacker has flankingStrikes vs that unit's class
 *   - Roll: rand(COMBAT_DIE_SIDES) >= iDefenderOdds (uses the odds adjusted for withdrawal)
 *   - If hit: damage = flankingStrength * iDefenderDamage / 100
 *   - Capped at collateralDamageLimit
 *   - Max targets: collateralDamageMaxUnits
 *
 * @param {Object} attacker — attacking unit
 * @param {Array}  defenders — defender stack (mutable)
 * @param {number} foughtIdx — index of defender that was fought (skipped)
 * @param {number} iAttackerKillOdds — iDefenderOdds * (100 - withdrawal%) / 100
 * @param {number} iDefenderDamage — damage per round to defender from the combat
 */
export function applyFlankingStrikes(attacker, defenders, foughtIdx, iAttackerKillOdds, iDefenderDamage) {
  if (!attacker.flankingStrikes) return;

  // SDK line 11623: only outside cities
  // Context check is done by the caller (simulation.js)

  const collDmgLimit = attacker.collateralDamageLimit
    ? Math.trunc(attacker.collateralDamageLimit * MAX_HP / 100)
    : MAX_HP;
  const maxTargets = attacker.collateralDamageMaxUnits || Infinity;

  // Build list of eligible flanked units with their damage
  const flankedUnits = [];
  for (let i = 0; i < defenders.length; i++) {
    if (i === foughtIdx) continue;
    const target = defenders[i];
    if (target.hp <= 0) continue;

    // SDK line 11644: getFlankingStrikeUnitClass(pLoopUnit->getUnitClassType())
    const targetClass = target.replaces || target.id;
    const iFlankingStrength = attacker.flankingStrikes[targetClass];
    if (!iFlankingStrength || iFlankingStrength <= 0) continue;

    // SDK line 11655: roll >= iDefenderOdds (using iAttackerKillOdds)
    if (Math.floor(Math.random() * COMBAT_DIE_SIDES) >= iAttackerKillOdds) {
      // SDK line 11657: iCollateralDamage = (iFlankingStrength * iDefenderDamage) / 100
      const iCollateralDamage = Math.trunc(iFlankingStrength * iDefenderDamage / 100);

      // SDK line 11658: iUnitDamage = max(existingDamage, min(existingDamage + iCollateralDamage, collateralDamageLimit))
      const existingDamage = MAX_HP - target.hp;
      const iUnitDamage = Math.max(existingDamage, Math.min(existingDamage + iCollateralDamage, collDmgLimit));

      if (existingDamage !== iUnitDamage) {
        flankedUnits.push({ index: i, damage: iUnitDamage });
      }
    }
  }

  // SDK line 11672: iNumUnitsHit = min(flankedUnits.size(), collateralDamageMaxUnits())
  const iNumUnitsHit = Math.min(flankedUnits.length, maxTargets);

  // SDK lines 11674-11690: Pick random targets from the list and apply damage
  const remaining = [...flankedUnits];
  for (let i = 0; i < iNumUnitsHit; i++) {
    const randIdx = Math.floor(Math.random() * remaining.length);
    const picked = remaining[randIdx];
    defenders[picked.index].hp = MAX_HP - picked.damage;
    remaining.splice(randIdx, 1);
  }
}

/**
 * Apply collateral damage from an attacker to the defender stack.
 *
 * SDK: CvUnit::collateralCombat() (CvUnit.cpp lines 11490-11618)
 * Called BEFORE the main combat loop (line 1076 in resolveCombat).
 * Uses attacker's PRE-COMBAT state (full HP at time of call).
 *
 * Key SDK details:
 * - iCollateralStrength = baseCombatStr() * collateralDamage() / 100  (NO HP scaling)
 * - Targets selected by random priority weighted by currHitPoints (healthier = more likely)
 * - getExtraCollateralDamage() applied as separate multiplier (not in strength calc)
 * - collateralDamageLimit() = unitInfo.getCollateralDamageLimit() * MAX_HIT_POINTS / 100
 * - iMaxDamage also scaled by strength ratio
 * - Two separate /100 divisions for the multipliers
 *
 * @param {Object} attacker — attacking unit (pre-combat HP)
 * @param {Array}  defenders — defender stack (mutable; hp will be modified)
 * @param {number} foughtIdx — index of defender that was fought (skipped)
 */
export function applyCollateralDamage(attacker, defenders, foughtIdx) {
  // SDK line 11508: iCollateralStrength = baseCombatStr() * collateralDamage() / 100
  // Uses ONLY base collateralDamage, not promotions (those are a separate multiplier)
  const baseCollDmg = getBaseCollateralDamage(attacker);
  const iCollateralStrength = Math.trunc(attacker.strength * STR_SCALE * baseCollDmg / 100);

  // SDK line 11509: if (iCollateralStrength == 0) return
  if (iCollateralStrength === 0) return;

  // SDK line 11514: iPossibleTargets = min(visibleEnemyDefenders - 1, collateralDamageMaxUnits())
  const aliveDefenders = defenders.filter((d, i) => d.hp > 0 && i !== foughtIdx);
  const maxTargets = attacker.collateralDamageMaxUnits || 0;
  const iPossibleTargets = Math.min(aliveDefenders.length, maxTargets);
  if (iPossibleTargets <= 0) return;

  // SDK line 8525: collateralDamageLimit() = unitInfo.getCollateralDamageLimit() * MAX_HIT_POINTS / 100
  const iCollateralDamageLimit = Math.trunc((attacker.collateralDamageLimit || 0) * MAX_HP / 100);

  // Extra collateral damage from promotions (Barrage line)
  const extraCollDmg = getExtraCollateralDamage(attacker);

  // SDK lines 11531-11535: Target selection with random priority weighted by currHitPoints
  // iValue = (1 + rand(0..9999)) * currHitPoints — higher values selected first
  const targetCandidates = [];
  for (let i = 0; i < defenders.length; i++) {
    if (i === foughtIdx) continue;
    if (defenders[i].hp <= 0) continue;
    const iValue = (1 + Math.floor(Math.random() * 10000)) * defenders[i].hp;
    targetCandidates.push({ index: i, priority: iValue });
  }

  // Sort by priority descending (highest selected first, matching SDK's repeated max search)
  targetCandidates.sort((a, b) => b.priority - a.priority);

  // SDK lines 11551-11607: Process up to iPossibleTargets
  let iCount = 0;
  for (let t = 0; t < targetCandidates.length && iCount < iPossibleTargets; t++) {
    const target = defenders[targetCandidates[t].index];

    // SDK line 11569: skip if target is immune to collateral from attacker's combat type
    // getUnitCombatCollateralImmune(getUnitCombatType()) checks attacker's unitCombatType
    if (attacker.unitCombatType && target.collateralImmuneVs &&
        target.collateralImmuneVs.includes(attacker.unitCombatType)) {
      continue;
    }

    // SDK line 11571: iTheirStrength = pBestUnit->baseCombatStr()
    const iTheirStrength = target.strength * STR_SCALE;

    // SDK line 11573: iStrengthFactor = (iCollateralStrength + iTheirStrength + 1) / 2
    // NOTE: SDK does NOT use max(1, ...) here — just plain integer division
    const iStrengthFactor = Math.trunc((iCollateralStrength + iTheirStrength + 1) / 2);

    // SDK line 11575: iCollateralDamage = COLLATERAL_COMBAT_DAMAGE * (iCollStr + sf) / (theirStr + sf)
    let iCollateralDamage = Math.trunc(COLLATERAL_COMBAT_DAMAGE * (iCollateralStrength + iStrengthFactor) / (iTheirStrength + iStrengthFactor));

    // SDK line 11577: iCollateralDamage *= 100 + getExtraCollateralDamage()
    iCollateralDamage *= (100 + extraCollDmg);

    // SDK line 11579: iCollateralDamage *= max(0, 100 - target.getCollateralDamageProtection())
    const protection = getCollateralDamageProtection(target);
    iCollateralDamage *= Math.max(0, 100 - protection);

    // SDK line 11580: iCollateralDamage /= 100
    iCollateralDamage = Math.trunc(iCollateralDamage / 100);

    // SDK line 11588: iCollateralDamage /= 100  (second division)
    iCollateralDamage = Math.trunc(iCollateralDamage / 100);

    // SDK line 11590: iCollateralDamage = max(0, iCollateralDamage)
    iCollateralDamage = Math.max(0, iCollateralDamage);

    // SDK line 11592: iMaxDamage = min(collateralDamageLimit, collateralDamageLimit * (collStr + sf) / (theirStr + sf))
    const iMaxDamage = Math.min(
      iCollateralDamageLimit,
      Math.trunc(iCollateralDamageLimit * (iCollateralStrength + iStrengthFactor) / (iTheirStrength + iStrengthFactor))
    );

    // SDK line 11593: iUnitDamage = max(existingDamage, min(existingDamage + iCollateralDamage, iMaxDamage))
    // Convert between HP and damage: damage = MAX_HP - hp
    const existingDamage = MAX_HP - target.hp;
    const iUnitDamage = Math.max(existingDamage, Math.min(existingDamage + iCollateralDamage, iMaxDamage));

    // Apply damage (SDK line 11597: setDamage(iUnitDamage))
    target.hp = MAX_HP - iUnitDamage;

    iCount++;
  }
}
