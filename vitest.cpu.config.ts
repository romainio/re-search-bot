import { testConfig } from "./vitest.config.ts";

// Mesures de CPU seules, un fichier à la fois (npm run test:cpu).
export default testConfig(true);
