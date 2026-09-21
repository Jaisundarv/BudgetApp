// Central place for app-wide constants. Change these if you ever move
// the app to a different URL or re-register the Dropbox app.
export const CONFIG = {
  DROPBOX_APP_KEY: "er5spvk70vdp173",
  // Must exactly match a Redirect URI registered on the Dropbox app,
  // including trailing slash.
  REDIRECT_URI: "https://jaisundarv.github.io/BudgetApp/",
  DATA_FILE_PATH: "/budget-data.json",
  SCHEMA_VERSION: 1,
  CURRENCY: "EUR",
  LOCALE: "nl-NL"
};
