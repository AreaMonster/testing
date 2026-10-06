// Entry point: builds the texture atlas, wires UI and starts the frame loop.
import { bindTextures } from './blocks.js';
import { LAYERS } from './textures.js';
import { UI } from './ui.js';
import { Audio } from './audio.js';
import { Game } from './game.js';

function fatal(title, detail) {
  const el = document.getElementById('fatal');
  el.innerHTML = '';
  const h = document.createElement('h2');
  h.textContent = title;
  const p = document.createElement('p');
  p.textContent = detail;
  el.append(h, p);
  el.hidden = false;
}

function boot() {
  bindTextures(LAYERS);
  const canvas = document.getElementById('game');
  const ui = new UI();
  const audio = new Audio();
  let game;
  try {
    game = new Game(canvas, ui, audio);
  } catch (e) {
    console.error(e);
    fatal('Your browser could not start the 3D view', 'Blockhaven needs WebGL 2. Try a recent version of Chrome, Edge, Firefox or Safari, and make sure hardware acceleration is turned on.');
    return;
  }
  ui.attach(game);
  game.startMenuWorld();
  ui.showMenu('main');
  window.blockhaven = game;
  let crashed = false;
  const loop = (t) => {
    if (crashed) return;
    try {
      game.frame(t);
    } catch (e) {
      crashed = true;
      console.error(e);
      try { game.saveAll(); } catch { /* ignore */ }
      fatal('Something went wrong', `The game stopped because of an error: ${e.message}. Your world was saved; reload the page to keep playing.`);
      return;
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

boot();
