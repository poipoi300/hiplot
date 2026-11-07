import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Modules such as jQuery, d3-selection and lib/browsercompat touch `window`,
// `document` and `navigator` at import time.
GlobalRegistrator.register();
