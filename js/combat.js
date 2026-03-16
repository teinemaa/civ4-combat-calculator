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
const MAX_HP = 100;
const STR_SCALE = 100; // Civ4 stores combat strength * 100 internally

// ── Strength & Firepower (Civ4 integer math) ──────────────────────────

/**
 * Max combat strength (scaled by 100), with modifier applied.
 * Positive modifier: multiply. Negative: diminishing-returns division.
 */
function maxCombatStrScaled(baseStrength, modifierPercent) {
  const base = baseStrength * STR_SCALE;
  if (modifierPercent >= 0) {
    return Math.floor(base * (100 + modifierPercent) / 100);
  } else {
    return Math.floor(base * 10000 / (100 - modifierPercent));
  }
}

/**
 * Current combat strength = max strength adjusted for current HP.
 * CvUnit::currCombatStr: maxCombatStr * currHP / maxHP
 */
function currCombatStrScaled(maxStrScaled, currHP) {
  return Math.floor(maxStrScaled * currHP / MAX_HP);
}

/**
 * Firepower = floor((maxStr + currStr + 1) / 2)
 * A wounded unit has lower firepower, dealing less damage.
 */
function currFirepowerScaled(maxStrScaled, currStrScaled) {
  return Math.floor((maxStrScaled + currStrScaled + 1) / 2);
}

// ── Damage Calculation ─────────────────────────────────────────────────

/**
 * Damage per hit using the Civ4 source code formula:
 *   strengthFactor = floor((AFP + DFP + 1) / 2)
 *   damageToDefender = max(1, floor(COMBAT_DAMAGE * (AFP + sf) / (DFP + sf)))
 *   damageToAttacker = max(1, floor(COMBAT_DAMAGE * (DFP + sf) / (AFP + sf)))
 */
