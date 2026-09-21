// Thin wrapper around the two Dropbox Content API calls this app needs:
// downloading and overwriting one JSON file in the app's own folder.
import { getAccessToken } from "./auth.js";
import { CONFIG } from "./config.js";

// Returns the parsed JSON contents of the data file, or null if it
// doesn't exist yet (first run).
export async function downloadData() {
  const token = await getAccessToken();
  const res = await fetch("https://content.dropboxapi.com/2/files/download", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Dropbox-API-Arg": JSON.stringify({ path: CONFIG.DATA_FILE_PATH })
    }
  });

  if (res.status === 409) {
    // path/not_found — no file yet, this is a fresh account.
    return null;
  }
  if (!res.ok) {
    throw new Error("Dropbox download failed: " + (await res.text()));
  }
  const text = await res.text();
  return JSON.parse(text);
}

// Overwrites the data file with the given object.
export async function uploadData(dataObj) {
  const token = await getAccessToken();
  const res = await fetch("https://content.dropboxapi.com/2/files/upload", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": JSON.stringify({
        path: CONFIG.DATA_FILE_PATH,
        mode: "overwrite",
        mute: true
      })
    },
    body: JSON.stringify(dataObj, null, 2)
  });
  if (!res.ok) {
    throw new Error("Dropbox upload failed: " + (await res.text()));
  }
  return res.json();
}
