"use strict";

const { createApp } = require("./app");

const PORT = Number(process.env.PORT) || 8080;

createApp().listen(PORT, () => {
  console.log(`JSON Contract Studio listening on http://localhost:${PORT}`);
});
