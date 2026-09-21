// Dropbox OAuth2 with PKCE — no client secret needed, safe for a
// static site with no backend server.
import { CONFIG } from "./config.js";

const TOKEN_KEY = "budget_dropbox_tokens";
const VERIFIER_KEY = "budget_pkce_verifier";

function base64UrlEncode(bytes) {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomVerifier(length = 64) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function sha256Challenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(digest));
}

function loadTokens() {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveTokens(tokens) {
  localStorage.setItem(TOKEN_KEY, JSON.stringify(tokens));
}

function clearTokens() {
  localStorage.removeItem(TOKEN_KEY);
}

export function isSignedIn() {
  const t = loadTokens();
  return !!(t && t.refresh_token);
}

export function signOut() {
  clearTokens();
}

// Kicks off the sign-in redirect to Dropbox.
export async function startSignIn() {
  const verifier = randomVerifier();
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  const challenge = await sha256Challenge(verifier);

  const params = new URLSearchParams({
    client_id: CONFIG.DROPBOX_APP_KEY,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    redirect_uri: CONFIG.REDIRECT_URI,
    token_access_type: "offline"
  });
  window.location.href = `https://www.dropbox.com/oauth2/authorize?${params.toString()}`;
}

// Called on page load: if the URL carries a Dropbox ?code=..., exchange
// it for tokens and clean the URL. Returns true if a fresh sign-in just
// completed.
export async function completeSignInIfRedirected() {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("code");
  if (!code) return false;

  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);
  if (!verifier) return false;

  const body = new URLSearchParams({
    code,
    grant_type: "authorization_code",
    client_id: CONFIG.DROPBOX_APP_KEY,
    redirect_uri: CONFIG.REDIRECT_URI,
    code_verifier: verifier
  });

  const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!res.ok) {
    throw new Error("Dropbox sign-in failed: " + (await res.text()));
  }
  const json = await res.json();
  saveTokens({
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: Date.now() + (json.expires_in * 1000) - 60000
  });

  // Clean the ?code= param out of the address bar.
  url.searchParams.delete("code");
  url.searchParams.delete("state");
  window.history.replaceState({}, "", url.pathname);
  return true;
}

// Returns a valid access token, refreshing it first if it's expired.
export async function getAccessToken() {
  const tokens = loadTokens();
  if (!tokens) throw new Error("Not signed in");

  if (tokens.access_token && Date.now() < tokens.expires_at) {
    return tokens.access_token;
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    client_id: CONFIG.DROPBOX_APP_KEY
  });
  const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!res.ok) {
    clearTokens();
    throw new Error("Session expired, please sign in again");
  }
  const json = await res.json();
  const updated = {
    access_token: json.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + (json.expires_in * 1000) - 60000
  };
  saveTokens(updated);
  return updated.access_token;
}
