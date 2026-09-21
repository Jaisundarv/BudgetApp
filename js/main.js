import * as auth from "./auth.js";
import * as store from "./store.js";
import { initUI } from "./ui.js";

const authScreen = document.querySelector("#authScreen");
const appScreen = document.querySelector("#appScreen");
const errorBanner = document.querySelector("#errorBanner");
const connectBtn = document.querySelector("#connectBtn");
const signOutBtn = document.querySelector("#signOutBtn");

function showError(msg) {
  errorBanner.textContent = msg;
  errorBanner.hidden = false;
}

async function boot() {
  try {
    await auth.completeSignInIfRedirected();
  } catch (err) {
    showError(err.message);
  }

  if (!auth.isSignedIn()) {
    authScreen.hidden = false;
    appScreen.hidden = true;
    return;
  }

  authScreen.hidden = true;
  appScreen.hidden = false;

  try {
    await store.loadFromDropbox();
  } catch (err) {
    showError(err.message);
  }

  initUI();
}

connectBtn.addEventListener("click", () => auth.startSignIn());
signOutBtn.addEventListener("click", () => {
  auth.signOut();
  window.location.reload();
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}

boot();