function calcCombatDamage(attackerFP, defenderFP) {
  const sf = Math.floor((attackerFP + defenderFP + 1) / 2);
  return {
    dmgToDefender: Math.max(1, Math.floor(COMBAT_DAMAGE * (attackerFP + sf) / (defenderFP + sf))),
    dmgToAttacker: Math.max(1, Math.floor(COMBAT_DAMAGE * (defenderFP + sf) / (attackerFP + sf))),
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
 * Calculate the total modifier percentage for a unit.
 *
 * All modifiers are summed additively, then applied once via
 * maxCombatStrScaled (positive = multiply, negative = diminishing division).
 *
 * Context must include: isAttacker, isAttackingCity, terrainDefenseBonus,
 * cityDefenseBonus, acrossRiver, amphibious.
 */
function getModifierPercent(unit, opponent, context) {
  let mod = 0;

  // ── Promotion bonuses ──
  if (unit.promotions) {
    for (const promo of unit.promotions) {
      // Flat strength bonus (Combat I–VI)
      if (promo.strengthPercent) mod += promo.strengthPercent;

      // City attack (attacker attacking city)
      if (context.isAttackingCity && context.isAttacker && promo.cityAttackPercent) {
        mod += promo.cityAttackPercent;
      }

      // City defense (defender in city)
      if (context.isAttackingCity && !context.isAttacker && promo.cityDefensePercent) {
        mod += promo.cityDefensePercent;
      }

      // Vs combat type bonuses from promotions
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
  const oCT = opponent.unitCombatType;
  if (unit.bonusVsMelee && oCT === 'melee') mod += unit.bonusVsMelee;
  if (unit.bonusVsMounted && oCT === 'mounted') mod += unit.bonusVsMounted;
  if (unit.bonusVsArcher && oCT === 'archery') mod += unit.bonusVsArcher;
  if (unit.bonusVsGun && oCT === 'gun') mod += unit.bonusVsGun;

  // ── City attack bonus (attacker in city assault) ──
  if (context.isAttackingCity && context.isAttacker && unit.cityAttackBonus) {
    mod += unit.cityAttackBonus;
  }

  // ── Attack bonuses vs specific unit classes (attacker only) ──
  if (context.isAttacker) {
    const oClass = unitClass(opponent);
    if (unit.attackBonusVsAxemen && oClass === 'axeman') mod += unit.attackBonusVsAxemen;
    if (unit.attackBonusVsCatapults && oClass === 'catapult') mod += unit.attackBonusVsCatapults;
    if (unit.attackBonusVsCannons && oClass === 'cannon') mod += unit.attackBonusVsCannons;
    if (unit.attackBonusVsRiflemen && oClass === 'rifleman') mod += unit.attackBonusVsRiflemen;
    if (unit.attackBonusVsFrigates && oClass === 'frigate') mod += unit.attackBonusVsFrigates;
  }

  // ── Defense bonuses vs specific unit classes (defender only) ──
  if (!context.isAttacker) {
    const oClass = unitClass(opponent);
    if (unit.defenseBonusVsGalleys && oClass === 'galley') mod += unit.defenseBonusVsGalleys;
    if (unit.defenseBonusVsChariots && oClass === 'chariot') mod += unit.defenseBonusVsChariots;
    if (unit.defenseBonusVsFrigates && oClass === 'frigate') mod += unit.defenseBonusVsFrigates;
  }

  // ── Defender-only bonuses ──
  if (!context.isAttacker) {
    // noDefensiveBonus units skip terrain, fortification, city building/culture defense
    if (!unit.noDefensiveBonus) {
      // Terrain defense (hill, forest, etc.)
      if (context.terrainDefenseBonus) mod += context.terrainDefenseBonus;

      // Fortification (+5% per turn, max +25%)
      if (unit.fortificationBonus) mod += unit.fortificationBonus;

      // City defense from buildings/culture (max of the two, passed via context)
      if (context.cityDefenseBonus) mod += context.cityDefenseBonus;
    }

    // Unit-inherent city defense bonus (e.g., Archer +50%, Warrior +25%)
    // This is a unit property, not a plot bonus — applies regardless of noDefensiveBonus
    if (context.isAttackingCity && unit.cityDefenseBonus) {
      mod += unit.cityDefenseBonus;
    }

    // River crossing (+25% defender bonus) — negated by attacker's Amphibious promotion
    if (context.acrossRiver) {
      const attackerHasAmphibious = opponent.promotions?.some(p => p.id === 'amphibious');
      if (!attackerHasAmphibious) mod += 25;
    }

    // Amphibious landing (+50% defender bonus) — negated by attacker's Amphibious promotion
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
 * Total collateral damage % (unit base + barrage promotions).
 */
function getTotalCollateralDamage(unit) {
  let cd = unit.collateralDamage || 0;
  if (unit.promotions) {
    for (const p of unit.promotions) {
      if (p.collateralDamageChange) cd += p.collateralDamageChange;
    }
  }
  return cd;
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
 * Civ4 combat flow:
 * 1. Calculate max/current strength and firepower at combat start (fixed)
 * 2. Hit probability = aCurrStr / (aCurrStr + dCurrStr) (fixed)
 * 3. Roll first strikes: guaranteed + random(0..chances) per side, apply immunity
 * 4. First strike rounds: only the side with remaining FS can deal damage;
 *    when both have FS remaining, it's a normal round (both can hit)
 * 5. Normal rounds: random roll → winner deals fixed damage to loser
 * 6. Withdrawal: checked when damage would kill attacker (pre-damage HP preserved)
 * 7. Combat limit: defender can't drop below MAX_HP*(100-combatLimit)/100
 */
export function simulateSingleCombat(attacker, defender, context) {
  const aMod = getModifierPercent(attacker, defender, { ...context, isAttacker: true });
  const dMod = getModifierPercent(defender, attacker, { ...context, isAttacker: false });

  const aMaxStr = maxCombatStrScaled(attacker.strength, aMod);
  const dMaxStr = maxCombatStrScaled(defender.strength, dMod);

  let aHP = attacker.hp;
  let dHP = defender.hp;

  // Strengths at combat start (fixed for entire combat)
  const aCurrStr = currCombatStrScaled(aMaxStr, aHP);
  const dCurrStr = currCombatStrScaled(dMaxStr, dHP);

  // Hit probability (fixed)
  const hitProb = aCurrStr / (aCurrStr + dCurrStr);

  // Firepower at combat start (fixed)
  const aFP = currFirepowerScaled(aMaxStr, aCurrStr);
  const dFP = currFirepowerScaled(dMaxStr, dCurrStr);

  // Damage per hit (fixed)
  const { dmgToDefender, dmgToAttacker } = calcCombatDamage(aFP, dFP);

  // ── First strikes ──
  // Roll: guaranteed + getSorenRandNum(chances + 1)  [uniform 0..chances]
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
  const combatLimit = attacker.combatLimit ?? 100;
  const defenderMinHP = Math.floor(MAX_HP * (100 - combatLimit) / 100);

  // ── Combat rounds ──
  const maxRounds = 200; // safety limit
  let rounds = 0;
  let withdrawn = false;

  while (aHP > 0 && dHP > 0 && rounds < maxRounds) {
    // Combat limit reached — attacker withdraws
    if (dHP <= defenderMinHP) {
      withdrawn = true;
      break;
    }

    // Determine who can deal damage this round
    let attackerCanHit, defenderCanHit;
    if (aFirstStrikes > 0 || dFirstStrikes > 0) {
      // First strike phase: only the side(s) with remaining FS can hit
      attackerCanHit = aFirstStrikes > 0;
      defenderCanHit = dFirstStrikes > 0;
      if (aFirstStrikes > 0) aFirstStrikes--;
      if (dFirstStrikes > 0) dFirstStrikes--;
    } else {
      // Normal round
      attackerCanHit = true;
      defenderCanHit = true;
    }

    if (Math.random() < hitProb) {
      // Attacker wins round
      if (attackerCanHit) {
        dHP = Math.max(defenderMinHP, dHP - dmgToDefender);
      }
    } else {
      // Defender wins round
      if (defenderCanHit) {
        // Withdrawal check: if this hit would kill the attacker
        if (aHP - dmgToAttacker <= 0 && withdrawalPct > 0) {
          if (Math.floor(Math.random() * 100) < withdrawalPct) {
            withdrawn = true;
            break; // attacker keeps pre-damage HP
          }
        }
        aHP = Math.max(0, aHP - dmgToAttacker);
      }
    }
    rounds++;
  }

  return {
    attackerHP: Math.max(0, aHP),
    defenderHP: Math.max(0, dHP),
    withdrawn,
  };
}

/**
 * Apply collateral damage from an attacker to the defender stack.
 *
 * Called after combat (win, lose, or withdraw). Uses attacker's post-combat HP.
 * Dead attackers (HP=0) deal no collateral.
 *
 * CvUnit::collateralCombat() formula:
 *   collateralStrength = baseCombatStr * totalCollateralDmg% / 100 * currHP / maxHP
 *   For each target (up to collateralDamageMaxUnits, skipping fought defender):
 *     theirStrength = target.baseCombatStr (unmodified)
 *     strengthFactor = max(1, floor((collStr + theirStr + 1) / 2))
 *     damage = floor(COLLATERAL_COMBAT_DAMAGE * (collStr + sf) / (theirStr + sf))
 *     damage *= (100 - target.collateralDamageProtection) / 100
 *     damage = clamp so target can't drop below maxHP * (100 - collateralDamageLimit) / 100
 *
 * @param {Object} attacker — attacking unit (with current hp after combat)
 * @param {Array}  defenders — defender stack (mutable; hp will be modified)
 * @param {number} foughtIdx — index of defender that was fought (skipped)
 */
export function applyCollateralDamage(attacker, defenders, foughtIdx) {
  const totalCollDmg = getTotalCollateralDamage(attacker);
  if (totalCollDmg <= 0) return;
  if (attacker.hp <= 0) return;

  const maxTargets = attacker.collateralDamageMaxUnits || 0;
  if (maxTargets <= 0) return;

  const collateralDamageLimit = attacker.collateralDamageLimit || 0;

  // Collateral strength (scaled by 100, like combat strength)
  const baseStr = attacker.strength * STR_SCALE;
  let collStr = Math.floor(baseStr * totalCollDmg / 100);
  collStr = Math.floor(collStr * attacker.hp / MAX_HP);

  let targetsHit = 0;
  for (let i = 0; i < defenders.length && targetsHit < maxTargets; i++) {
    if (i === foughtIdx) continue;
    if (defenders[i].hp <= 0) continue;

    const theirStr = defenders[i].strength * STR_SCALE;
    const sf = Math.max(1, Math.floor((collStr + theirStr + 1) / 2));

    let damage = Math.floor(COLLATERAL_COMBAT_DAMAGE * (collStr + sf) / (theirStr + sf));

    // Collateral damage protection (drill promotions)
    const protection = getCollateralDamageProtection(defenders[i]);
    if (protection > 0) {
      damage = Math.floor(damage * (100 - protection) / 100);
    }

    // Limit: target can't drop below minHP
    const minHP = Math.floor(MAX_HP * (100 - collateralDamageLimit) / 100);
    const maxDamage = defenders[i].hp - minHP;
    damage = Math.min(damage, maxDamage);
    damage = Math.max(0, damage);

    defenders[i].hp -= damage;
    targetsHit++;
  }
}
