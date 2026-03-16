# Civilization IV Combat Calculator

A web-based combat simulator for Civilization IV: Beyond the Sword. Calculate win probabilities for unit stack battles using Monte Carlo simulation.

## Features

- **Stack vs Stack combat** — set up attacker and defender unit stacks with full control over HP, promotions, and counts
- **98+ units** with accurate base stats, including unique units
- **60+ promotions** with prerequisite chains and visual icons
- **Combat modifiers** — terrain, fortification, city buildings, culture level, river crossing, amphibious attacks
- **Monte Carlo simulation** — configurable runs (up to 100k+) with Web Worker offloading for responsive UI
- **Two attack modes** — Stack (AI-optimal attacker selection) and Ordered (sequential)
- **Collateral damage, first strikes, withdrawal** — full BTS combat mechanics
- **Three combat types** — Land, City, and Sea with contextual modifier options
- **Civ IV themed UI** — parchment styling, period fonts, unit and promotion artwork

## Running

No build step required. Open `index.html` in a modern browser.

For local development with a server:

```sh
python3 -m http.server 8000
# or
npx serve .
```

## Project Structure

```
index.html              Main application UI
js/
  app.js                Alpine.js app component — UI state and event handlers
  combat.js             Combat engine — hit probability, damage, modifiers
  data.js               Game data — units, promotions, terrain bonuses
  simulation.js         Monte Carlo stack simulation logic
  simulation-worker.js  Web Worker for offloading heavy computation
  sort.js               Unit display ordering
assets/
  units/                Unit images (organized by culture)
  promotions/           Promotion icons
```

## Tech Stack

- [Alpine.js](https://alpinejs.dev/) for reactivity
- [Tailwind CSS](https://tailwindcss.com/) for styling
- [Phosphor Icons](https://phosphoricons.com/) for UI icons
- Vanilla ES6 modules, no build tooling
- Combat engine based on BTS source code
